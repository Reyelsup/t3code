/* oxlint-disable t3code/no-untranslated-copy -- Antigravity quota labels stay in English */
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import type { AntigravityActivationLogEntry, AntigravityGuardConfig } from "./antigravityConfig";

export type QuotaWindowState = "unactivated" | "reset_ready" | "exhausted" | "active" | "unknown";

export interface QuotaFamilySlots {
  readonly familyKey: string;
  readonly label: string;
  readonly fiveHour?: ServerProviderUsageWindow | undefined;
  readonly weekly?: ServerProviderUsageWindow | undefined;
  readonly other?: ReadonlyArray<ServerProviderUsageWindow> | undefined;
}

export interface AntigravityAccount {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly driver: "antigravity";
  readonly displayName: string;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
  readonly status: "ready" | "warning" | "error" | "disabled" | "hub_read_only";
  readonly enabled: boolean;
  readonly authStatus?: string | undefined;
  readonly credentialFingerprint?: string | undefined;
  readonly environmentLabel: string;
  readonly isHubOnly: boolean;
  readonly models: ReadonlyArray<{ readonly id: string; readonly name?: string | undefined }>;
  readonly families: ReadonlyMap<string, QuotaFamilySlots>;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
  readonly unavailableMessage?: string | undefined;
}

export interface ActivationTarget {
  readonly account: AntigravityAccount;
  readonly familyKey: string;
  readonly model: string;
  readonly reason: string;
}

export interface NasKeepaliveScheduleParams {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly projectId: ProjectId;
  readonly accountLabel: string;
  readonly familyKey: string;
  readonly existingTaskId?: ScheduledTaskId | undefined;
  readonly nextResetAtMs?: number | undefined;
}

export interface AntigravityPresentationLike {
  readonly entry?:
    | {
        readonly environmentId?: EnvironmentId | undefined;
        readonly target?:
          | {
              readonly label?: string | undefined;
              readonly environmentId?: EnvironmentId | undefined;
            }
          | undefined;
      }
    | undefined;
  readonly serverConfig?:
    | {
        readonly providers?: ReadonlyArray<ServerProvider> | undefined;
        readonly usageLimitSources?: ReadonlyArray<UsageLimitSourceSnapshot> | undefined;
      }
    | null
    | undefined;
}

export const NAS_KEEPALIVE_PREFIX = "[AG Keepalive]";
export const NAS_KEEPALIVE_INTERVAL_MS = 5 * 60 * 60 * 1000 + 5 * 60 * 1000; // 5h 5m

export function classifyQuotaWindow(
  window: ServerProviderUsageWindow | undefined,
  nowMs: number,
): QuotaWindowState {
  if (!window) return "unknown";
  if (window.usedPercent === 0 && !window.resetsAt && window.windowDurationMins !== undefined) {
    return "unactivated";
  }
  if (window.resetsAt !== undefined) {
    const resetTime = Date.parse(window.resetsAt);
    if (!Number.isNaN(resetTime)) {
      if (resetTime <= nowMs) {
        return "reset_ready";
      }
      if (window.usedPercent >= 100) {
        return "exhausted";
      }
      return "active";
    }
  }
  if (window.usedPercent >= 100) {
    return "exhausted";
  }
  return "unknown";
}

export function getQuotaFamilyKey(windowId: string): string {
  const lower = windowId.toLowerCase();
  if (lower.startsWith("gemini-argon-") || lower === "gemini-argon") {
    return "gemini-argon";
  }
  if (lower.startsWith("gemini-carbon-") || lower === "gemini-carbon") {
    return "gemini-carbon";
  }
  if (lower.startsWith("gemini-") || lower === "gemini") {
    return "gemini";
  }
  if (
    lower.startsWith("3p-") ||
    lower.startsWith("claude-") ||
    lower.startsWith("gpt-") ||
    lower === "3p"
  ) {
    return "3p";
  }
  const dashIndex = windowId.indexOf("-");
  return dashIndex > 0 ? windowId.slice(0, dashIndex) : windowId;
}

function getFamilyDisplayName(familyKey: string): string {
  switch (familyKey) {
    case "gemini":
      return "Gemini";
    case "gemini-argon":
      return "Gemini Argon";
    case "gemini-carbon":
      return "Gemini Carbon";
    case "3p":
      return "Claude & GPT";
    default:
      return familyKey.charAt(0).toUpperCase() + familyKey.slice(1);
  }
}

