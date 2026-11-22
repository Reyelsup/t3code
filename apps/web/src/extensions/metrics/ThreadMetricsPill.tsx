// Metrics labels are technical terms kept in English so the numbers stay scannable.
/* oxlint-disable t3code/no-untranslated-copy -- metrics labels stay technical and untranslated */
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect } from "react";

import { ComposerControl, type ComposerControlSize } from "../../components/chat/ComposerControl";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { upsertTurnLedgerRecords } from "./localTurnLedger";
import {
  deriveThreadMetrics,
  extractCompletedLedgerRecords,
  formatSpeed,
  formatTokenCompact,
  observeTurnTimings,
} from "./threadMetrics.logic";
import { liveTurnTimings, ThreadMetricsSummaryView } from "./ThreadMetricsPanel";

export interface ThreadMetricsPillProps {
  readonly environmentId?: EnvironmentId | null;
  readonly projection: ThreadStructure | null;
  readonly providerInstanceId?: ProviderInstanceId | null;
  readonly driver?: ProviderDriverKind | null;
  readonly contextWindow?: ContextWindowSnapshot | null;
  readonly size?: ComposerControlSize;
}

const RING_RADIUS = 5.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringStrokeColor(usedPercent: number | null): string {
  if (usedPercent === null) return "currentColor";
  if (usedPercent >= 90) return "var(--destructive)";
  if (usedPercent >= 80) return "var(--warning)";
  return "currentColor";
}

function ContextProgressRing({
  usedPercent,
  warm,
}: {
  readonly usedPercent: number | null;
  readonly warm: boolean;
}) {
  const clamped = usedPercent === null ? 0 : Math.max(0, Math.min(100, usedPercent));
  const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
  return (
    <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
      <svg className="size-3.5" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.22"
          strokeWidth="1.75"
        />
        {usedPercent !== null ? (
          <circle
            cx="8"
            cy="8"
            r={RING_RADIUS}
            fill="none"
            stroke={ringStrokeColor(clamped)}
            strokeWidth="1.75"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
        ) : null}
      </svg>
      {warm ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-success ring-1 ring-card"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

/** Borderless Cursor-style context ring and speed trigger; clicking opens the full metrics popover. */
export function ThreadMetricsPill({
  environmentId = null,
  projection,
  providerInstanceId = null,
  driver = null,
  contextWindow = null,
  size = "xs",
}: ThreadMetricsPillProps) {
  const nowMinute = useNowMinute();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks streaming turn timestamps even when the details panel is closed
  useEffect(() => {
    observeTurnTimings(projection, liveTurnTimings);
  }, [projection]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors completed turns into the local account ledger
  useEffect(() => {
    if (environmentId === null) return;
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

  const metrics = deriveThreadMetrics(projection, Date.parse(`${nowMinute}:00Z`), liveTurnTimings);
  const maxTokens =
    contextWindow?.maxTokens != null && contextWindow.maxTokens > 0
      ? contextWindow.maxTokens
      : null;
  const usedPercent =
    maxTokens !== null && contextWindow?.usedPercentage != null
      ? Math.round(Math.max(0, Math.min(100, contextWindow.usedPercentage)))
      : null;

  if (metrics.turnsWithUsage === 0 && contextWindow === null) return null;

  const warm = metrics.promptCache.state === "warm";
  const speed = metrics.latestOutputTokensPerSec;
  const primaryLabel =
    usedPercent !== null
      ? `${usedPercent}%`
      : contextWindow !== null
        ? formatContextWindowTokens(contextWindow.usedTokens)
        : formatTokenCompact(metrics.totalTokens);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label="Thread context, cache, and speed metrics"
            title="Context, cache, and generation speed"
          />
        }
      >
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <ContextProgressRing usedPercent={usedPercent} warm={warm} />
          <span data-composer-control-label>{primaryLabel}</span>
          {speed !== null ? (
            <>
              <span className="text-muted-foreground/50" aria-hidden="true">
                ·
              </span>
              <span className="text-muted-foreground" data-composer-control-label>
                {formatSpeed(speed)}
              </span>
            </>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup width="md" align="end" side="top" padding="compact">
        <div className="space-y-2">
          {contextWindow !== null ? (
            <div className="space-y-1 border-b border-border/60 pb-2 text-xs">
              <div className="flex items-baseline justify-between gap-3 tabular-nums">
                <span className="text-muted-foreground">Context</span>
                <span className="font-medium text-foreground">
                  {maxTokens !== null
                    ? `${formatContextWindowTokens(contextWindow.usedTokens)} / ${formatContextWindowTokens(maxTokens)}${usedPercent !== null ? ` (${usedPercent}%)` : ""}`
                    : formatContextWindowTokens(contextWindow.usedTokens)}
                </span>
              </div>
              {usedPercent !== null ? (
                <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${usedPercent}%`,
                      backgroundColor: ringStrokeColor(usedPercent),
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {metrics.turnCount > 0 ? <ThreadMetricsSummaryView metrics={metrics} /> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
