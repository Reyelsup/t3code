/* oxlint-disable t3code/no-untranslated-copy -- Antigravity quota command center UI uses direct untranslated text */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  type AntigravityAccount,
  classifyQuotaWindow,
  extractAntigravityAccounts,
  isNasKeepaliveTask,
  type QuotaFamilySlots,
  type QuotaWindowState,
} from "./antigravityQuota.logic";
import {
  type AntigravityGuardConfig,
  useAntigravityActivationLog,
  useAntigravityGuardConfig,
} from "./antigravityConfig";
import {
  activateAntigravityAccountFamily,
  removeNasKeepaliveSchedule,
  syncNasKeepaliveSchedule,
} from "./antigravityActivator";

export interface AntigravityAccountsPanelProps {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
}

const KNOWN_FAMILIES = ["gemini", "gemini-argon", "gemini-carbon", "3p"] as const;
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");

function formatCountdown(resetsAt: string | undefined, nowMs: number): string {
  if (!resetsAt) return "";
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return "";
  const diffMs = resetMs - nowMs;
  if (diffMs <= 0) return "reset ready";
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  const timeStr = new Date(resetMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (hours > 0) {
    return `${hours}h ${minutes}m left · resets ${timeStr}`;
  }
  return `${minutes}m left · resets ${timeStr}`;
}

function StatusBadge({
  state,
  resetsAt,
  nowMs,
}: {
  readonly state: QuotaWindowState;
  readonly resetsAt?: string | undefined;
  readonly nowMs: number;
}) {
  switch (state) {
    case "unactivated":
      return <Badge variant="warning">Unactivated</Badge>;
    case "active":
      return (
        <span className="flex items-center gap-1.5">
          <Badge variant="success">Active</Badge>
          <span className="text-xs text-muted-foreground">{formatCountdown(resetsAt, nowMs)}</span>
        </span>
      );
    case "reset_ready":
      return <Badge variant="info">Reset Ready</Badge>;
    case "exhausted":
      return <Badge variant="destructive">Exhausted</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

function WindowRow({
  label,
  window,
  nowMs,
}: {
  readonly label: string;
  readonly window?: ServerProviderUsageWindow | undefined;
  readonly nowMs: number;
}) {
  const state = classifyQuotaWindow(window, nowMs);
  const usedPercent = window?.usedPercent ?? 0;
  const remaining = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));

  let barBg = "bg-primary";
  if (state === "unactivated") barBg = "bg-warning";
  else if (state === "exhausted") barBg = "bg-destructive";
  else if (state === "reset_ready") barBg = "bg-info";

  return (
    <div className="flex flex-col gap-1 rounded border border-border/50 bg-background/50 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{label}</span>
        <StatusBadge state={state} resetsAt={window?.resetsAt} nowMs={nowMs} />
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full transition-all duration-300 ${barBg}`}
            style={{ width: `${state === "unactivated" ? 0 : remaining}%` }}
          />
        </div>
        <span className="font-mono text-3xs text-muted-foreground">
          {state === "unactivated" ? "0% (untouched)" : `${remaining}% left`}
        </span>
      </div>
    </div>
  );
}

function FamilySection({
  family,
  account,
  nowMs,
  onActivate,
  isActivating,
}: {
  readonly family: QuotaFamilySlots;
  readonly account: AntigravityAccount;
  readonly nowMs: number;
  readonly onActivate: (familyKey: string) => void;
  readonly isActivating: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {family.label}
        </span>
        {!account.isHubOnly && account.status === "ready" && (
          <Button
            size="xs"
            variant="outline"
            disabled={isActivating}
            onClick={() => onActivate(family.familyKey)}
          >
            {isActivating ? (
              <span className="flex items-center gap-1">
                <Spinner size="xs" />
                <span>Warming up...</span>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <ZapIcon className="size-3" />
                <span>Activate</span>
              </span>
            )}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <WindowRow label="5-Hour Window" window={family.fiveHour} nowMs={nowMs} />
        <WindowRow label="Weekly Window" window={family.weekly} nowMs={nowMs} />
      </div>
    </div>
  );
}

function AccountCard({
  account,
  nowMs,
  config,
  onUpdateConfig,
}: {
  readonly account: AntigravityAccount;
  readonly nowMs: number;
  readonly config: AntigravityGuardConfig;
  readonly onUpdateConfig: (
    updater: (current: AntigravityGuardConfig) => AntigravityGuardConfig,
  ) => void;
}) {
  const [activatingFamily, setActivatingFamily] = useState<string | null>(null);
  const [syncingKeepalive, setSyncingKeepalive] = useState(false);

  const accountKey = account.instanceId
    ? `${account.environmentId}:${account.instanceId}`
    : account.id;

  const accountConfig = config.accounts[accountKey] ?? {
    autoActivate: false,
    guardedFamilies: ["gemini"],
  };

  const tasksQuery = useAtomValue(
    serverEnvironment.scheduledTasksLive({
      environmentId: account.environmentId,
      input: {},
    }),
  );

  const liveTasks = AsyncResult.getOrElse(tasksQuery, () => null)?.tasks ?? [];
  const keepaliveTask = account.instanceId
    ? liveTasks.find(
        (t) => isNasKeepaliveTask(t) && t.modelSelection.instanceId === account.instanceId,
      )
    : undefined;

  const handleActivateFamily = async (familyKey: string) => {
    if (!account.instanceId || activatingFamily !== null) return;
    setActivatingFamily(familyKey);
    try {
      const overrideModel = accountConfig.preferredModelOverride?.[familyKey];
      const model = overrideModel || account.models[0]?.id || "gemini-3.8-flash";
      await activateAntigravityAccountFamily({
        environmentId: account.environmentId,
        instanceId: account.instanceId,
        accountLabel: account.displayName,
        familyKey,
        model,
        trigger: "manual",
        warmupPrompt: config.warmupPrompt,
        autoArchiveWarmupThread: config.autoArchiveWarmupThread,
      });
    } finally {
      setActivatingFamily(null);
    }
  };

  const handleToggleAutoActivate = (checked: boolean) => {
    onUpdateConfig((curr) => ({
      ...curr,
      accounts: {
        ...curr.accounts,
        [accountKey]: {
          ...accountConfig,
          autoActivate: checked,
        },
      },
    }));
  };

  const handleToggleGuardedFamily = (familyKey: string, checked: boolean) => {
    const currentFamilies = new Set(accountConfig.guardedFamilies ?? ["gemini"]);
    if (checked) currentFamilies.add(familyKey);
    else currentFamilies.delete(familyKey);
    onUpdateConfig((curr) => ({
      ...curr,
      accounts: {
        ...curr.accounts,
        [accountKey]: {
          ...accountConfig,
          guardedFamilies: [...currentFamilies],
        },
      },
    }));
  };

  const handleSyncNasKeepalive = async () => {
    if (!account.instanceId || syncingKeepalive) return;
    setSyncingKeepalive(true);
    try {
      const model =
        accountConfig.preferredModelOverride?.["gemini"] ||
        account.models[0]?.id ||
        "gemini-3.8-flash";
      await syncNasKeepaliveSchedule({
        environmentId: account.environmentId,
        instanceId: account.instanceId,
        model,
        accountLabel: account.displayName,
        familyKey: "gemini",
        existingTaskId: keepaliveTask?.id,
      });
    } finally {
      setSyncingKeepalive(false);
    }
  };

  const handleToggleKeepalive = async (enabled: boolean) => {
    if (!keepaliveTask) return;
    await runAtomCommand(appAtomRegistry, serverEnvironment.setScheduledTaskEnabled, {
      environmentId: account.environmentId,
      input: { id: keepaliveTask.id, enabled },
    });
  };

  const handleDeleteKeepalive = async () => {
    if (!keepaliveTask) return;
    await removeNasKeepaliveSchedule({
      environmentId: account.environmentId,
      taskId: keepaliveTask.id,
    });
  };

  const familiesList = Array.from(account.families.values());

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2.5">
          <ProviderInstanceIcon
            driverKind={ANTIGRAVITY_DRIVER}
            displayName={account.displayName}
            className="size-6"
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">{account.displayName}</span>
              {account.instanceId && (
                <Badge variant="outline" size="sm">
                  {account.instanceId}
                </Badge>
              )}
            </div>
            {(account.email || account.plan) && (
              <span className="text-xs text-muted-foreground">
                {account.email} {account.plan ? `· ${account.plan}` : ""}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">
            {account.environmentLabel}
          </Badge>
          {account.isHubOnly ? (
            <Badge variant="secondary" size="sm">
              Hub (Read-Only)
            </Badge>
          ) : account.status === "ready" ? (
            <Badge variant="success" size="sm">
              Ready
            </Badge>
          ) : account.status === "error" ? (
            <Badge variant="destructive" size="sm">
              Error
            </Badge>
          ) : (
            <Badge variant="warning" size="sm">
              {account.status}
            </Badge>
          )}
        </div>
      </div>

      {account.unavailableMessage && (
        <div className="rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          {account.unavailableMessage}
        </div>
      )}

      {familiesList.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {familiesList.map((family) => (
            <FamilySection
              key={family.familyKey}
              family={family}
              account={account}
              nowMs={nowMs}
              onActivate={handleActivateFamily}
              isActivating={activatingFamily === family.familyKey}
            />
          ))}
        </div>
      ) : (
        <div className="py-2 text-center text-xs text-muted-foreground">
          No quota windows reported yet. Click Refresh to probe provider limits.
        </div>
      )}

      {!account.isHubOnly && (
        <div className="mt-2 flex flex-col gap-3 rounded-md border border-border/40 bg-muted/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Switch
                checked={accountConfig.autoActivate}
                onCheckedChange={handleToggleAutoActivate}
                size="sm"
              />
              <span className="text-xs font-medium text-foreground">
                Auto-Activate (Mac online)
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Guard families:</span>
              {KNOWN_FAMILIES.map((fam) => {
                const isGuarded = (accountConfig.guardedFamilies ?? ["gemini"]).includes(fam);
                return (
                  <label
                    key={fam}
                    className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer"
                  >
                    <Checkbox
                      checked={isGuarded}
                      onCheckedChange={(checked) =>
                        handleToggleGuardedFamily(fam, Boolean(checked))
                      }
                    />
                    <span>
                      {fam === "3p"
                        ? "Claude & GPT"
                        : fam.replace("gemini-", "").replace("gemini", "Gemini")}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/30 pt-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">NAS Rolling Keepalive:</span>
              {keepaliveTask ? (
                <div className="flex items-center gap-2">
                  <Badge variant={keepaliveTask.enabled ? "success" : "warning"} size="sm">
                    {keepaliveTask.enabled ? "Synced to NAS · runs every 5h 5m" : "Paused on NAS"}
                  </Badge>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => handleToggleKeepalive(!keepaliveTask.enabled)}
                  >
                    {keepaliveTask.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="xs" variant="outline" onClick={handleDeleteKeepalive}>
                    Remove
                  </Button>
                </div>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={syncingKeepalive}
                  onClick={handleSyncNasKeepalive}
                >
                  {syncingKeepalive ? (
                    <span className="flex items-center gap-1">
                      <Spinner size="xs" />
                      <span>Syncing...</span>
                    </span>
                  ) : (
                    "Sync to NAS Keepalive"
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AntigravityAccountsPanel({
  selectedEnvironmentIds,
  now,
}: AntigravityAccountsPanelProps) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const [config, updateConfig] = useAntigravityGuardConfig();
  const [logs, clearLogs] = useAntigravityActivationLog();

  const [refreshing, setRefreshing] = useState(false);
  const [activatingAll, setActivatingAll] = useState(false);
  const [activationProgress, setActivationProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const allAccounts = extractAntigravityAccounts(presentations, now);
  const accounts = selectedEnvironmentIds
    ? allAccounts.filter((a) => selectedEnvironmentIds.has(a.environmentId))
    : allAccounts;

  const totalCount = accounts.length;
  let activeCount = 0;
  let unactivatedCount = 0;

  for (const account of accounts) {
    for (const family of account.families.values()) {
      const s5 = classifyQuotaWindow(family.fiveHour, now);
      const sw = classifyQuotaWindow(family.weekly, now);
      if (s5 === "active" || sw === "active") activeCount++;
      if (s5 === "unactivated" || sw === "unactivated") unactivatedCount++;
    }
  }

  const handleRefreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const environments = new Set(accounts.map((a) => a.environmentId));
      for (const envId of environments) {
        await runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, {
          environmentId: envId,
          input: {},
        });
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleActivateAllUnactivated = async () => {
    if (activatingAll) return;
    setActivatingAll(true);
    try {
      const targets: Array<{ account: AntigravityAccount; familyKey: string; model: string }> = [];
      for (const account of accounts) {
        if (account.isHubOnly || account.status !== "ready" || !account.instanceId) continue;
        for (const family of account.families.values()) {
          const s5 = classifyQuotaWindow(family.fiveHour, now);
          const sw = classifyQuotaWindow(family.weekly, now);
          if (
            s5 === "unactivated" ||
            s5 === "reset_ready" ||
            sw === "unactivated" ||
            sw === "reset_ready"
          ) {
            const model = account.models[0]?.id || "gemini-3.8-flash";
            targets.push({ account, familyKey: family.familyKey, model });
          }
        }
      }

      setActivationProgress({ current: 0, total: targets.length });
      for (let i = 0; i < targets.length; i++) {
        const item = targets[i]!;
        setActivationProgress({ current: i + 1, total: targets.length });
        await activateAntigravityAccountFamily({
          environmentId: item.account.environmentId,
          instanceId: item.account.instanceId!,
          accountLabel: item.account.displayName,
          familyKey: item.familyKey,
          model: item.model,
          trigger: "manual",
          warmupPrompt: config.warmupPrompt,
          autoArchiveWarmupThread: config.autoArchiveWarmupThread,
        });
      }
    } finally {
      setActivatingAll(false);
      setActivationProgress(null);
    }
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-xs">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-primary" />
            <span className="font-semibold text-foreground">
              Antigravity Multi-Account Command Center
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            {totalCount} accounts · {activeCount} active windows · {unactivatedCount} unactivated
            windows
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-1.5">
            <Switch
              checked={config.globalAutoActivate}
              onCheckedChange={(checked) =>
                updateConfig((curr) => ({ ...curr, globalAutoActivate: checked }))
              }
              size="sm"
            />
            <span className="text-xs font-medium text-foreground">Global Auto-Guard</span>
          </div>

          <Button size="sm" variant="outline" disabled={refreshing} onClick={handleRefreshAll}>
            <RefreshCwIcon className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
            <span>Refresh Quotas</span>
          </Button>

          <Button
            size="sm"
            variant="default"
            disabled={activatingAll || unactivatedCount === 0}
            onClick={handleActivateAllUnactivated}
          >
            {activatingAll ? (
              <span className="flex items-center gap-1.5">
                <Spinner size="xs" />
                <span>
                  Activating{" "}
                  {activationProgress
                    ? `(${activationProgress.current}/${activationProgress.total})`
                    : "..."}
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <ZapIcon className="size-3.5" />
                <span>Activate All Unactivated ({unactivatedCount})</span>
              </span>
            )}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            nowMs={now}
            config={config}
            onUpdateConfig={updateConfig}
          />
        ))}

        {accounts.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No Antigravity accounts detected on the selected environments.
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <Collapsible open={logOpen} onOpenChange={setLogOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between p-3.5 text-xs font-semibold text-foreground hover:bg-muted/30">
            <div className="flex items-center gap-2">
              {logOpen ? (
                <ChevronDownIcon className="size-4" />
              ) : (
                <ChevronRightIcon className="size-4" />
              )}
              <span>Activation Log ({logs.length} events)</span>
            </div>
            {logs.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  clearLogs();
                }}
              >
                Clear Log
              </Button>
            )}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-t border-border/40 p-3">
              {logs.length > 0 ? (
                <div className="flex flex-col gap-1.5 overflow-x-auto text-xs">
                  <div className="grid grid-cols-6 gap-2 border-b border-border/40 pb-1 text-3xs font-semibold text-muted-foreground uppercase tracking-wider">
                    <span>Time</span>
                    <span>Account</span>
                    <span>Family</span>
                    <span>Model</span>
                    <span>Trigger</span>
                    <span>Outcome</span>
                  </div>
                  {logs.map((entry) => (
                    <div
                      key={entry.id}
                      className="grid grid-cols-6 items-center gap-2 py-1 font-mono text-3xs"
                    >
                      <span className="text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="truncate text-foreground">{entry.accountLabel}</span>
                      <span className="text-foreground">{entry.familyKey}</span>
                      <span className="truncate text-muted-foreground">{entry.model}</span>
                      <span>
                        <Badge variant="outline" size="sm">
                          {entry.trigger}
                        </Badge>
                      </span>
                      <span className="flex items-center gap-1">
                        <Badge
                          variant={entry.outcome === "success" ? "success" : "destructive"}
                          size="sm"
                        >
                          {entry.outcome}
                        </Badge>
                        {entry.durationMs && (
                          <span className="text-3xs text-muted-foreground">
                            ({(entry.durationMs / 1000).toFixed(1)}s)
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  No activation events recorded yet.
                </div>
              )}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
}
