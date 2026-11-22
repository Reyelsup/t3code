import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export interface LocalTurnLedgerRecord {
  readonly turnId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number | null;
  readonly ttftMs: number | null;
  readonly outputTokensPerSec: number | null;
  readonly recordedAt: string;
}

export interface TurnTimingObservation {
  readonly turnId: string;
  readonly firstStreamAtMs: number | null;
  readonly lastStreamAtMs: number | null;
}

export interface TurnMetricsSummary {
  readonly turnId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly model: string | null;
  readonly usageStatus: "complete" | "partial" | "live" | "unavailable";
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number | null;
  readonly durationMs: number | null;
  readonly ttftMs: number | null;
  readonly outputTokensPerSec: number | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface PromptCacheStatus {
  readonly state: "warm" | "expired" | "unknown";
  readonly expiresAtMs: number | null;
  readonly ttlMs: number | null;
  readonly remainingMs: number | null;
}

export interface ThreadMetricsSummary {
  readonly turnCount: number;
  readonly turnsWithUsage: number;
  readonly inputTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number | null;
  readonly avgOutputTokensPerSec: number | null;
  readonly latestOutputTokensPerSec: number | null;
  readonly latestTtftMs: number | null;
  readonly latestDurationMs: number | null;
  readonly promptCache: PromptCacheStatus;
  readonly turns: ReadonlyArray<TurnMetricsSummary>;
}
