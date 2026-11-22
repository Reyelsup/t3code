import { describe, expect, it } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import {
  type AntigravityPresentationLike,
  buildNasKeepaliveScheduleInput,
  classifyQuotaWindow,
  extractAntigravityAccounts,
  findActivationTargets,
  getQuotaFamilyKey,
  groupWindowsIntoFamilies,
  isNasKeepaliveTask,
  NAS_KEEPALIVE_INTERVAL_MS,
  NAS_KEEPALIVE_PREFIX,
  selectActivationModel,
} from "./antigravityQuota.logic";
import type { AntigravityActivationLogEntry, AntigravityGuardConfig } from "./antigravityConfig";

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;
const INSTANCE_1 = "antigravity-1" as ProviderInstanceId;
const INSTANCE_2 = "antigravity-2" as ProviderInstanceId;

describe("classifyQuotaWindow", () => {
  const now = 1_700_000_000_000;

  it("classifies untouched 0% window without reset as unactivated", () => {
    const window: ServerProviderUsageWindow = {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini 5h",
      usedPercent: 0,
      windowDurationMins: 300,
    };
    expect(classifyQuotaWindow(window, now)).toBe("unactivated");
  });

  it("classifies window with past resetTime as reset_ready", () => {
    const window: ServerProviderUsageWindow = {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini 5h",
      usedPercent: 50,
      resetsAt: new Date(now - 60_000).toISOString(),
      windowDurationMins: 300,
    };
    expect(classifyQuotaWindow(window, now)).toBe("reset_ready");
  });

  it("classifies window with future resetTime and usedPercent >= 100 as exhausted", () => {
    const window: ServerProviderUsageWindow = {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini 5h",
      usedPercent: 100,
      resetsAt: new Date(now + 60_000).toISOString(),
      windowDurationMins: 300,
    };
    expect(classifyQuotaWindow(window, now)).toBe("exhausted");
  });

  it("classifies window with future resetTime and usedPercent < 100 as active", () => {
    const window: ServerProviderUsageWindow = {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini 5h",
      usedPercent: 42,
      resetsAt: new Date(now + 60_000).toISOString(),
      windowDurationMins: 300,
    };
    expect(classifyQuotaWindow(window, now)).toBe("active");
  });

  it("classifies window without resetTime or duration as unknown", () => {
    const window: ServerProviderUsageWindow = {
      id: "other",
      kind: "other",
      label: "Other",
      usedPercent: 0,
    };
    expect(classifyQuotaWindow(window, now)).toBe("unknown");
    expect(classifyQuotaWindow(undefined, now)).toBe("unknown");
  });
});

describe("getQuotaFamilyKey & groupWindowsIntoFamilies", () => {
  it("resolves family keys correctly", () => {
    expect(getQuotaFamilyKey("gemini-5h")).toBe("gemini");
    expect(getQuotaFamilyKey("gemini-argon-5h")).toBe("gemini-argon");
    expect(getQuotaFamilyKey("gemini-carbon-weekly")).toBe("gemini-carbon");
    expect(getQuotaFamilyKey("3p-5h")).toBe("3p");
    expect(getQuotaFamilyKey("claude-3-5-sonnet")).toBe("3p");
    expect(getQuotaFamilyKey("gpt-4o")).toBe("3p");
    expect(getQuotaFamilyKey("custom-bucket")).toBe("custom");
  });

  it("groups windows into 5h and weekly slots", () => {
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "gemini-5h",
        kind: "session",
        label: "Gemini 5h",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "gemini-weekly",
        kind: "weekly",
        label: "Gemini Weekly",
        usedPercent: 10,
        windowDurationMins: 10080,
      },
      {
        id: "gemini-argon-5h",
        kind: "session",
        label: "Argon 5h",
        usedPercent: 0,
        windowDurationMins: 300,
      },
    ];

    const families = groupWindowsIntoFamilies(windows);
    expect(families.has("gemini")).toBe(true);
    expect(families.has("gemini-argon")).toBe(true);

    const gemini = families.get("gemini")!;
    expect(gemini.label).toBe("Gemini");
    expect(gemini.fiveHour?.id).toBe("gemini-5h");
    expect(gemini.weekly?.id).toBe("gemini-weekly");

    const argon = families.get("gemini-argon")!;
    expect(argon.label).toBe("Gemini Argon");
    expect(argon.fiveHour?.id).toBe("gemini-argon-5h");
    expect(argon.weekly).toBeUndefined();
  });
});