function isFiveHourWindow(window: ServerProviderUsageWindow): boolean {
  if (window.kind === "session") return true;
  if (window.windowDurationMins === 300) return true;
  const idLower = window.id.toLowerCase();
  return idLower.endsWith("-5h") || idLower.includes("-5h-") || idLower === "5h";
}

function isWeeklyWindow(window: ServerProviderUsageWindow): boolean {
  if (window.kind === "weekly") return true;
  if (window.windowDurationMins === 10080) return true;
  const idLower = window.id.toLowerCase();
  return idLower.endsWith("-weekly") || idLower.includes("-weekly-") || idLower === "weekly";
}

export function groupWindowsIntoFamilies(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyMap<string, QuotaFamilySlots> {
  const families = new Map<
    string,
    {
      familyKey: string;
      label: string;
      fiveHour: ServerProviderUsageWindow | undefined;
      weekly: ServerProviderUsageWindow | undefined;
      other: ServerProviderUsageWindow[];
    }
  >();

  for (const window of windows) {
    const familyKey = getQuotaFamilyKey(window.id);
    let entry = families.get(familyKey);
    if (!entry) {
      entry = {
        familyKey,
        label: getFamilyDisplayName(familyKey),
        fiveHour: undefined,
        weekly: undefined,
        other: [],
      };
      families.set(familyKey, entry);
    }

    if (isFiveHourWindow(window) && !entry.fiveHour) {
      entry.fiveHour = window;
    } else if (isWeeklyWindow(window) && !entry.weekly) {
      entry.weekly = window;
    } else {
      entry.other.push(window);
    }
  }

  const result = new Map<string, QuotaFamilySlots>();
  for (const [key, val] of families) {
    result.set(key, {
      familyKey: val.familyKey,
      label: val.label,
      fiveHour: val.fiveHour,
      weekly: val.weekly,
      other: val.other.length > 0 ? val.other : undefined,
    });
  }
  return result;
}

function normalizePresentations<T extends AntigravityPresentationLike>(
  presentations:
    | ReadonlyMap<EnvironmentId, T>
    | Iterable<readonly [EnvironmentId, T]>
    | ReadonlyArray<readonly [EnvironmentId, T]>
    | ReadonlyArray<T>
    | undefined
    | null,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly presentation: T }> {
  if (!presentations) return [];
  if (Array.isArray(presentations)) {
    if (presentations.length === 0) return [];
    if (Array.isArray(presentations[0])) {
      return (presentations as ReadonlyArray<readonly [EnvironmentId, T]>).map(
        ([environmentId, presentation]) => ({ environmentId, presentation }),
      );
    }
    return (presentations as ReadonlyArray<T>).map((presentation) => {
      const environmentId =
        presentation.entry?.environmentId ??
        presentation.entry?.target?.environmentId ??
        ("" as EnvironmentId);
      return { environmentId, presentation };
    });
  }
  if (presentations instanceof Map || Symbol.iterator in presentations) {
    const list: Array<{ environmentId: EnvironmentId; presentation: T }> = [];
    for (const item of presentations) {
      if (Array.isArray(item)) {
        list.push({ environmentId: item[0], presentation: item[1] });
      } else if (item && typeof item === "object") {
        const pres = item as T;
        const environmentId =
          pres.entry?.environmentId ?? pres.entry?.target?.environmentId ?? ("" as EnvironmentId);
        list.push({ environmentId, presentation: pres });
      }
    }
    return list;
  }
  return [];
}

export function extractAntigravityAccounts<
  T extends AntigravityPresentationLike = AntigravityPresentationLike,
>(
  presentations:
    | ReadonlyMap<EnvironmentId, T>
    | Iterable<readonly [EnvironmentId, T]>
    | ReadonlyArray<readonly [EnvironmentId, T]>
    | ReadonlyArray<T>
    | undefined
    | null,
  _nowMs?: number,
): ReadonlyArray<AntigravityAccount> {
  const normalized = normalizePresentations(presentations);
  const accounts: AntigravityAccount[] = [];

  for (const { environmentId, presentation } of normalized) {
    const envLabel = presentation.entry?.target?.label ?? String(environmentId);
    const providers = presentation.serverConfig?.providers ?? [];
    const hubSources = presentation.serverConfig?.usageLimitSources ?? [];

    const hubAccounts: UsageLimitSourceAccount[] = [];
    for (const source of hubSources) {
      if (source.accounts) {
        for (const acc of source.accounts) {
          if (acc.driver === "antigravity") {
            hubAccounts.push(acc);
          }
        }
      }
    }

    const matchedHubIds = new Set<string>();

    for (const provider of providers) {
      if (provider.driver !== "antigravity") continue;

      const nativeFingerprint = provider.usageLimits?.credentialFingerprint;
      const matchedHub = nativeFingerprint
        ? hubAccounts.find((h) => h.usageLimits?.credentialFingerprint === nativeFingerprint)
        : undefined;

      if (matchedHub) {
        matchedHubIds.add(matchedHub.id);
      }

      const email = provider.auth?.email ?? matchedHub?.email;
      const plan = matchedHub?.plan;
      const families = groupWindowsIntoFamilies(provider.usageLimits?.windows ?? []);

      accounts.push({
        id: `${environmentId}:${provider.instanceId}`,
        environmentId,
        instanceId: provider.instanceId,
        driver: "antigravity",
        displayName: provider.displayName || provider.instanceId,
        email,
        plan,
        status: provider.status,
        enabled: provider.enabled,
        authStatus: provider.auth?.status,
        credentialFingerprint: nativeFingerprint,
        environmentLabel: envLabel,
        isHubOnly: false,
        models: (provider.models ?? []).map((m) => ({
          id:
            (m as { slug?: string; id?: string }).slug ??
            (m as { slug?: string; id?: string }).id ??
            "",
          name: m.name,
        })),
        families,
        usageLimits: provider.usageLimits,
        unavailableMessage: provider.usageLimits?.unavailable?.message ?? provider.message,
      });
    }

    for (const hub of hubAccounts) {
      if (matchedHubIds.has(hub.id)) continue;
      const families = groupWindowsIntoFamilies(hub.usageLimits?.windows ?? []);
      accounts.push({
        id: `hub:${environmentId}:${hub.id}`,
        environmentId,
        instanceId: undefined,
        driver: "antigravity",
        displayName: hub.email ? `Hub (${hub.email})` : `Hub (${hub.id})`,
        email: hub.email,
        plan: hub.plan,
        status: "hub_read_only",
        enabled: true,
        credentialFingerprint: hub.usageLimits?.credentialFingerprint,
        environmentLabel: `${envLabel} (CLI Proxy)`,
        isHubOnly: true,
        models: (hub.models ?? []).map((id) => ({ id })),
        families,
        usageLimits: hub.usageLimits,
        unavailableMessage: hub.usageLimits?.unavailable?.message,
      });
    }
  }

  return accounts;
}

export function selectActivationModel(
  providerModels: ReadonlyArray<string | { readonly id: string }>,
  familyKey: string,
  preferredModelOverride?: string,
): string | null {
  const modelIds = providerModels.map((m) => (typeof m === "string" ? m : m.id));
  if (modelIds.length === 0) return null;

  if (preferredModelOverride && modelIds.includes(preferredModelOverride)) {
    return preferredModelOverride;
  }

  const normalizedFamily = familyKey.toLowerCase();

  if (normalizedFamily === "gemini-argon") {
    const argon = modelIds.find((id) => id.toLowerCase().includes("argon"));
    if (argon) return argon;
  } else if (normalizedFamily === "gemini-carbon") {
    const carbon = modelIds.find((id) => id.toLowerCase().includes("carbon"));
    if (carbon) return carbon;
  } else if (normalizedFamily === "3p") {
    const haiku = modelIds.find((id) => id.toLowerCase().includes("haiku"));
    if (haiku) return haiku;
    const gptOss = modelIds.find((id) => id.toLowerCase().includes("gpt-oss"));
    if (gptOss) return gptOss;
    const sonnet = modelIds.find((id) => id.toLowerCase().includes("sonnet"));
    if (sonnet) return sonnet;
    const claude = modelIds.find((id) => id.toLowerCase().includes("claude"));
    if (claude) return claude;
    const gpt = modelIds.find((id) => id.toLowerCase().includes("gpt"));
    if (gpt) return gpt;
  } else if (normalizedFamily === "gemini") {
    const exactFlash = modelIds.find((id) => id === "gemini-3.8-flash");
    if (exactFlash) return exactFlash;
    const anyFlash = modelIds.find(
      (id) =>
        id.toLowerCase().includes("flash") &&
        !id.toLowerCase().includes("argon") &&
        !id.toLowerCase().includes("carbon"),
    );
    if (anyFlash) return anyFlash;
    const anyGemini = modelIds.find(
      (id) =>
        id.toLowerCase().startsWith("gemini") &&
        !id.toLowerCase().includes("argon") &&
        !id.toLowerCase().includes("carbon"),
    );
    if (anyGemini) return anyGemini;
  }

  return modelIds[0] ?? null;
}

function isQuietHours(
  quietHours: { readonly enabled: boolean; readonly startHour: number; readonly endHour: number },
  nowMs: number,
): boolean {
  if (!quietHours.enabled) return false;
  const hour = new Date(nowMs).getHours();
  if (quietHours.startHour <= quietHours.endHour) {
    return hour >= quietHours.startHour && hour < quietHours.endHour;
  }
  return hour >= quietHours.startHour || hour < quietHours.endHour;
}

export function findActivationTargets(
  accounts: ReadonlyArray<AntigravityAccount>,
  config: AntigravityGuardConfig & { readonly enabled?: boolean | undefined },
  history: ReadonlyArray<AntigravityActivationLogEntry>,
  nowMs: number,
): ReadonlyArray<ActivationTarget> {
  const isEnabled = config.globalAutoActivate ?? config.enabled ?? false;
  if (!isEnabled) return [];

  if (config.quietHours && isQuietHours(config.quietHours, nowMs)) {
    return [];
  }

  const cooldownMs = (config.cooldownMinutes ?? 30) * 60 * 1000;
  const targets: ActivationTarget[] = [];

  for (const account of accounts) {
    if (account.isHubOnly) continue;
    if (!account.enabled || account.status !== "ready") continue;
    if (!account.instanceId) continue;

    const accountConfig =
      config.accounts?.[`${account.environmentId}:${account.instanceId}`] ??
      config.accounts?.[account.id];

    if (!accountConfig?.autoActivate) continue;

    const guardedFamilies =
      accountConfig.guardedFamilies && accountConfig.guardedFamilies.length > 0
        ? accountConfig.guardedFamilies
        : ["gemini"];

    for (const familyKey of guardedFamilies) {
      const lastActivation = history
        .filter(
          (entry) =>
            entry.environmentId === account.environmentId &&
            entry.instanceId === account.instanceId &&
            entry.familyKey === familyKey,
        )
        .sort((a, b) => b.timestamp - a.timestamp)[0];

      if (lastActivation && nowMs - lastActivation.timestamp < cooldownMs) {
        continue;
      }

      const familySlots = account.families.get(familyKey);
      if (!familySlots) continue;

      const fiveHourState = classifyQuotaWindow(familySlots.fiveHour, nowMs);
      const weeklyState = classifyQuotaWindow(familySlots.weekly, nowMs);

      let reason: string | null = null;
      if (fiveHourState === "unactivated") {
        reason = "5-hour window unactivated";
      } else if (fiveHourState === "reset_ready") {
        reason = "5-hour window reset ready";
      } else if (weeklyState === "unactivated") {
        reason = "weekly window unactivated";
      } else if (weeklyState === "reset_ready") {
        reason = "weekly window reset ready";
      }

      if (!reason) continue;

      const override = accountConfig.preferredModelOverride?.[familyKey];
      const model = selectActivationModel(account.models, familyKey, override);
      if (!model) continue;

      targets.push({
        account,
        familyKey,
        model,
        reason,
      });
    }
  }

  return targets;
}

export function buildNasKeepaliveScheduleInput(
  params: NasKeepaliveScheduleParams,
): ScheduledTaskUpsertInput {
  return {
    ...(params.existingTaskId ? { id: params.existingTaskId } : {}),
    title: `${NAS_KEEPALIVE_PREFIX} ${params.accountLabel} (${params.familyKey})`,
    prompt: "Reply with OK.",
    enabled: true,
    schedule: {
      type: "interval",
      everyMs: NAS_KEEPALIVE_INTERVAL_MS,
    },
    projectId: params.projectId,
    threadId: null,
    threadMode: "new_thread",
    workspaceStrategy: { type: "root" },
    modelSelection: {
      instanceId: params.instanceId,
      model: params.model,
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    creationSource: "web",
  };
}

export function isNasKeepaliveTask(task: ScheduledTask): boolean {
  return task.title.startsWith(NAS_KEEPALIVE_PREFIX);
}
