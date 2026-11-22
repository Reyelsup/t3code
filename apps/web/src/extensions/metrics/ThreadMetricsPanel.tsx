// Metrics labels are technical terms kept in English so the numbers stay scannable.
/* oxlint-disable t3code/no-untranslated-copy -- metrics labels stay technical and untranslated */
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect } from "react";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { useNowSecond } from "../../hooks/useNowSecond";
import { cn } from "../../lib/utils";
import { upsertTurnLedgerRecords } from "./localTurnLedger";
import {
  deriveThreadMetrics,
  extractCompletedLedgerRecords,
  formatCacheHitPercent,
  formatDurationCompact,
  formatSpeed,
  formatTokenCompact,
  observeTurnTimings,
} from "./threadMetrics.logic";
import type { ThreadMetricsSummary, TurnMetricsSummary, TurnTimingObservation } from "./types";

/** First-token timestamps seen while streaming, shared by every mounted metrics surface. */
export const liveTurnTimings = new Map<string, TurnTimingObservation>();

export interface ThreadMetricsPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projection: ThreadStructure | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
}

function MetricRow({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline justify-end gap-2 tabular-nums">
        {detail === undefined ? null : (
          <span className="truncate text-muted-foreground">{detail}</span>
        )}
        <span className="shrink-0 font-medium text-foreground">{value}</span>
      </span>
    </>
  );
}

function tokenDetail(metrics: ThreadMetricsSummary): string {
  const input = formatTokenCompact(metrics.inputTokens);
  const output = formatTokenCompact(metrics.outputTokens);
  const reasoning =
    metrics.reasoningTokens > 0
      ? ` (${formatTokenCompact(metrics.reasoningTokens)} reasoning)`
      : "";
  return `in ${input} / out ${output}${reasoning}`;
}

function cacheDetail(metrics: ThreadMetricsSummary): string {
  const read = formatTokenCompact(metrics.cachedInputTokens);
  const write = formatTokenCompact(metrics.cacheCreationTokens);
  return `read ${read} / write ${write}`;
}

function cacheStateValue(metrics: ThreadMetricsSummary): string | null {
  const cache = metrics.promptCache;
  if (cache.state === "unknown") return null;
  return cache.state === "expired" ? "expired" : formatDurationCompact(cache.remainingMs);
}

function TurnRow({ turn }: { readonly turn: TurnMetricsSummary }) {
  return (
    <div className="grid grid-cols-[1.75rem_1fr_2.5rem_3rem_3.5rem] items-baseline gap-x-2 tabular-nums">
      <span className="text-muted-foreground">#{turn.ordinal}</span>
      <span className="text-foreground">{formatTokenCompact(turn.totalTokens)}</span>
      <span className="text-right text-muted-foreground">
        {formatCacheHitPercent(turn.cacheHitRate)}
      </span>
      <span className="text-right text-muted-foreground">{formatDurationCompact(turn.ttftMs)}</span>
      <span className="text-right text-foreground">{formatSpeed(turn.outputTokensPerSec)}</span>
    </div>
  );
}

/** The thread's token, cache, and speed summary with a per-turn disclosure. */
export function ThreadMetricsSummaryView({
  metrics,
  className,
}: {
  readonly metrics: ThreadMetricsSummary;
  readonly className?: string | undefined;
}) {
  const cacheState = cacheStateValue(metrics);
  return (
    <div className={cn("space-y-1", className)}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
        <MetricRow
          label="Tokens"
          value={formatTokenCompact(metrics.totalTokens)}
          detail={tokenDetail(metrics)}
        />
        <MetricRow
          label="Cache"
          value={formatCacheHitPercent(metrics.cacheHitRate)}
          detail={cacheDetail(metrics)}
        />
        {cacheState === null ? null : (
          <MetricRow
            label="Prompt cache"
            value={cacheState}
            detail={metrics.promptCache.state === "warm" ? "warm" : undefined}
          />
        )}
        <MetricRow
          label="Speed"
          value={formatSpeed(metrics.latestOutputTokensPerSec)}
          detail={`avg ${formatSpeed(metrics.avgOutputTokensPerSec)}`}
        />
        <MetricRow label="TTFT" value={formatDurationCompact(metrics.latestTtftMs)} />
        <MetricRow label="Duration" value={formatDurationCompact(metrics.latestDurationMs)} />
      </div>
      {metrics.turns.length === 0 ? null : (
        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1 text-2xs text-muted-foreground hover:text-foreground data-panel-open:[&_svg]:rotate-90">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform" aria-hidden />
            <span>Per-turn breakdown</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="space-y-0.5 pt-1 text-2xs">
              <div className="grid grid-cols-[1.75rem_1fr_2.5rem_3rem_3.5rem] gap-x-2 text-muted-foreground">
                <span>#</span>
                <span>tokens</span>
                <span className="text-right">cache</span>
                <span className="text-right">ttft</span>
                <span className="text-right">t/s</span>
              </div>
              {metrics.turns.map((turn) => (
                <TurnRow key={turn.turnId} turn={turn} />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </div>
  );
}

export function ThreadMetricsPanel({
  environmentId,
  projection,
  providerInstanceId,
  driver,
}: ThreadMetricsPanelProps) {
  const nowMs = useNowSecond();
  const metrics = deriveThreadMetrics(projection, nowMs, liveTurnTimings);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the shared live timing map in step with streaming turns
  useEffect(() => {
    observeTurnTimings(projection, liveTurnTimings);
  }, [projection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- completed turns are mirrored into the local ledger
  useEffect(() => {
    upsertTurnLedgerRecords(
      extractCompletedLedgerRecords(environmentId, projection, Date.now(), liveTurnTimings).map(
        (record) => ({
          ...record,
          providerInstanceId: providerInstanceId ?? record.providerInstanceId,
          driver: driver ?? record.driver,
        }),
      ),
    );
  }, [environmentId, projection, providerInstanceId, driver]);

  if (metrics.turnCount === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-metrics-heading"
      title="Tokens and speed"
      showHeading={false}
    >
      <div className="px-2.5">
        <ThreadMetricsSummaryView metrics={metrics} />
      </div>
    </ThreadDetailsSection>
  );
}
