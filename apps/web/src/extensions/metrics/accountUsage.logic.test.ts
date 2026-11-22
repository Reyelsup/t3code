import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
  type ServerProviderUsageLimits,
  ThreadId,
  UsageDay,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentUsageStatus } from "../../state/usage";

import {
  buildAccountUsage,
  providerKindForDriver,
  summarizeAccountUsage,
  type AccountUsage,
  type AccountUsageInput,
} from "./accountUsage.logic";
import type { LocalTurnLedgerRecord } from "./types";

const ENV_A = EnvironmentId.make("env-a");
const WINDOW: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-01-01"),
  untilDay: UsageDay.make("2026-01-31"),
  timeZone: "UTC",
};

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");

function usageSummary(buckets: readonly UsageBucket[]): UsageSummary {
  return {
    contractVersion: 6,
    readAt: "2026-01-31T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: WINDOW.sinceDay,
    untilDay: WINDOW.untilDay,
    buckets,
    sources: [],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  };
}

function environmentSignal(
  environmentId: EnvironmentId,
  label: string,
  buckets: readonly UsageBucket[],
): EnvironmentUsageStatus {
  return {
    environmentId,
    label,
    isPending: false,
    canReadDiagnostics: true,
    isConnected: true,
    error: null,
    summary: usageSummary(buckets),
  };
}

function bucket(input: {
  readonly provider: UsageProviderKind;
  readonly sourcePath?: string;
  readonly totals?: {
    readonly uncachedInputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
  };
  readonly costUsd?: number;
  readonly day?: string;
  readonly model?: string;
  readonly sessions?: number;
}): UsageBucket {
  return {
    day: UsageDay.make(input.day ?? "2026-01-15"),
    provider: input.provider,
    model: input.model ?? "model-x",
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    totals: {
      uncachedInputTokens: input.totals?.uncachedInputTokens ?? 0,
      cachedInputTokens: input.totals?.cachedInputTokens ?? 0,
      cacheCreationTokens: input.totals?.cacheCreationTokens ?? 0,
      outputTokens: input.totals?.outputTokens ?? 0,
      reasoningTokens: input.totals?.reasoningTokens ?? 0,
    },
    costUsd: input.costUsd ?? 0,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: input.sessions ?? 1,
  };
}

function providerInstance(input: {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly homePath?: string;
  readonly shadowHomePath?: string | null;
  readonly displayName?: string;
  readonly email?: string;
  readonly enabled?: boolean;
  readonly usageLimits?: ServerProviderUsageLimits;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      ...(input.email === undefined ? {} : { email: input.email }),
    },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.homePath === undefined
      ? {}
      : {
          runtimePaths: {
            homePath: input.homePath,
            shadowHomePath: input.shadowHomePath ?? null,
          },
        }),
    ...(input.usageLimits === undefined ? {} : { usageLimits: input.usageLimits }),
  };
}

function turnRecord(input: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver?: ProviderDriverKind | null;
  readonly turnId?: string;
  readonly threadId?: string;
  readonly model?: string | null;
  readonly recordedAt?: string;
  readonly totals?: {
    readonly uncachedInputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
  };
  readonly outputTokensPerSec?: number | null;
  readonly ttftMs?: number | null;
}): LocalTurnLedgerRecord {
  const totals = {
    uncachedInputTokens: input.totals?.uncachedInputTokens ?? 100,
    cachedInputTokens: input.totals?.cachedInputTokens ?? 0,
    cacheCreationTokens: input.totals?.cacheCreationTokens ?? 0,
    outputTokens: input.totals?.outputTokens ?? 50,
    reasoningTokens: input.totals?.reasoningTokens ?? 0,
  };
  return {
    turnId: input.turnId ?? "turn-1",
    environmentId: input.environmentId,
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    providerInstanceId: input.providerInstanceId,
    driver: input.driver ?? null,
    model: input.model ?? "model-x",
    ...totals,
    inputTokens: totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens,
    totalTokens:
      totals.outputTokens +
      totals.reasoningTokens +
      totals.uncachedInputTokens +
      totals.cachedInputTokens +
      totals.cacheCreationTokens,
    durationMs: null,
    ttftMs: input.ttftMs ?? null,
    outputTokensPerSec: input.outputTokensPerSec ?? null,
    recordedAt: input.recordedAt ?? "2026-01-15T10:00:00.000Z",
  };
}

