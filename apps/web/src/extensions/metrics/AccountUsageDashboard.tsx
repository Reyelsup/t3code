// Metrics labels are technical terms kept in English so the numbers stay scannable.
/* oxlint-disable t3code/no-untranslated-copy -- account usage labels stay technical and untranslated */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ServerProvider,
  ServerSettings,
  UsageProviderKind,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useLocale, useMessages } from "gt-react";
import { useState } from "react";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { remainingPercent } from "@t3tools/shared/usageLimits";

import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";
import type { EnvironmentUsageStatus } from "~/state/usage";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { tokenTypeSegments } from "~/components/usage/usageBreakdown";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "~/components/usage/usageProviders";
import { Badge } from "~/components/ui/badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";

import {
  buildAccountUsage,
  type AccountUsage,
  type AccountUsageReport,
  type AccountUsageTotals,
} from "./accountUsage.logic";
import type { LocalTurnLedgerRecord } from "./types";

export interface AccountUsageDashboardProps {
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly window: UsageSummaryInput;
  readonly ledgerRecords: readonly LocalTurnLedgerRecord[];
}

type AccountSortMetric = "tokens" | "cost" | "cacheHit" | "speed";

const SORT_OPTIONS: readonly { readonly value: AccountSortMetric; readonly label: string }[] = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
  { value: "cacheHit", label: "Cache hit %" },
  { value: "speed", label: "Speed" },
];

function isAccountSortMetric(value: string): value is AccountSortMetric {
  return SORT_OPTIONS.some((option) => option.value === value);
}

function compareAccounts(left: AccountUsage, right: AccountUsage, metric: AccountSortMetric) {
  switch (metric) {
    case "cost":
      return right.costUsd - left.costUsd;
    case "cacheHit":
      return (right.cacheHitRate ?? -1) - (left.cacheHitRate ?? -1);
    case "speed":
      return (right.avgOutputTokensPerSec ?? -1) - (left.avgOutputTokensPerSec ?? -1);
    default:
      return right.totalTokens - left.totalTokens;
  }
}

const SOURCE_BADGE: Record<
  AccountUsage["source"],
  { readonly label: string; readonly title: string }
> = {
  "server-scan": { label: "Server", title: "Scanned from provider transcripts on the server" },
  "live-ledger": { label: "Live", title: "Captured live from turns in this client" },
  hybrid: { label: "Hybrid", title: "Server transcript scan plus live turn capture" },
};

const BAR_FALLBACK_COLOR = "color-mix(in oklab, var(--foreground) 60%, var(--background))";

function accountBarColor(account: AccountUsage): string {
  return account.providerKind === null
    ? BAR_FALLBACK_COLOR
    : (PROVIDER_PRESENTATION[account.providerKind].color ?? BAR_FALLBACK_COLOR);
}

function quotaBadge(account: AccountUsage) {
  const windows = account.usageLimits?.windows ?? [];
  if (windows.length === 0) return null;
  let lowest = windows[0]!;
  for (const window of windows) {
    if (remainingPercent(window) < remainingPercent(lowest)) lowest = window;
  }
  const remaining = remainingPercent(lowest);
  return (
    <Badge
      size="sm"
      variant={remaining <= 20 ? "warning" : "outline"}
      title={`Lowest window: ${lowest.label} (${remaining}% left)`}
    >
      {remaining}% left
    </Badge>
  );
}

function KpiTile({
  label,
  value,
  sub,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold text-foreground tabular-nums">{value}</span>
      <span className="truncate text-2xs text-muted-foreground tabular-nums">{sub}</span>
    </div>
  );
}

function KpiStrip({
  totals,
  locale,
}: {
  readonly totals: AccountUsageTotals;
  readonly locale: string;
}) {
  const speed = totals.weightedAvgSpeed;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        label="Total tokens"
        value={formatTokens(totals.totalTokens)}
        sub={`${formatTokens(totals.totalInputTokens)} in · ${formatTokens(totals.totalOutputTokens)} out`}
      />
      <KpiTile
        label="Cache hit rate"
        value={
          totals.overallCacheHitRate === null ? "–" : formatPercent(totals.overallCacheHitRate)
        }
        sub={`${formatTokens(totals.totalCachedInputTokens)} cached · ${formatUsd(totals.totalCacheSavingsUsd, locale)} saved`}
      />
      <KpiTile
        label="Est. cost"
        value={formatUsd(totals.totalCostUsd, locale)}
        sub={`${formatUsd(totals.totalCacheSavingsUsd, locale)} cache savings`}
      />
      <KpiTile
        label="Active accounts"
        value={formatCount(totals.totalAccounts)}
        sub={speed === null ? "no speed observed" : `${speed.toFixed(1)} tok/s avg`}
      />
    </div>
  );
}

