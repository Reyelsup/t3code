import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const ANTIGRAVITY_GUARD_STORAGE_KEY = "t3code:custom-metrics:antigravity-guard:v1";
const ANTIGRAVITY_LOG_STORAGE_KEY = "t3code:custom-metrics:antigravity-guard:log:v1";
const MAX_ACTIVATION_LOG_ENTRIES = 100;

export interface AntigravityAccountConfig {
  readonly autoActivate: boolean;
  readonly guardedFamilies: ReadonlyArray<string>;
  readonly preferredModelOverride?: Readonly<Record<string, string>> | undefined;
}

export interface AntigravityGuardConfig {
  readonly globalAutoActivate: boolean;
  readonly checkIntervalMinutes: number;
  readonly cooldownMinutes: number;
  readonly autoArchiveWarmupThread: boolean;
  readonly warmupPrompt: string;
  readonly quietHours?:
    | {
        readonly enabled: boolean;
        readonly startHour: number;
        readonly endHour: number;
      }
    | undefined;
  readonly accounts: Readonly<Record<string, AntigravityAccountConfig>>;
}

export interface AntigravityActivationLogEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly environmentId: EnvironmentId;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly accountLabel: string;
  readonly familyKey: string;
  readonly model: string;
  readonly trigger: "manual" | "auto";
  readonly outcome: "success" | "error";
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly threadId?: ThreadId | undefined;
}

const DEFAULT_ANTIGRAVITY_GUARD_CONFIG: AntigravityGuardConfig = {
  globalAutoActivate: false,
  checkIntervalMinutes: 5,
  cooldownMinutes: 30,
  autoArchiveWarmupThread: true,
  warmupPrompt: "Reply with OK.",
  accounts: {},
};

type Listener = () => void;

const configListeners = new Set<Listener>();
const logListeners = new Set<Listener>();

let cachedConfigRaw: string | null | undefined;
let configSnapshot: AntigravityGuardConfig = DEFAULT_ANTIGRAVITY_GUARD_CONFIG;

let cachedLogRaw: string | null | undefined;
let logSnapshot: ReadonlyArray<AntigravityActivationLogEntry> = [];

let watchingStorage = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function notifyConfig(): void {
  for (const listener of configListeners) listener();
}

function notifyLog(): void {
  for (const listener of logListeners) listener();
}

function watchStorage(): void {
  if (watchingStorage || typeof window === "undefined") return;
  watchingStorage = true;
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === ANTIGRAVITY_GUARD_STORAGE_KEY) {
      cachedConfigRaw = undefined;
      notifyConfig();
    }
    if (event.key === null || event.key === ANTIGRAVITY_LOG_STORAGE_KEY) {
      cachedLogRaw = undefined;
      notifyLog();
    }
  });
}

function parseConfig(raw: string | null): AntigravityGuardConfig {
  if (raw === null) return DEFAULT_ANTIGRAVITY_GUARD_CONFIG;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_ANTIGRAVITY_GUARD_CONFIG;
    const obj = parsed as Record<string, unknown>;
    return {
      globalAutoActivate:
        typeof obj["globalAutoActivate"] === "boolean" ? obj["globalAutoActivate"] : false,
      checkIntervalMinutes:
        typeof obj["checkIntervalMinutes"] === "number"
          ? Math.max(1, obj["checkIntervalMinutes"])
          : 5,
      cooldownMinutes:
        typeof obj["cooldownMinutes"] === "number" ? Math.max(1, obj["cooldownMinutes"]) : 30,
      autoArchiveWarmupThread:
        typeof obj["autoArchiveWarmupThread"] === "boolean" ? obj["autoArchiveWarmupThread"] : true,
      warmupPrompt:
        typeof obj["warmupPrompt"] === "string" ? obj["warmupPrompt"] : "Reply with OK.",
      quietHours:
        typeof obj["quietHours"] === "object" && obj["quietHours"] !== null
          ? {
              enabled: Boolean((obj["quietHours"] as Record<string, unknown>)["enabled"]),
              startHour: Number((obj["quietHours"] as Record<string, unknown>)["startHour"]) || 0,
              endHour: Number((obj["quietHours"] as Record<string, unknown>)["endHour"]) || 0,
            }
          : undefined,
      accounts:
        typeof obj["accounts"] === "object" && obj["accounts"] !== null
          ? (obj["accounts"] as Record<string, AntigravityAccountConfig>)
          : {},
    };
  } catch {
    return DEFAULT_ANTIGRAVITY_GUARD_CONFIG;
  }
}