function report(input: {
  readonly environments?: readonly EnvironmentUsageStatus[];
  readonly providers?: ReadonlyMap<EnvironmentId, readonly ServerProvider[]>;
  readonly settings?: ReadonlyMap<EnvironmentId, Pick<ServerSettings, "providerInstances"> | null>;
  readonly ledger?: readonly LocalTurnLedgerRecord[];
  readonly hidden?: ReadonlySet<UsageProviderKind>;
  readonly window?: UsageSummaryInput;
}) {
  const buildInput: AccountUsageInput = {
    environments: input.environments ?? [],
    providersByEnvironment: input.providers ?? new Map(),
    ...(input.settings === undefined ? {} : { settingsByEnvironment: input.settings }),
    ledgerRecords: input.ledger ?? [],
    window: input.window ?? WINDOW,
    hiddenProviders: input.hidden ?? new Set(),
  };
  return buildAccountUsage(buildInput);
}

const accountByKey = (accounts: readonly AccountUsage[], key: string) =>
  accounts.find((account) => account.key === key);

const baseUsageLimits = (usedPercent: number): ServerProviderUsageLimits => ({
  checkedAt: "2026-01-01T00:00:00.000Z",
  windows: [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent,
    },
  ],
});

describe("provider kind mapping", () => {
  it("maps drivers to usage kinds", () => {
    expect(providerKindForDriver(CLAUDE_DRIVER)).toBe("claude");
    expect(providerKindForDriver(ANTIGRAVITY_DRIVER)).toBe("antigravity");
    expect(providerKindForDriver(CODEX_DRIVER)).toBe("codex");
    expect(providerKindForDriver(ProviderDriverKind.make("acpRegistry"))).toBeNull();
  });
});

describe("path attribution", () => {
  const aliceClaude = providerInstance({
    instanceId: "claude-alice",
    driver: CLAUDE_DRIVER,
    homePath: "/home/alice/.claude",
    displayName: "Claude (Alice)",
  });
  const bobClaude = providerInstance({
    instanceId: "claude-bob",
    driver: CLAUDE_DRIVER,
    homePath: "/home/bob/.claude",
    displayName: "Claude (Bob)",
  });

  it("splits two same-driver accounts by home path", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/alice/.claude/projects/alpha/session.jsonl",
            totals: { uncachedInputTokens: 1_000, outputTokens: 500 },
          }),
          bucket({
            provider: "claude",
            sourcePath: "/home/bob/.claude/projects/beta/session.jsonl",
            totals: { uncachedInputTokens: 200, outputTokens: 100 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [aliceClaude, bobClaude]]]),
    });

    expect(result.accounts).toHaveLength(2);
    const alice = accountByKey(result.accounts, `${ENV_A}:claude-alice`);
    const bob = accountByKey(result.accounts, `${ENV_A}:claude-bob`);
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.totalTokens).toBe(1_500);
    expect(bob!.totalTokens).toBe(300);
    expect(alice!.displayName).toBe("Claude (Alice)");
    expect(alice!.source).toBe("server-scan");
  });

  it("prefers the longest matching prefix when candidate homes nest", () => {
    const broadHome = providerInstance({
      instanceId: "codex-broad",
      driver: CODEX_DRIVER,
      homePath: "/home/alice",
    });
    const nestedHome = providerInstance({
      instanceId: "codex-nested",
      driver: CODEX_DRIVER,
      homePath: "/home/alice/.codex-second",
    });
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "codex",
            sourcePath: "/home/alice/.codex-second/sessions/rollout.jsonl",
            totals: { uncachedInputTokens: 10_000 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [broadHome, nestedHome]]]),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.instanceId).toBe(ProviderInstanceId.make("codex-nested"));
    expect(result.accounts[0]!.totalTokens).toBe(10_000);
  });

  it("leaves a pathless bucket unattributed when the driver has several enabled instances", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            totals: { uncachedInputTokens: 700 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [aliceClaude, bobClaude]]]),
    });

    // aliceClaude and bobClaude are both enabled, so no single-instance fallback applies.
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.unattributed).toBe(true);
    expect(result.accounts[0]!.totalTokens).toBe(700);
    expect(result.accounts[0]!.displayName).toBe("Unattributed (Claude Code)");
  });

  it("attributes a pathless bucket to the only enabled instance", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({ provider: "claude", totals: { uncachedInputTokens: 700 } }),
        ]),
      ],
      providers: new Map([[ENV_A, [aliceClaude, { ...bobClaude, enabled: false }]]]),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.instanceId).toBe(ProviderInstanceId.make("claude-alice"));
    expect(result.accounts[0]!.unattributed).toBe(false);
  });

  it("collects unmatched buckets instead of dropping their tokens", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/alice/.claude/projects/alpha/session.jsonl",
            totals: { uncachedInputTokens: 1_000 },
          }),
          bucket({
            provider: "claude",
            sourcePath: "/srv/unmapped/session.jsonl",
            totals: { uncachedInputTokens: 333, outputTokens: 111 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [aliceClaude, bobClaude]]]),
    });

    const attributed = result.accounts.reduce((sum, account) => sum + account.totalTokens, 0);
    expect(attributed).toBe(1_444);
    const unattributed = result.accounts.find((account) => account.unattributed);
    expect(unattributed?.totalTokens).toBe(444);
    expect(unattributed?.providerKind).toBe("claude");
  });

  it("uses configured home env vars as candidate paths", () => {
    const claudeZoe = providerInstance({ instanceId: "claude-zoe", driver: CLAUDE_DRIVER });
    const instanceConfig: ProviderInstanceConfig = {
      driver: CLAUDE_DRIVER,
      environment: [
        { name: "CLAUDE_CONFIG_DIR", value: "/home/zoe/.claude-alt", sensitive: false },
      ],
    };
    const settings: Pick<ServerSettings, "providerInstances"> = {
      providerInstances: { [ProviderInstanceId.make("claude-zoe")]: instanceConfig },
    };
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          // Normalize slashes and casing before matching.
          bucket({
            provider: "claude",
            sourcePath: "/HOME/Zoe/.claude-alt\\projects\\z.jsonl",
            totals: { uncachedInputTokens: 900 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [claudeZoe]]]),
      settings: new Map([[ENV_A, settings]]),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.instanceId).toBe(ProviderInstanceId.make("claude-zoe"));
  });

  it("attributes an unmatched bucket to the only enabled instance", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/alice/.claude/projects/alpha/session.jsonl",
            totals: { uncachedInputTokens: 500 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [{ ...aliceClaude, enabled: false }, bobClaude]]]),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.instanceId).toBe(ProviderInstanceId.make("claude-bob"));
    expect(result.accounts[0]!.unattributed).toBe(false);
  });

  it("passes through provider usage limits and auth email", () => {
    const limits = baseUsageLimits(12);
    const withExtras = {
      ...aliceClaude,
      auth: { status: "authenticated" as const, email: "alice@example.com" },
      usageLimits: limits,
    };
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({ provider: "claude", totals: { uncachedInputTokens: 50 } }),
        ]),
      ],
      providers: new Map([[ENV_A, [withExtras]]]),
    });

    expect(result.accounts[0]!.usageLimits).toBe(limits);
    expect(result.accounts[0]!.email).toBe("alice@example.com");
  });
});

