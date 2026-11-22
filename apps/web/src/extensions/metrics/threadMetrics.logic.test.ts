import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import {
  deriveThreadMetrics,
  extractCompletedLedgerRecords,
  formatCacheHitPercent,
  formatDurationCompact,
  formatSpeed,
  formatTokenCompact,
} from "./threadMetrics.logic";
import type { TurnTimingObservation } from "./types";

const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const at = (offsetMs: number) => DateTime.makeUnsafe(new Date(T0 + offsetMs).toISOString());
const environmentId = EnvironmentId.make("environment-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread");

interface TurnSpec {
  readonly id: string;
  readonly ordinal: number;
  readonly startMs: number;
  readonly endMs: number | null;
  readonly status?: OrchestrationV2ProviderTurn["status"];
  readonly tokenUsage?: OrchestrationV2ProviderTurn["tokenUsage"];
  readonly turnTokenUsage?: OrchestrationV2ProviderTurn["turnTokenUsage"];
  readonly model?: string;
  readonly runStartMs?: number;
  readonly runEndMs?: number | null;
}

function buildProjection(
  specs: ReadonlyArray<TurnSpec>,
  items: ReadonlyArray<OrchestrationV2TurnItem> = [],
  sessions: ReadonlyArray<OrchestrationV2ProviderSession> = [],
): OrchestrationV2ThreadProjection {
  const runs: OrchestrationV2Run[] = [];
  const attempts: OrchestrationV2RunAttempt[] = [];
  const providerTurns: OrchestrationV2ProviderTurn[] = [];
  for (const spec of specs) {
    const runId = RunId.make(`run-${spec.id}`);
    const attemptId = RunAttemptId.make(`attempt-${spec.id}`);
    const nodeId = NodeId.make(`node-${spec.id}`);
    const completedAt = spec.endMs === null ? null : at(spec.endMs);
    runs.push({
      id: runId,
      threadId: ThreadId.make("thread-test"),
      ordinal: spec.ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "claude-sonnet-4-5" },
      providerThreadId,
      userMessageId: MessageId.make(`message-${spec.id}`),
      rootNodeId: nodeId,
      activeAttemptId: attemptId,
      status: spec.endMs === null ? "running" : "completed",
      requestedAt: at(spec.startMs),
      startedAt: at(spec.startMs),
      completedAt,
      checkpointId: null,
      contextHandoffId: null,
      workStartedAt: at(spec.runStartMs ?? spec.startMs),
    });
    attempts.push({
      id: attemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: nodeId,
      providerInstanceId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make(spec.id),
      reason: "initial",
      status: spec.endMs === null ? "running" : "completed",
      startedAt: at(spec.startMs),
      completedAt,
    });
    providerTurns.push({
      id: ProviderTurnId.make(spec.id),
      providerThreadId,
      nodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: spec.ordinal,
      status: spec.status ?? (spec.endMs === null ? "running" : "completed"),
      startedAt: at(spec.startMs),
      completedAt,
      ...(spec.tokenUsage === undefined ? {} : { tokenUsage: spec.tokenUsage }),
      ...(spec.turnTokenUsage === undefined ? {} : { turnTokenUsage: spec.turnTokenUsage }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
    });
  }
  return {
    ...makeThreadProjectionFixture(),
    runs,
    attempts,
    providerTurns,
    turnItems: items,
    providerSessions: sessions,
  };
}

function streamItem(
  id: string,
  turnId: string,
  startMs: number,
  type: "assistant_message" | "reasoning" = "assistant_message",
): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-test"),
    runId: RunId.make(`run-${turnId}`),
    nodeId: null,
    providerThreadId,
    providerTurnId: ProviderTurnId.make(turnId),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at(startMs),
    completedAt: at(startMs + 100),
    updatedAt: at(startMs + 100),
  };
  return type === "reasoning"
    ? { ...base, type: "reasoning", text: "thinking", streaming: false }
    : {
        ...base,
        type: "assistant_message",
        messageId: MessageId.make(`message-${id}`),
        text: "answer",
        streaming: false,
      };
}

const completeUsage = {
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  inputTokens: 12_000,
  cachedInputTokens: 9_000,
  cacheCreationTokens: 1_000,
  outputTokens: 800,
  reasoningTokens: 300,
  hasSubagents: false,
};