describe("selectActivationModel", () => {
  const models = [
    { id: "gemini-1.5-pro" },
    { id: "gemini-3.8-flash" },
    { id: "gemini-argon-experimental" },
    { id: "gemini-carbon-preview" },
    { id: "claude-3-5-haiku-20241022" },
    { id: "claude-3-5-sonnet-20241022" },
  ];

  it("selects exact or flash model for gemini", () => {
    expect(selectActivationModel(models, "gemini")).toBe("gemini-3.8-flash");
    expect(
      selectActivationModel([{ id: "gemini-2.0-flash" }, { id: "gemini-pro" }], "gemini"),
    ).toBe("gemini-2.0-flash");
    expect(selectActivationModel([{ id: "gemini-1.5-pro" }], "gemini")).toBe("gemini-1.5-pro");
  });

  it("selects argon model for gemini-argon", () => {
    expect(selectActivationModel(models, "gemini-argon")).toBe("gemini-argon-experimental");
  });

  it("selects carbon model for gemini-carbon", () => {
    expect(selectActivationModel(models, "gemini-carbon")).toBe("gemini-carbon-preview");
  });

  it("selects lightest model for 3p (haiku before sonnet)", () => {
    expect(selectActivationModel(models, "3p")).toBe("claude-3-5-haiku-20241022");
    expect(selectActivationModel([{ id: "claude-sonnet" }, { id: "gpt-4o" }], "3p")).toBe(
      "claude-sonnet",
    );
  });

  it("honors preferred model override if available", () => {
    expect(selectActivationModel(models, "gemini", "gemini-1.5-pro")).toBe("gemini-1.5-pro");
    // Fallback if override is not in list
    expect(selectActivationModel(models, "gemini", "non-existent-model")).toBe("gemini-3.8-flash");
  });
});