describe("live ledger attribution", () => {
  const claudeWork = providerInstance({
    instanceId: "claude-work",
    driver: CLAUDE_DRIVER,
    homePath: "/work/.claude",
    displayName: "Claude (Work)",
  });
  const antigravity = providerInstance({
    instanceId: "antigravity-main",
    driver: ANTIGRAVITY_DRIVER,
    displayName: "Antigravity",
  });

  it("attaches observed speed and turns to a server-scanned account", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/work/.claude/projects/a/session.jsonl",
            totals: { uncachedInputTokens: 5_000, outputTokens: 1_000 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [claudeWork]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          driver: CLAUDE_DRIVER,
          turnId: "t1",
          outputTokensPerSec: 40,
          ttftMs: 300,
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          driver: CLAUDE_DRIVER,
          turnId: "t2",
          outputTokensPerSec: 60,
          ttftMs: 500,
        }),
      ],
    });

    const account = accountByKey(result.accounts, `${ENV_A}:claude-work`);
    expect(account).toBeDefined();
    expect(account!.source).toBe("hybrid");
    // Ledger turns only add observability, never tokens, on scanned accounts.
    expect(account!.totalTokens).toBe(6_000);
    expect(account!.avgOutputTokensPerSec).toBe(50);
    expect(account!.avgTtftMs).toBe(400);
    expect(account!.observedTurns).toBe(2);
  });

  it("creates live-ledger rows for accounts the server never scanned", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/work/.claude/projects/a/session.jsonl",
            totals: { uncachedInputTokens: 5_000 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [claudeWork, antigravity]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("antigravity-main"),
          driver: ANTIGRAVITY_DRIVER,
          turnId: "t1",
          threadId: "thread-1",
          totals: { uncachedInputTokens: 2_000, outputTokens: 400 },
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("antigravity-main"),
          driver: ANTIGRAVITY_DRIVER,
          turnId: "t2",
          threadId: "thread-2",
          totals: { uncachedInputTokens: 1_000, outputTokens: 200 },
        }),
      ],
    });

    const live = accountByKey(result.accounts, `${ENV_A}:antigravity-main`);
    expect(live).toBeDefined();
    expect(live!.source).toBe("live-ledger");
    expect(live!.totalTokens).toBe(3_600);
    expect(live!.sessions).toBe(2);
    expect(live!.observedTurns).toBe(2);
    expect(live!.providerKind).toBe("antigravity");
    expect(live!.displayName).toBe("Antigravity");
    expect(live!.daily).toHaveLength(1);
    expect(live!.models[0]!.model).toBe("model-x");
  });

  it("ignores ledger turns without an instance and skips duplicate turn ids", () => {
    const result = report({
      environments: [environmentSignal(ENV_A, "Laptop", [])],
      providers: new Map([[ENV_A, [claudeWork]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: null,
          driver: CLAUDE_DRIVER,
          turnId: "t-no-instance",
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          driver: CLAUDE_DRIVER,
          turnId: "t-dup",
          totals: { uncachedInputTokens: 100 },
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-work"),
          driver: CLAUDE_DRIVER,
          turnId: "t-dup",
          totals: { uncachedInputTokens: 100 },
        }),
      ],
    });

    const live = accountByKey(result.accounts, `${ENV_A}:claude-work`);
    expect(live!.observedTurns).toBe(1);
    expect(live!.totalTokens).toBe(150);
  });
});