describe("deriveThreadMetrics", () => {
  it("reads a complete turn without double counting cache or reasoning tokens", () => {
    const projection = buildProjection(
      [
        {
          id: "turn-1",
          ordinal: 1,
          startMs: 0,
          endMs: 10_000,
          turnTokenUsage: completeUsage,
          model: "claude-sonnet-4-5",
        },
      ],
      [streamItem("item-1", "turn-1", 800)],
    );

    const metrics = deriveThreadMetrics(projection, T0 + 20_000);
    const turn = metrics.turns[0];

    expect(turn?.usageStatus).toBe("complete");
    expect(turn?.inputTokens).toBe(12_000);
    expect(turn?.uncachedInputTokens).toBe(2_000);
    expect(turn?.cachedInputTokens).toBe(9_000);
    expect(turn?.cacheCreationTokens).toBe(1_000);
    expect(turn?.outputTokens).toBe(800);
    expect(turn?.reasoningTokens).toBe(300);
    expect(turn?.totalTokens).toBe(12_800);
    expect(turn?.cacheHitRate).toBe(0.75);
    expect(turn?.durationMs).toBe(10_000);
    expect(turn?.ttftMs).toBe(800);
    expect(turn?.outputTokensPerSec).toBeCloseTo(800 / 9.2, 5);
    expect(metrics.totalTokens).toBe(12_800);
    expect(metrics.turnsWithUsage).toBe(1);
  });

  it("falls back to live counters while a turn streams", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 0,
        endMs: null,
        tokenUsage: {
          usedTokens: 5_000,
          inputTokens: 4_000,
          cachedInputTokens: 3_000,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          updatedAt: new Date(T0 + 4_000).toISOString(),
        },
      },
    ]);

    const turn = deriveThreadMetrics(projection, T0 + 5_000).turns[0];

    expect(turn?.usageStatus).toBe("live");
    expect(turn?.totalTokens).toBe(4_200);
    expect(turn?.reasoningTokens).toBe(50);
    expect(turn?.cacheHitRate).toBe(0.75);
    expect(turn?.durationMs).toBe(5_000);
    expect(turn?.ttftMs).toBeNull();
    expect(turn?.outputTokensPerSec).toBeCloseTo(40, 5);
  });

  it("keeps partial and unavailable turns visible without inventing tokens", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 0,
        endMs: 2_000,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "partial",
          inputTokens: 1_000,
          hasSubagents: false,
        },
      },
      {
        id: "turn-2",
        ordinal: 2,
        startMs: 3_000,
        endMs: 5_000,
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "unavailable",
          hasSubagents: false,
        },
      },
    ]);

    const metrics = deriveThreadMetrics(projection, T0 + 10_000);

    expect(metrics.turns[0]?.usageStatus).toBe("partial");
    expect(metrics.turns[0]?.totalTokens).toBe(1_000);
    expect(metrics.turns[0]?.cacheHitRate).toBe(0);
    expect(metrics.turns[1]?.usageStatus).toBe("unavailable");
    expect(metrics.turns[1]?.totalTokens).toBe(0);
    expect(metrics.turns[1]?.cacheHitRate).toBeNull();
    expect(metrics.turnsWithUsage).toBe(1);
    expect(metrics.turnCount).toBe(2);
  });

  it("aggregates several turns and reports the latest speed", () => {
    const projection = buildProjection(
      [
        {
          id: "turn-1",
          ordinal: 1,
          startMs: 0,
          endMs: 2_000,
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 1_000,
            outputTokens: 100,
            hasSubagents: false,
          },
        },
        {
          id: "turn-2",
          ordinal: 2,
          startMs: 10_000,
          endMs: 14_000,
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 2_000,
            outputTokens: 300,
            hasSubagents: false,
          },
        },
      ],
      [streamItem("item-1", "turn-1", 500), streamItem("item-2", "turn-2", 11_000)],
    );

    const metrics = deriveThreadMetrics(projection, T0 + 20_000);

    expect(metrics.turnCount).toBe(2);
    expect(metrics.inputTokens).toBe(3_000);
    expect(metrics.outputTokens).toBe(400);
    expect(metrics.totalTokens).toBe(3_400);
    expect(metrics.turns[0]?.outputTokensPerSec).toBeCloseTo(100 / 1.5, 5);
    expect(metrics.turns[1]?.outputTokensPerSec).toBeCloseTo(100, 5);
    expect(metrics.avgOutputTokensPerSec).toBeCloseTo((100 / 1.5 + 100) / 2, 5);
    expect(metrics.latestOutputTokensPerSec).toBeCloseTo(100, 5);
    expect(metrics.latestTtftMs).toBe(1_000);
    expect(metrics.latestDurationMs).toBe(4_000);
  });

  it("prefers a live first-stream observation over the persisted item", () => {
    const projection = buildProjection(
      [
        {
          id: "turn-1",
          ordinal: 1,
          startMs: 0,
          endMs: 10_000,
          turnTokenUsage: completeUsage,
        },
      ],
      [streamItem("item-1", "turn-1", 2_000)],
    );
    const liveTimings = new Map<string, TurnTimingObservation>([
      ["turn-1", { turnId: "turn-1", firstStreamAtMs: T0 + 300, lastStreamAtMs: T0 + 9_000 }],
    ]);

    const turn = deriveThreadMetrics(projection, T0 + 20_000, liveTimings).turns[0];

    expect(turn?.ttftMs).toBe(300);
    expect(turn?.outputTokensPerSec).toBeCloseTo(800 / 9.7, 5);
  });

  it("times a lone turn from its run's work start", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 1_000,
        endMs: 5_000,
        runStartMs: 0,
        turnTokenUsage: completeUsage,
      },
    ]);

    const turn = deriveThreadMetrics(projection, T0 + 20_000).turns[0];

    expect(turn?.durationMs).toBe(5_000);
  });

  it("times each turn of a shared run from its own window", () => {
    const projection = buildProjection([
      { id: "turn-1", ordinal: 1, startMs: 1_000, endMs: 3_000, runStartMs: 0 },
      { id: "turn-2", ordinal: 2, startMs: 4_000, endMs: 6_000, runStartMs: 0 },
    ]);
    const shared = {
      ...projection,
      attempts: projection.attempts.map((attempt) => ({
        ...attempt,
        runId: RunId.make("run-shared"),
      })),
      runs: [{ ...projection.runs[0]!, id: RunId.make("run-shared"), completedAt: at(6_000) }],
    };

    const metrics = deriveThreadMetrics(shared, T0 + 20_000);

    expect(metrics.turns[0]?.durationMs).toBe(2_000);
    expect(metrics.turns[1]?.durationMs).toBe(2_000);
  });

  it("reports a warm prompt cache with its remaining time", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 0,
        endMs: 1_000,
        tokenUsage: {
          usedTokens: 1_000,
          promptCacheTtlMs: 300_000,
          promptCacheExpiresAt: new Date(T0 + 60_000).toISOString(),
          updatedAt: new Date(T0 + 1_000).toISOString(),
        },
      },
    ]);

    const cache = deriveThreadMetrics(projection, T0 + 10_000).promptCache;

    expect(cache.state).toBe("warm");
    expect(cache.remainingMs).toBe(50_000);
    expect(cache.ttlMs).toBe(300_000);
    expect(cache.expiresAtMs).toBe(T0 + 60_000);
  });

  it("derives the cache expiry from the TTL when the provider omits it", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 0,
        endMs: 1_000,
        tokenUsage: {
          usedTokens: 1_000,
          promptCacheTtlMs: 300_000,
          updatedAt: new Date(T0).toISOString(),
        },
      },
    ]);

    const cache = deriveThreadMetrics(projection, T0 + 10_000).promptCache;

    expect(cache.state).toBe("warm");
    expect(cache.expiresAtMs).toBe(T0 + 300_000);
    expect(cache.remainingMs).toBe(290_000);
  });

  it("reports an expired prompt cache once its window closes", () => {
    const projection = buildProjection([
      {
        id: "turn-1",
        ordinal: 1,
        startMs: 0,
        endMs: 1_000,
        tokenUsage: {
          usedTokens: 1_000,
          promptCacheExpiresAt: new Date(T0 + 5_000).toISOString(),
          updatedAt: new Date(T0 + 1_000).toISOString(),
        },
      },
    ]);

    const cache = deriveThreadMetrics(projection, T0 + 10_000).promptCache;

    expect(cache.state).toBe("expired");
    expect(cache.remainingMs).toBe(0);
  });

  it("reports an unknown prompt cache without provider counters", () => {
    const projection = buildProjection([{ id: "turn-1", ordinal: 1, startMs: 0, endMs: 1_000 }]);

    expect(deriveThreadMetrics(projection, T0 + 10_000).promptCache.state).toBe("unknown");
    expect(deriveThreadMetrics(null, T0).promptCache.state).toBe("unknown");
  });

  it("survives zero tokens and zero duration", () => {
    const projection = buildProjection(
      [
        {
          id: "turn-1",
          ordinal: 1,
          startMs: 0,
          endMs: 0,
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 0,
            outputTokens: 0,
            hasSubagents: false,
          },
        },
      ],
      [streamItem("item-1", "turn-1", 0)],
    );

    const metrics = deriveThreadMetrics(projection, T0 + 1_000);
    const turn = metrics.turns[0];

    expect(turn?.cacheHitRate).toBeNull();
    expect(turn?.durationMs).toBe(0);
    expect(turn?.ttftMs).toBeNull();
    expect(turn?.outputTokensPerSec).toBeNull();
    expect(metrics.cacheHitRate).toBeNull();
    expect(metrics.avgOutputTokensPerSec).toBeNull();
    expect(metrics.turnsWithUsage).toBe(0);
  });

  it("ignores a first stream that lands before the turn started", () => {
    const projection = buildProjection(
      [{ id: "turn-1", ordinal: 1, startMs: 5_000, endMs: 9_000 }],
      [streamItem("item-1", "turn-1", 1_000)],
    );

    expect(deriveThreadMetrics(projection, T0 + 20_000).turns[0]?.ttftMs).toBeNull();
  });

  it("returns an empty summary for a thread without a projection", () => {
    const metrics = deriveThreadMetrics(null, T0);

    expect(metrics.turnCount).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.turns).toEqual([]);
  });
});