describe("extractAntigravityAccounts", () => {
  it("extracts native accounts, enriches from hub, and includes hub-only accounts", () => {
    const presentations: Array<readonly [EnvironmentId, AntigravityPresentationLike]> = [
      [
        ENV_1,
        {
          entry: {
            environmentId: ENV_1,
            target: { label: "Local Mac", environmentId: ENV_1 },
          },
          serverConfig: {
            providers: [
              {
                instanceId: INSTANCE_1,
                driver: "antigravity",
                displayName: "Personal Antigravity",
                status: "ready",
                enabled: true,
                auth: { status: "authenticated" },
                checkedAt: "2026-11-22T00:00:00.000Z",
                models: [{ id: "gemini-3.8-flash" }],
                usageLimits: {
                  checkedAt: "2026-11-22T00:00:00.000Z",
                  credentialFingerprint: "fingerprint-alpha",
                  windows: [
                    {
                      id: "gemini-5h",
                      kind: "session",
                      label: "Gemini 5h",
                      usedPercent: 0,
                      windowDurationMins: 300,
                    },
                  ],
                },
              } as unknown as ServerProvider,
              {
                instanceId: "claude-native" as ProviderInstanceId,
                driver: "claude",
                status: "ready",
                enabled: true,
              } as unknown as ServerProvider,
            ],
            usageLimitSources: [
              {
                id: "hub-1" as unknown as UsageLimitSourceId,
                kind: "cliproxy",
                label: "CLI Proxy",
                checkedAt: "2026-11-22T00:00:00.000Z",
                accounts: [
                  {
                    id: "acc-1",
                    driver: ProviderDriverKind.make("antigravity"),
                    email: "alpha@example.com",
                    plan: "Google One AI Premium",
                    usageLimits: {
                      checkedAt: "2026-11-22T00:00:00.000Z",
                      credentialFingerprint: "fingerprint-alpha",
                      windows: [],
                    },
                  },
                  {
                    id: "acc-hub-only",
                    driver: ProviderDriverKind.make("antigravity"),
                    email: "beta@example.com",
                    plan: "Ultra 2M",
                    usageLimits: {
                      checkedAt: "2026-11-22T00:00:00.000Z",
                      credentialFingerprint: "fingerprint-beta",
                      windows: [
                        {
                          id: "gemini-weekly",
                          kind: "weekly",
                          label: "Weekly",
                          usedPercent: 10,
                          windowDurationMins: 10080,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ];

    const accounts = extractAntigravityAccounts(presentations);
    expect(accounts).toHaveLength(2);

    const nativeAcc = accounts.find((a) => !a.isHubOnly)!;
    expect(nativeAcc).toBeDefined();
    expect(nativeAcc.id).toBe(`${ENV_1}:${INSTANCE_1}`);
    expect(nativeAcc.email).toBe("alpha@example.com");
    expect(nativeAcc.plan).toBe("Google One AI Premium");
    expect(nativeAcc.families.get("gemini")?.fiveHour?.id).toBe("gemini-5h");

    const hubAcc = accounts.find((a) => a.isHubOnly)!;
    expect(hubAcc).toBeDefined();
    expect(hubAcc.status).toBe("hub_read_only");
    expect(hubAcc.email).toBe("beta@example.com");
    expect(hubAcc.instanceId).toBeUndefined();
    expect(hubAcc.families.get("gemini")?.weekly?.id).toBe("gemini-weekly");
  });

  it("extracts unavailable accounts so they are not hidden", () => {
    const presentations: Array<readonly [EnvironmentId, AntigravityPresentationLike]> = [
      [
        ENV_2,
        {
          entry: {
            environmentId: ENV_2,
            target: { label: "Remote NAS", environmentId: ENV_2 },
          },
          serverConfig: {
            providers: [
              {
                instanceId: INSTANCE_2,
                driver: "antigravity",
                displayName: "Expired AG",
                status: "error",
                enabled: true,
                message: "Sign in has expired",
                auth: { status: "unauthenticated" },
                checkedAt: "2026-11-22T00:00:00.000Z",
                models: [],
                usageLimits: {
                  checkedAt: "2026-11-22T00:00:00.000Z",
                  unavailable: { reason: "probeFailed", message: "Sign in has expired" },
                  windows: [],
                },
              } as unknown as ServerProvider,
            ],
          },
        },
      ],
    ];

    const accounts = extractAntigravityAccounts(presentations);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.status).toBe("error");
    expect(accounts[0]!.unavailableMessage).toBe("Sign in has expired");
  });
});

describe("findActivationTargets", () => {
  const now = 1_700_000_000_000;
  const accounts = extractAntigravityAccounts([
    [
      ENV_1,
      {
        entry: {
          environmentId: ENV_1,
          target: { label: "Mac", environmentId: ENV_1 },
        },
        serverConfig: {
          providers: [
            {
              instanceId: INSTANCE_1,
              driver: "antigravity",
              displayName: "Mac AG",
              status: "ready",
              enabled: true,
              models: [{ id: "gemini-3.8-flash" }, { id: "gemini-argon-model" }],
              usageLimits: {
                checkedAt: "2026-11-22T00:00:00.000Z",
                windows: [
                  {
                    id: "gemini-5h",
                    kind: "session",
                    label: "Gemini 5h",
                    usedPercent: 0,
                    windowDurationMins: 300,
                  },
                  {
                    id: "gemini-argon-5h",
                    kind: "session",
                    label: "Argon 5h",
                    usedPercent: 0,
                    windowDurationMins: 300,
                  },
                ],
              },
            } as unknown as ServerProvider,
          ],
        },
      },
    ],
  ]);

  it("returns empty when globalAutoActivate is false", () => {
    const config: AntigravityGuardConfig = {
      globalAutoActivate: false,
      checkIntervalMinutes: 5,
      cooldownMinutes: 30,
      autoArchiveWarmupThread: true,
      warmupPrompt: "Reply with OK.",
      accounts: {
        [`${ENV_1}:${INSTANCE_1}`]: {
          autoActivate: true,
          guardedFamilies: ["gemini"],
        },
      },
    };
    expect(findActivationTargets(accounts, config, [], now)).toEqual([]);
  });

  it("returns targets when globalAutoActivate is true and unactivated window exists", () => {
    const config: AntigravityGuardConfig = {
      globalAutoActivate: true,
      checkIntervalMinutes: 5,
      cooldownMinutes: 30,
      autoArchiveWarmupThread: true,
      warmupPrompt: "Reply with OK.",
      accounts: {
        [`${ENV_1}:${INSTANCE_1}`]: {
          autoActivate: true,
          guardedFamilies: ["gemini"],
        },
      },
    };

    const targets = findActivationTargets(accounts, config, [], now);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.familyKey).toBe("gemini");
    expect(targets[0]!.model).toBe("gemini-3.8-flash");
    expect(targets[0]!.reason).toBe("5-hour window unactivated");
  });

  it("suppresses activation during quiet hours", () => {
    const currentHour = new Date(now).getHours();
    const config: AntigravityGuardConfig = {
      globalAutoActivate: true,
      checkIntervalMinutes: 5,
      cooldownMinutes: 30,
      autoArchiveWarmupThread: true,
      warmupPrompt: "Reply with OK.",
      quietHours: {
        enabled: true,
        startHour: currentHour,
        endHour: (currentHour + 1) % 24,
      },
      accounts: {
        [`${ENV_1}:${INSTANCE_1}`]: {
          autoActivate: true,
          guardedFamilies: ["gemini"],
        },
      },
    };

    expect(findActivationTargets(accounts, config, [], now)).toEqual([]);
  });

  it("suppresses activation within cooldown and activates when cooldown expires", () => {
    const config: AntigravityGuardConfig = {
      globalAutoActivate: true,
      checkIntervalMinutes: 5,
      cooldownMinutes: 30,
      autoArchiveWarmupThread: true,
      warmupPrompt: "Reply with OK.",
      accounts: {
        [`${ENV_1}:${INSTANCE_1}`]: {
          autoActivate: true,
          guardedFamilies: ["gemini"],
        },
      },
    };

    const recentHistory: AntigravityActivationLogEntry[] = [
      {
        id: "log-1",
        timestamp: now - 10 * 60 * 1000,
        environmentId: ENV_1,
        instanceId: INSTANCE_1,
        accountLabel: "Mac AG",
        familyKey: "gemini",
        model: "gemini-3.8-flash",
        trigger: "auto",
        outcome: "success",
      },
    ];

    expect(findActivationTargets(accounts, config, recentHistory, now)).toEqual([]);

    const expiredHistory: AntigravityActivationLogEntry[] = [
      {
        id: "log-2",
        timestamp: now - 35 * 60 * 1000,
        environmentId: ENV_1,
        instanceId: INSTANCE_1,
        accountLabel: "Mac AG",
        familyKey: "gemini",
        model: "gemini-3.8-flash",
        trigger: "auto",
        outcome: "success",
      },
    ];

    expect(findActivationTargets(accounts, config, expiredHistory, now)).toHaveLength(1);
  });
});

describe("buildNasKeepaliveScheduleInput & isNasKeepaliveTask", () => {
  it("builds a valid NAS keepalive schedule input with 5h 5m interval", () => {
    const input = buildNasKeepaliveScheduleInput({
      instanceId: INSTANCE_1,
      model: "gemini-3.8-flash",
      projectId: "proj-1" as any,
      accountLabel: "Primary AG",
      familyKey: "gemini",
    });

    expect(input.title).toBe(`${NAS_KEEPALIVE_PREFIX} Primary AG (gemini)`);
    expect(input.schedule.type).toBe("interval");
    if (input.schedule.type === "interval") {
      expect(input.schedule.everyMs).toBe(NAS_KEEPALIVE_INTERVAL_MS);
      expect(input.schedule.everyMs).toBe(18_300_000);
    }
    expect(input.threadMode).toBe("new_thread");
    expect(input.modelSelection.instanceId).toBe(INSTANCE_1);
    expect(input.modelSelection.model).toBe("gemini-3.8-flash");
    expect(input.prompt).toBe("Reply with OK.");

    expect(isNasKeepaliveTask({ title: input.title } as any)).toBe(true);
    expect(isNasKeepaliveTask({ title: "Custom Task" } as any)).toBe(false);
  });
});