describe("filtering", () => {
  const claudeOnly = providerInstance({
    instanceId: "claude-only",
    driver: CLAUDE_DRIVER,
    homePath: "/home/u/.claude",
  });
  const codexOnly = providerInstance({
    instanceId: "codex-only",
    driver: CODEX_DRIVER,
    homePath: "/home/u/.codex",
  });

  it("drops hidden providers from both scans and the ledger", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/u/.claude/projects/a/session.jsonl",
            totals: { uncachedInputTokens: 900 },
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [claudeOnly, codexOnly]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
          turnId: "claude-turn",
          totals: { uncachedInputTokens: 5 },
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("codex-only"),
          driver: CODEX_DRIVER,
          turnId: "codex-turn",
          totals: { uncachedInputTokens: 7, outputTokens: 0 },
        }),
      ],
      hidden: new Set<UsageProviderKind>(["claude"]),
    });

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.instanceId).toBe(ProviderInstanceId.make("codex-only"));
    expect(result.accounts[0]!.source).toBe("live-ledger");
    expect(result.totals.totalTokens).toBe(7);
  });

  it("keeps ledger turns only inside the requested day window", () => {
    const result = report({
      environments: [environmentSignal(ENV_A, "Laptop", [])],
      providers: new Map([[ENV_A, [claudeOnly]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
          turnId: "inside",
          recordedAt: "2026-01-15T10:00:00.000Z",
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
          turnId: "outside",
          recordedAt: "2025-12-15T10:00:00.000Z",
        }),
      ],
    });

    const live = accountByKey(result.accounts, `${ENV_A}:claude-only`);
    expect(live!.observedTurns).toBe(1);
  });

  it("honors hour windows when the ledger runs across midnight", () => {
    const result = report({
      environments: [environmentSignal(ENV_A, "Laptop", [])],
      providers: new Map([[ENV_A, [claudeOnly]]]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
          turnId: "inside-hours",
          recordedAt: "2026-01-15T12:00:00.000Z",
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
          turnId: "outside-hours",
          recordedAt: "2026-01-15T18:00:00.000Z",
        }),
      ],
      window: {
        sinceDay: UsageDay.make("2026-01-15"),
        untilDay: UsageDay.make("2026-01-15"),
        timeZone: "UTC",
        resolution: "hour",
        sinceTime: "2026-01-15T10:00:00.000Z",
        untilTime: "2026-01-15T14:00:00.000Z",
      },
    });

    const live = accountByKey(result.accounts, `${ENV_A}:claude-only`);
    expect(live!.observedTurns).toBe(1);
  });

  it("skips ledger turns for environments outside the selection", () => {
    const envB = EnvironmentId.make("env-b");
    const result = report({
      environments: [environmentSignal(ENV_A, "Laptop", [])],
      providers: new Map([
        [ENV_A, [claudeOnly]],
        [envB, [claudeOnly]],
      ]),
      ledger: [
        turnRecord({
          environmentId: envB,
          providerInstanceId: ProviderInstanceId.make("claude-only"),
          driver: CLAUDE_DRIVER,
        }),
      ],
    });

    expect(result.accounts).toHaveLength(0);
  });
});