function AccountTokenBar({ account }: { readonly account: AccountUsage }) {
  const m = useMessages();
  const segments = tokenTypeSegments(account).filter((segment) => segment.value > 0);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    // The row carries the exact figures; the bar's tooltips are pointer-only.
    <div aria-hidden className="flex h-1.5 gap-0.5">
      {segments.map((segment) => (
        <Tooltip key={segment.label}>
          <TooltipTrigger
            render={
              <div
                className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
                style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
              />
            }
          />
          <TooltipPopup>
            {m(segment.label)} · {formatTokens(segment.value)} ·{" "}
            {formatPercent(segment.value / total)}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function DetailEntry({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

function AccountModelsTable({
  account,
  locale,
}: {
  readonly account: AccountUsage;
  readonly locale: string;
}) {
  if (account.models.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-right text-xs text-muted-foreground">
          <th className="w-full py-1.5 pl-2 text-left font-normal">Model</th>
          <th className="py-1.5 pl-6 font-normal">Cache hit</th>
          <th className="py-1.5 pl-6 font-normal">Cost</th>
          <th className="py-1.5 pr-2 pl-6 font-normal">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {account.models.map((model) => (
          <tr key={model.model} className="border-b border-border/50 last:border-b-0">
            <td className="py-1.5 pl-2 text-left whitespace-nowrap">{model.model}</td>
            <td className="py-1.5 pl-6 text-right tabular-nums">
              {model.cacheHitRate === null ? "–" : formatPercent(model.cacheHitRate)}
            </td>
            <td className="py-1.5 pl-6 text-right tabular-nums">
              {formatUsd(model.costUsd, locale)}
            </td>
            <td className="py-1.5 pr-2 pl-6 text-right tabular-nums">
              {formatTokens(model.totalTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountDailyBars({ account }: { readonly account: AccountUsage }) {
  const max = account.daily.reduce((peak, entry) => Math.max(peak, entry.totalTokens), 0);
  if (account.daily.length === 0 || max <= 0) return null;
  const color = accountBarColor(account);
  return (
    <div className="flex max-w-md flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Daily tokens</span>
      <div aria-hidden className="flex h-8 items-end gap-0.5">
        {account.daily.map((entry) => (
          <Tooltip key={entry.day}>
            <TooltipTrigger
              render={
                <div className="flex h-full min-w-0.5 flex-1 flex-col justify-end">
                  <div
                    className="w-full rounded-xs"
                    style={{
                      height: `${(entry.totalTokens / max) * 100}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
              }
            />
            <TooltipPopup>
              {entry.day} · {formatTokens(entry.totalTokens)}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function AccountDetail({
  account,
  locale,
}: {
  readonly account: AccountUsage;
  readonly locale: string;
}) {
  return (
    <div className="flex flex-col gap-5 border-t border-border/60 bg-muted/20 px-3 py-4 sm:px-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-6">
        <DetailEntry label="Uncached input" value={formatTokens(account.uncachedInputTokens)} />
        <DetailEntry label="Cache read" value={formatTokens(account.cachedInputTokens)} />
        <DetailEntry label="Cache write" value={formatTokens(account.cacheCreationTokens)} />
        <DetailEntry label="Output" value={formatTokens(account.outputTokens)} />
        <DetailEntry label="Reasoning" value={formatTokens(account.reasoningTokens)} />
        <DetailEntry label="Cache savings" value={formatUsd(account.cacheSavingsUsd, locale)} />
      </dl>
      <AccountModelsTable account={account} locale={locale} />
      <AccountDailyBars account={account} />
    </div>
  );
}

function AccountRow({
  account,
  share,
  expanded,
  onToggle,
  locale,
}: {
  readonly account: AccountUsage;
  readonly share: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly locale: string;
}) {
  const source = SOURCE_BADGE[account.source];
  const speed = account.avgOutputTokensPerSec;
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {account.driver === null ? (
          <span
            aria-hidden
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-xs border text-4xs font-semibold text-muted-foreground"
          >
            ?
          </span>
        ) : (
          <ProviderInstanceIcon
            driverKind={account.driver}
            displayName={account.displayName}
            accentColor={account.accentColor}
            size="compact"
            iconClassName="size-4"
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-foreground">
              {account.displayName}
            </span>
            {account.email === undefined ? null : (
              <span className="truncate text-xs text-muted-foreground">{account.email}</span>
            )}
            <Badge size="sm" variant="outline" title={`${account.environmentLabel} environment`}>
              {account.environmentLabel}
            </Badge>
            <Badge size="sm" variant="outline" title={source.title}>
              {source.label}
            </Badge>
            {account.usageLimits === null ? null : quotaBadge(account)}
          </span>
          <AccountTokenBar account={account} />
        </span>
        <span className="hidden shrink-0 flex-col items-end gap-0.5 text-right md:flex">
          <span className="flex items-baseline justify-end gap-4 text-sm text-muted-foreground">
            <span className="w-12 text-xs whitespace-nowrap tabular-nums">
              {formatPercent(share)}
            </span>
            <span className="w-14 text-xs whitespace-nowrap tabular-nums">
              {account.cacheHitRate === null ? "–" : formatPercent(account.cacheHitRate)}
            </span>
            <span className="w-16 text-xs whitespace-nowrap tabular-nums">
              {formatUsd(account.costUsd, locale)}
            </span>
            <span className="w-20 text-xs whitespace-nowrap tabular-nums">
              {speed === null ? "–" : `${speed.toFixed(1)} tok/s`}
            </span>
            <span className="w-12 text-xs whitespace-nowrap tabular-nums">
              {formatCount(account.sessions)}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {account.observedTurns > 0
              ? `${formatCount(account.observedTurns)} turns tracked live`
              : `${formatCount(account.records)} records`}
          </span>
        </span>
        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
          {formatTokens(account.totalTokens)}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            account.unattributed && "hidden",
            expanded && "rotate-180",
          )}
        />
      </button>
      {account.unattributed || !expanded ? null : (
        <AccountDetail account={account} locale={locale} />
      )}
    </div>
  );
}

export function AccountUsageDashboard({
  selectedEnvironments,
  selectedEnvironmentIds,
  hiddenProviders,
  window,
  ledgerRecords,
}: AccountUsageDashboardProps) {
  const locale = useLocale();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const providersByEnvironment = new Map<EnvironmentId, readonly ServerProvider[]>();
  const settingsByEnvironment = new Map<
    EnvironmentId,
    Pick<ServerSettings, "providerInstances"> | null
  >();
  for (const [environmentId, presentation] of presentations) {
    // Environments outside the selection cannot contribute, so their configs stay out.
    if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) continue;
    providersByEnvironment.set(environmentId, presentation.serverConfig?.providers ?? []);
    settingsByEnvironment.set(environmentId, presentation.serverConfig?.settings ?? null);
  }
  const report: AccountUsageReport = buildAccountUsage({
    environments: selectedEnvironments,
    providersByEnvironment,
    settingsByEnvironment,
    ledgerRecords,
    window,
    hiddenProviders,
  });

  const [sortMetric, setSortMetric] = useState<AccountSortMetric>("tokens");
  const [driverFilter, setDriverFilter] = useState<UsageProviderKind | "all">("all");
  const [search, setSearch] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const presentKinds = PROVIDER_ORDER.filter((kind) =>
    report.accounts.some((account) => account.providerKind === kind),
  );
  const query = search.trim().toLowerCase();
  const visibleAccounts = report.accounts
    .filter((account) => driverFilter === "all" || account.providerKind === driverFilter)
    .filter((account) => {
      if (query === "") return true;
      return (
        account.displayName.toLowerCase().includes(query) ||
        account.environmentLabel.toLowerCase().includes(query) ||
        (account.email?.toLowerCase().includes(query) ?? false) ||
        account.models.some((model) => model.model.toLowerCase().includes(query))
      );
    });
  const sortedAccounts = visibleAccounts.toSorted(
    (left, right) => compareAccounts(left, right, sortMetric) || left.key.localeCompare(right.key),
  );

  if (report.accounts.length === 0) {
    return (
      <Empty size="compact" className="min-h-48">
        <EmptyHeader>
          <EmptyTitle>No account usage in this window yet</EmptyTitle>
          <EmptyDescription>
            The server scans provider transcripts for completed turns, and live turns are tracked
            here automatically as they finish.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const toggleExpanded = (key: string) => {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <KpiStrip totals={report.totals} locale={locale} />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={sortMetric}
          onValueChange={(value) => {
            if (value !== null && isAccountSortMetric(value)) setSortMetric(value);
          }}
        >
          <SelectTrigger aria-label="Sort accounts" size="compact" className="w-auto min-w-0">
            <SelectValue>
              Sort · {SORT_OPTIONS.find((option) => option.value === sortMetric)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {SORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <ToggleGroup
          aria-label="Filter accounts by provider"
          variant="segmented"
          value={[driverFilter]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "all") setDriverFilter("all");
            else if (PROVIDER_ORDER.some((kind) => kind === value)) {
              setDriverFilter(value as UsageProviderKind);
            }
          }}
        >
          <Toggle value="all">All</Toggle>
          {presentKinds.map((kind) => (
            <Toggle key={kind} value={kind}>
              {PROVIDER_PRESENTATION[kind].label}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="ms-auto w-full sm:w-56">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search accounts or models"
              size="sm"
              type="search"
              value={search}
              placeholder="Search accounts or models"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </InputGroup>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        {sortedAccounts.map((account) => (
          <AccountRow
            key={account.key}
            account={account}
            share={
              report.totals.totalTokens === 0 ? 0 : account.totalTokens / report.totals.totalTokens
            }
            expanded={expandedKeys.has(account.key)}
            onToggle={() => toggleExpanded(account.key)}
            locale={locale}
          />
        ))}
        {sortedAccounts.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            No accounts match the current filters.
          </p>
        ) : null}
      </div>
      <p className="text-2xs text-muted-foreground">
        {formatCount(report.totals.totalAccounts, locale)} accounts ·{" "}
        {formatCount(selectedEnvironments.length, locale)} environments
      </p>
    </section>
  );
}
