import type { ThreadStructure, ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";

import type {
  LocalTurnLedgerRecord,
  PromptCacheStatus,
  ThreadMetricsSummary,
  TurnMetricsSummary,
  TurnTimingObservation,
} from "./types";

/** Below this a generation window is too short for a meaningful tokens-per-second figure. */
const MIN_GENERATION_MS = 150;

const UNKNOWN_PROMPT_CACHE: PromptCacheStatus = {
  state: "unknown",
  expiresAtMs: null,
  ttlMs: null,
  remainingMs: null,
};

const toMs = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);

const toIso = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

interface ResolvedUsage {
  readonly usageStatus: TurnMetricsSummary["usageStatus"];
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

/**
 * `inputTokens` already counts cache reads and writes, and `outputTokens` already counts
 * reasoning, so the two are summed as-is.
 */
function resolveUsage(turn: OrchestrationV2ProviderTurn): ResolvedUsage {
  const settled = turn.turnTokenUsage;
  if (settled !== undefined && settled.usageStatus !== "unavailable") {
    return {
      usageStatus: settled.usageStatus,
      inputTokens: settled.inputTokens ?? 0,
      cachedInputTokens: settled.cachedInputTokens ?? 0,
      cacheCreationTokens: settled.cacheCreationTokens ?? 0,
      outputTokens: settled.outputTokens ?? 0,
      reasoningTokens: settled.reasoningTokens ?? 0,
    };
  }
  const live = turn.tokenUsage;
  if (live !== undefined) {
    return {
      usageStatus: "live",
      inputTokens: live.inputTokens ?? 0,
      cachedInputTokens: live.cachedInputTokens ?? 0,
      cacheCreationTokens: 0,
      outputTokens: live.outputTokens ?? 0,
      reasoningTokens: live.reasoningOutputTokens ?? 0,
    };
  }
  return {
    usageStatus: "unavailable",
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function isStreamItem(item: ThreadStructureTurnItem): boolean {
  return item.type === "assistant_message" || item.type === "reasoning";
}

function belongsToTurn(
  item: ThreadStructureTurnItem,
  turn: OrchestrationV2ProviderTurn,
  runId: string | null,
  startedAtMs: number | null,
  completedAtMs: number | null,
): boolean {
  if (item.providerTurnId !== null) return item.providerTurnId === turn.id;
  if (item.runId !== null && runId !== null) return item.runId === runId;
  const itemMs = toMs(item.startedAt);
  if (itemMs === null || startedAtMs === null) return false;
  return itemMs >= startedAtMs && (completedAtMs === null || itemMs <= completedAtMs);
}

interface StreamWindow {
  readonly firstMs: number | null;
  readonly lastMs: number | null;
}

function streamWindow(
  items: ReadonlyArray<ThreadStructureTurnItem>,
  turn: OrchestrationV2ProviderTurn,
  runId: string | null,
  startedAtMs: number | null,
  completedAtMs: number | null,
): StreamWindow {
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const item of items) {
    if (!isStreamItem(item)) continue;
    if (!belongsToTurn(item, turn, runId, startedAtMs, completedAtMs)) continue;
    const itemStartMs = toMs(item.startedAt);
    if (itemStartMs === null) continue;
    firstMs = firstMs === null ? itemStartMs : Math.min(firstMs, itemStartMs);
    const itemEndMs =
      toMs(item.completedAt) ?? ("updatedAt" in item ? toMs(item.updatedAt) : null) ?? itemStartMs;
    lastMs = lastMs === null ? itemEndMs : Math.max(lastMs, itemEndMs);
  }
  return { firstMs, lastMs };
}

/**
 * Keeps the caller's map in step with turns that are still streaming, so a first token seen
 * mid-stream survives the projection replacing its items.
 */
export function observeTurnTimings(
  projection: ThreadStructure | null,
  observations: Map<string, TurnTimingObservation>,
): void {
  if (projection === null) return;
  const runIdByAttempt = new Map(
    projection.attempts.map((attempt) => [attempt.id, attempt.runId] as const),
  );
  const streaming = new Set<string>();
  for (const turn of projection.providerTurns) {
    if (turn.completedAt !== null) continue;
    streaming.add(turn.id);
    const runId =
      turn.runAttemptId === null ? null : (runIdByAttempt.get(turn.runAttemptId) ?? null);
    const window = streamWindow(projection.turnItems, turn, runId, toMs(turn.startedAt), null);
    const previous = observations.get(turn.id);
    const firstStreamAtMs = previous?.firstStreamAtMs ?? window.firstMs;
    const lastStreamAtMs =
      window.lastMs === null
        ? (previous?.lastStreamAtMs ?? null)
        : Math.max(previous?.lastStreamAtMs ?? window.lastMs, window.lastMs);
    if (firstStreamAtMs === null && lastStreamAtMs === null) continue;
    observations.set(turn.id, { turnId: turn.id, firstStreamAtMs, lastStreamAtMs });
  }
  for (const turnId of observations.keys()) {
    if (!streaming.has(turnId)) observations.delete(turnId);
  }
}

function clampTtft(value: number, durationMs: number | null): number | null {
  if (value < 0) return null;
  if (durationMs !== null && value >= durationMs) return null;
  return value;
}

function generationMsOf(ttftMs: number | null, durationMs: number | null): number | null {
  if (durationMs === null) return null;
  if (ttftMs !== null && durationMs - ttftMs >= MIN_GENERATION_MS) return durationMs - ttftMs;
  return durationMs;
}

function deriveTurnSummaries(
  projection: ThreadStructure,
  nowMs: number,
  liveTimings: ReadonlyMap<string, TurnTimingObservation> | undefined,
): ReadonlyArray<TurnMetricsSummary> {
  const turns = [...projection.providerTurns].sort((left, right) => left.ordinal - right.ordinal);
  const runById = new Map(projection.runs.map((run) => [run.id, run]));
  const runIdByAttempt = new Map(
    projection.attempts.map((attempt) => [attempt.id, attempt.runId] as const),
  );
  const turnsPerRun = new Map<string, number>();
  for (const turn of turns) {
    const runId =
      turn.runAttemptId === null ? null : (runIdByAttempt.get(turn.runAttemptId) ?? null);
    if (runId !== null) turnsPerRun.set(runId, (turnsPerRun.get(runId) ?? 0) + 1);
  }

  return turns.map((turn, index) => {
    const runId =
      turn.runAttemptId === null ? null : (runIdByAttempt.get(turn.runAttemptId) ?? null);
    const run: OrchestrationV2Run | null = runId === null ? null : (runById.get(runId) ?? null);
    // A run's window covers its queueing and checkpointing, so it only times a lone turn.
    const sharesRunWindow = run !== null && runId !== null && turnsPerRun.get(runId) === 1;
    const runStart = sharesRunWindow ? toMs(run.workStartedAt ?? run.startedAt) : null;
    const runEnd = sharesRunWindow ? toMs(run.completedAt) : null;
    const turnStart = toMs(turn.startedAt);
    const turnEnd = toMs(turn.completedAt);
    const startedAtMs = runStart ?? turnStart;
    const completedAtMs = turnEnd ?? runEnd ?? (turn.completedAt === null ? nowMs : null);
    const durationMs =
      startedAtMs !== null && completedAtMs !== null && completedAtMs >= startedAtMs
        ? completedAtMs - startedAtMs
        : null;

    const observed = liveTimings?.get(turn.id)?.firstStreamAtMs ?? null;
    const firstStreamAtMs =
      observed ??
      streamWindow(projection.turnItems, turn, runId, startedAtMs, completedAtMs).firstMs;
    const ttftMs =
      startedAtMs !== null && firstStreamAtMs !== null
        ? clampTtft(firstStreamAtMs - startedAtMs, durationMs)
        : null;

    const usage = resolveUsage(turn);
    const generationMs = generationMsOf(ttftMs, durationMs);
    const outputTokensPerSec =
      usage.outputTokens > 0 && generationMs !== null && generationMs >= MIN_GENERATION_MS
        ? usage.outputTokens / (generationMs / 1000)
        : null;

    return {
      turnId: turn.id,
      ordinal: index + 1,
      status: turn.status,
      model: turn.model ?? null,
      usageStatus: usage.usageStatus,
      inputTokens: usage.inputTokens,
      uncachedInputTokens: Math.max(
        0,
        usage.inputTokens - usage.cachedInputTokens - usage.cacheCreationTokens,
      ),
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      cacheHitRate:
        usage.inputTokens > 0 ? Math.min(1, usage.cachedInputTokens / usage.inputTokens) : null,
      durationMs,
      ttftMs,
      outputTokensPerSec,
      startedAt: toIso(turn.startedAt),
      completedAt: toIso(turn.completedAt),
    };
  });
}

function derivePromptCache(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  nowMs: number,
): PromptCacheStatus {
  let latest: OrchestrationV2ProviderTurn | null = null;
  for (const turn of turns) {
    if (turn.tokenUsage === undefined) continue;
    if (latest === null || turn.ordinal >= latest.ordinal) latest = turn;
  }
  const usage = latest?.tokenUsage;
  if (usage === undefined) return UNKNOWN_PROMPT_CACHE;

  const ttlMs = usage.promptCacheTtlMs ?? null;
  const updatedAtMs = Date.parse(usage.updatedAt);
  const expiresAtMs =
    usage.promptCacheExpiresAt !== undefined
      ? Date.parse(usage.promptCacheExpiresAt)
      : ttlMs !== null && !Number.isNaN(updatedAtMs)
        ? updatedAtMs + ttlMs
        : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return { state: "unknown", expiresAtMs: null, ttlMs, remainingMs: null };
  }
  const remainingMs = expiresAtMs - nowMs;
  return remainingMs > 0
    ? { state: "warm", expiresAtMs, ttlMs, remainingMs }
    : { state: "expired", expiresAtMs, ttlMs, remainingMs: 0 };
}

export function deriveThreadMetrics(
  projection: ThreadStructure | null,
  nowMs: number,
  liveTimings?: ReadonlyMap<string, TurnTimingObservation>,
): ThreadMetricsSummary {
  const turns = projection === null ? [] : deriveTurnSummaries(projection, nowMs, liveTimings);
  const withUsage = turns.filter((turn) => turn.totalTokens > 0);
  const latest = withUsage.at(-1) ?? turns.at(-1) ?? null;
  const speeds = withUsage.flatMap((turn) =>
    turn.outputTokensPerSec === null ? [] : [turn.outputTokensPerSec],
  );

  let inputTokens = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  for (const turn of turns) {
    inputTokens += turn.inputTokens;
    uncachedInputTokens += turn.uncachedInputTokens;
    cachedInputTokens += turn.cachedInputTokens;
    cacheCreationTokens += turn.cacheCreationTokens;
    outputTokens += turn.outputTokens;
    reasoningTokens += turn.reasoningTokens;
  }

  return {
    turnCount: turns.length,
    turnsWithUsage: withUsage.length,
    inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens,
    cacheHitRate: inputTokens > 0 ? Math.min(1, cachedInputTokens / inputTokens) : null,
    avgOutputTokensPerSec:
      speeds.length === 0
        ? null
        : speeds.reduce((total, speed) => total + speed, 0) / speeds.length,
    latestOutputTokensPerSec: latest?.outputTokensPerSec ?? null,
    latestTtftMs: latest?.ttftMs ?? null,
    latestDurationMs: latest?.durationMs ?? null,
    promptCache:
      projection === null
        ? UNKNOWN_PROMPT_CACHE
        : derivePromptCache(projection.providerTurns, nowMs),
    turns,
  };
}

export function extractCompletedLedgerRecords(
  environmentId: EnvironmentId,
  projection: ThreadStructure | null,
  nowMs: number,
  liveTimings?: ReadonlyMap<string, TurnTimingObservation>,
): readonly LocalTurnLedgerRecord[] {
  if (projection === null) return [];
  const thread = projection.thread;
  const driver =
    projection.providerSessions.find(
      (session) => session.providerInstanceId === thread.providerInstanceId,
    )?.driver ?? null;
  const recordedAt = new Date(nowMs).toISOString();
  const records: LocalTurnLedgerRecord[] = [];
  for (const turn of deriveTurnSummaries(projection, nowMs, liveTimings)) {
    if (turn.completedAt === null || turn.totalTokens === 0) continue;
    records.push({
      turnId: turn.turnId,
      environmentId,
      threadId: thread.id,
      providerInstanceId: thread.providerInstanceId,
      driver,
      model: turn.model ?? thread.modelSelection.model,
      inputTokens: turn.inputTokens,
      uncachedInputTokens: turn.uncachedInputTokens,
      cachedInputTokens: turn.cachedInputTokens,
      cacheCreationTokens: turn.cacheCreationTokens,
      outputTokens: turn.outputTokens,
      reasoningTokens: turn.reasoningTokens,
      totalTokens: turn.totalTokens,
      durationMs: turn.durationMs,
      ttftMs: turn.ttftMs,
      outputTokensPerSec: turn.outputTokensPerSec,
      recordedAt,
    });
  }
  return records;
}

export function formatTokenCompact(value: number): string {
  return formatTokens(value);
}

export function formatSpeed(tokensPerSecond: number | null): string {
  if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond)) return "-";
  return `${tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} t/s`;
}

export function formatDurationCompact(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - minutes * 60);
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes - hours * 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

export function formatCacheHitPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "-";
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}