function isLogEntry(value: unknown): value is AntigravityActivationLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["id"] === "string" &&
    typeof entry["timestamp"] === "number" &&
    typeof entry["environmentId"] === "string" &&
    typeof entry["accountLabel"] === "string" &&
    typeof entry["familyKey"] === "string" &&
    typeof entry["model"] === "string" &&
    (entry["trigger"] === "manual" || entry["trigger"] === "auto") &&
    (entry["outcome"] === "success" || entry["outcome"] === "error")
  );
}

function parseLogs(raw: string | null): ReadonlyArray<AntigravityActivationLogEntry> {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: AntigravityActivationLogEntry[] = [];
    for (const item of parsed) {
      if (isLogEntry(item)) entries.push(item);
    }
    return entries;
  } catch {
    return [];
  }
}

export function readAntigravityGuardConfig(): AntigravityGuardConfig {
  watchStorage();
  const raw = readRaw(ANTIGRAVITY_GUARD_STORAGE_KEY);
  if (raw !== cachedConfigRaw) {
    cachedConfigRaw = raw;
    configSnapshot = parseConfig(raw);
  }
  return configSnapshot;
}

function subscribeAntigravityGuardConfig(listener: Listener): () => void {
  configListeners.add(listener);
  watchStorage();
  return () => {
    configListeners.delete(listener);
  };
}

function updateAntigravityGuardConfig(
  updater: (current: AntigravityGuardConfig) => AntigravityGuardConfig,
): AntigravityGuardConfig {
  const current = readAntigravityGuardConfig();
  const next = updater(current);
  const serialized = JSON.stringify(next);
  writeRaw(ANTIGRAVITY_GUARD_STORAGE_KEY, serialized);
  cachedConfigRaw = serialized;
  configSnapshot = next;
  notifyConfig();
  return next;
}

export function readAntigravityActivationLog(): ReadonlyArray<AntigravityActivationLogEntry> {
  watchStorage();
  const raw = readRaw(ANTIGRAVITY_LOG_STORAGE_KEY);
  if (raw !== cachedLogRaw) {
    cachedLogRaw = raw;
    logSnapshot = parseLogs(raw);
  }
  return logSnapshot;
}

function subscribeAntigravityActivationLog(listener: Listener): () => void {
  logListeners.add(listener);
  watchStorage();
  return () => {
    logListeners.delete(listener);
  };
}

export function appendActivationLog(
  entry: Omit<AntigravityActivationLogEntry, "id" | "timestamp"> & {
    readonly id?: string | undefined;
    readonly timestamp?: number | undefined;
  },
): AntigravityActivationLogEntry {
  const fullEntry: AntigravityActivationLogEntry = {
    ...entry,
    id: entry.id ?? `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp ?? Date.now(),
  };

  const current = readAntigravityActivationLog();
  const next = [fullEntry, ...current].slice(0, MAX_ACTIVATION_LOG_ENTRIES);
  const serialized = JSON.stringify(next);
  writeRaw(ANTIGRAVITY_LOG_STORAGE_KEY, serialized);
  cachedLogRaw = serialized;
  logSnapshot = next;
  notifyLog();
  return fullEntry;
}

function clearActivationLog(): void {
  writeRaw(ANTIGRAVITY_LOG_STORAGE_KEY, "[]");
  cachedLogRaw = "[]";
  logSnapshot = [];
  notifyLog();
}

export function useAntigravityGuardConfig(): readonly [
  AntigravityGuardConfig,
  (updater: (current: AntigravityGuardConfig) => AntigravityGuardConfig) => void,
] {
  const config = useSyncExternalStore(
    subscribeAntigravityGuardConfig,
    readAntigravityGuardConfig,
    readAntigravityGuardConfig,
  );
  return [config, updateAntigravityGuardConfig] as const;
}

export function useAntigravityActivationLog(): readonly [
  ReadonlyArray<AntigravityActivationLogEntry>,
  () => void,
] {
  const log = useSyncExternalStore(
    subscribeAntigravityActivationLog,
    readAntigravityActivationLog,
    readAntigravityActivationLog,
  );
  return [log, clearActivationLog] as const;
}