describe("aggregation", () => {
  const claudeMain = providerInstance({
    instanceId: "claude-main",
    driver: CLAUDE_DRIVER,
    homePath: "/home/u/.claude",
  });

  it("derives cache hit rates, model rows, and daily entries from buckets", () => {
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/u/.claude/a.jsonl",
            day: "2026-01-10",
            model: "sonnet",
            totals: {
              uncachedInputTokens: 100,
              cachedInputTokens: 300,
              cacheCreationTokens: 100,
              outputTokens: 200,
              reasoningTokens: 50,
            },
            costUsd: 2,
          }),
          bucket({
            provider: "claude",
            sourcePath: "/home/u/.claude/a.jsonl",
            day: "2026-01-12",
            model: "haiku",
            totals: { uncachedInputTokens: 900, outputTokens: 100 },
            costUsd: 1,
          }),
        ]),
      ],
      providers: new Map([[ENV_A, [claudeMain]]]),
    });

    const account = accountByKey(result.accounts, `${ENV_A}:claude-main`)!;
    // One account holds both models: 300 cached of 1,400 total input.
    expect(account.cacheHitRate).toBeCloseTo(300 / 1_400);
    // Haiku is the bigger model row, so it leads the sorted list.
    expect(account.models.map((model) => model.model)).toEqual(["haiku", "sonnet"]);
    expect(account.models[0]!.cacheHitRate).toBe(0);
    expect(account.models[1]!.cacheHitRate).toBe(0.6);
    expect(account.daily.map((entry) => entry.day)).toEqual(["2026-01-10", "2026-01-12"]);
    expect(account.daily[0]!.totalTokens).toBe(700);
    expect(account.costUsd).toBe(3);
  });

  it("sums KPIs across accounts and weights speed by output tokens", () => {
    const fastClaude = {
      ...claudeMain,
      instanceId: ProviderInstanceId.make("claude-fast"),
      runtimePaths: { homePath: "/home/u/.claude-a", shadowHomePath: null },
    };
    const slowClaude = {
      ...claudeMain,
      instanceId: ProviderInstanceId.make("claude-slow"),
      runtimePaths: { homePath: "/home/u/.claude-b", shadowHomePath: null },
    };
    const result = report({
      environments: [
        environmentSignal(ENV_A, "Laptop", [
          bucket({
            provider: "claude",
            sourcePath: "/home/u/.claude-a/a.jsonl",
            totals: { uncachedInputTokens: 600, outputTokens: 400 },
            costUsd: 4,
          }),
          bucket({
            provider: "claude",
            sourcePath: "/home/u/.claude-b/a.jsonl",
            totals: { uncachedInputTokens: 300, cachedInputTokens: 300, outputTokens: 600 },
            costUsd: 2,
          }),
        ]),
      ],
      providers: new Map<EnvironmentId, readonly ServerProvider[]>([
        [ENV_A, [fastClaude, slowClaude]],
      ]),
      ledger: [
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-fast"),
          driver: CLAUDE_DRIVER,
          turnId: "fast-turn",
          totals: { outputTokens: 0 },
          outputTokensPerSec: 80,
        }),
        turnRecord({
          environmentId: ENV_A,
          providerInstanceId: ProviderInstanceId.make("claude-slow"),
          driver: CLAUDE_DRIVER,
          turnId: "slow-turn",
          totals: { outputTokens: 0 },
          outputTokensPerSec: 20,
        }),
      ],
    });

    expect(result.totals.totalAccounts).toBe(2);
    expect(result.totals.totalTokens).toBe(2_200);
    expect(result.totals.totalInputTokens).toBe(1_200);
    expect(result.totals.overallCacheHitRate).toBe(0.25);
    expect(result.totals.totalCostUsd).toBe(6);
    // 400 fast tokens and 600 slow tokens: (80*400 + 20*600) / 1000 = 44.
    expect(result.totals.weightedAvgSpeed).toBe(44);
  });

  it("returns a null overall cache hit rate and speed without observations", () => {
    const totals = summarizeAccountUsage([
      {
        key: "k",
        environmentId: ENV_A,
        environmentLabel: "Laptop",
        instanceId: null,
        driver: null,
        providerKind: null,
        displayName: "x",
        accentColor: undefined,
        email: undefined,
        source: "server-scan",
        unattributed: false,
        totalTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheHitRate: null,
        costUsd: 0,
        cacheSavingsUsd: 0,
        sessions: 0,
        records: 0,
        avgOutputTokensPerSec: null,
        avgTtftMs: null,
        observedTurns: 0,
        models: [],
        daily: [],
        usageLimits: null,
      },
    ]);
    expect(totals.overallCacheHitRate).toBeNull();
    expect(totals.weightedAvgSpeed).toBeNull();
  });
});