describe("extractCompletedLedgerRecords", () => {
  it("records only completed turns that spent tokens", () => {
    const projection = buildProjection(
      [
        {
          id: "turn-1",
          ordinal: 1,
          startMs: 0,
          endMs: 10_000,
          turnTokenUsage: completeUsage,
          model: "claude-sonnet-4-5",
        },
        { id: "turn-2", ordinal: 2, startMs: 11_000, endMs: null },
      ],
      [streamItem("item-1", "turn-1", 800)],
      [
        {
          id: ProviderSessionId.make("session-1"),
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId,
          status: "ready",
          cwd: "/work",
          model: "claude-sonnet-4-5",
          capabilities: {},
          createdAt: at(0),
          updatedAt: at(0),
          lastError: null,
        } as OrchestrationV2ProviderSession,
      ],
    );

    const records = extractCompletedLedgerRecords(environmentId, projection, T0 + 20_000);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      turnId: "turn-1",
      environmentId,
      threadId: "thread-test",
      providerInstanceId,
      driver: "claudeAgent",
      model: "claude-sonnet-4-5",
      inputTokens: 12_000,
      uncachedInputTokens: 2_000,
      cachedInputTokens: 9_000,
      cacheCreationTokens: 1_000,
      outputTokens: 800,
      reasoningTokens: 300,
      totalTokens: 12_800,
      durationMs: 10_000,
      ttftMs: 800,
      recordedAt: new Date(T0 + 20_000).toISOString(),
    });
  });

  it("returns nothing without a projection", () => {
    expect(extractCompletedLedgerRecords(environmentId, null, T0)).toEqual([]);
  });
});

describe("formatting helpers", () => {
  it("formats tokens compactly", () => {
    expect(formatTokenCompact(0)).toBe("0");
    expect(formatTokenCompact(999)).toBe("999");
    expect(formatTokenCompact(42_100)).toBe("42.1K");
    expect(formatTokenCompact(1_500_000)).toBe("1.50M");
  });

  it("formats speed, duration, and cache hit rate", () => {
    expect(formatSpeed(68.42)).toBe("68.4 t/s");
    expect(formatSpeed(120.4)).toBe("120 t/s");
    expect(formatSpeed(null)).toBe("-");
    expect(formatDurationCompact(820)).toBe("820ms");
    expect(formatDurationCompact(4_200)).toBe("4.2s");
    expect(formatDurationCompact(72_000)).toBe("1m 12s");
    expect(formatDurationCompact(3_840_000)).toBe("1h 4m");
    expect(formatDurationCompact(null)).toBe("-");
    expect(formatCacheHitPercent(0.8412)).toBe("84%");
    expect(formatCacheHitPercent(null)).toBe("-");
  });
});
