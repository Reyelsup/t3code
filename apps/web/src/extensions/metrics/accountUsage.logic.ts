import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerSettings,
  UsageBucket,
  UsageProviderKind,
  UsageSummaryInput,
} from "@t3tools/contracts";

import { PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import type { EnvironmentUsageStatus } from "../../state/usage";
import type { LocalTurnLedgerRecord } from "./types";

export type AccountUsageSource = "server-scan" | "live-ledger" | "hybrid";

export interface AccountModelUsage {
  readonly model: string;
  readonly totalTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly cacheHitRate: number | null;
}

export interface AccountDailyUsage {
  readonly day: string;
  readonly totalTokens: number;
  readonly costUsd: number;
}

export interface AccountUsage {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
  readonly providerKind: UsageProviderKind | null;
  readonly displayName: string;
  readonly accentColor: string | undefined;
  readonly email: string | undefined;
  readonly source: AccountUsageSource;
  readonly unattributed: boolean;
  readonly totalTokens: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheHitRate: number | null;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly sessions: number;
  readonly records: number;
  readonly avgOutputTokensPerSec: number | null;
  readonly avgTtftMs: number | null;
  readonly observedTurns: number;
  readonly models: readonly AccountModelUsage[];
  readonly daily: readonly AccountDailyUsage[];
  readonly usageLimits: ServerProviderUsageLimits | null;
}

export interface AccountUsageTotals {
  readonly totalAccounts: number;
  readonly totalTokens: number;
  readonly totalInputTokens: number;
  readonly totalCachedInputTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly totalOutputTokens: number;
  readonly totalReasoningTokens: number;
  readonly overallCacheHitRate: number | null;
  readonly totalCostUsd: number;
  readonly totalCacheSavingsUsd: number;
  readonly weightedAvgSpeed: number | null;
}

export interface AccountUsageReport {
  readonly accounts: readonly AccountUsage[];
  readonly totals: AccountUsageTotals;
}

export interface AccountUsageInput {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, readonly ServerProvider[]>;
  /** Only `providerInstances` is read: instance env vars add home-path hints beyond `runtimePaths`. */
  readonly settingsByEnvironment?: ReadonlyMap<
    EnvironmentId,
    Pick<ServerSettings, "providerInstances"> | null
  >;
  readonly ledgerRecords: readonly LocalTurnLedgerRecord[];
  readonly window: UsageSummaryInput;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
}

/** Env var names adapters honor as their data/home directory, independent of driver. */
const HOME_PATH_ENV_VARS: ReadonlySet<string> = new Set([
  "ANTIGRAVITY_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "PI_CODING_AGENT_DIR",
  "XDG_DATA_HOME",
]);

const CONFIG_HOME_KEYS: ReadonlySet<string> = new Set([
  "home",
  "homeDir",
  "homePath",
  "homeDirectory",
]);

const PROVIDER_KINDS = Object.keys(PROVIDER_PRESENTATION) as readonly UsageProviderKind[];

const PROVIDER_KIND_BY_DRIVER: ReadonlyMap<ProviderDriverKind, UsageProviderKind> = new Map(
  PROVIDER_KINDS.map((kind) => [PROVIDER_PRESENTATION[kind].driverKind, kind]),
);

export function providerKindForDriver(driver: ProviderDriverKind): UsageProviderKind | null {
  return PROVIDER_KIND_BY_DRIVER.get(driver) ?? null;
}

function normalizeUsagePath(path: string): string {
  let normalized = path.trim().replaceAll("\\", "/");
  while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  // Case-insensitive: the two sides of a Windows transcript path disagree about drive casing.
  return normalized.toLowerCase();
}

/** Exact or containment either way; the score is the matched length, so the most specific candidate wins. */
function matchDepth(sourcePath: string, candidatePath: string): number | null {
  if (sourcePath === candidatePath) return Number.MAX_SAFE_INTEGER;
  if (sourcePath.startsWith(`${candidatePath}/`)) return candidatePath.length;
  if (candidatePath.startsWith(`${sourcePath}/`)) return sourcePath.length;
  return null;
}

const UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC",
});

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = dayFormatters.get(timeZone);
  if (existing !== undefined) return existing;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    });
  } catch {
    return UTC_DAY_FORMATTER;
  }
  if (dayFormatters.size >= 16) dayFormatters.clear();
  dayFormatters.set(timeZone, formatter);
  return formatter;
}

function localDay(atMs: number, timeZone: string): string {
  return dayFormatter(timeZone).format(atMs);
}

function ledgerRecordWithinWindow(
  record: LocalTurnLedgerRecord,
  window: UsageSummaryInput,
): boolean {
  const at = Date.parse(record.recordedAt);
  if (Number.isNaN(at)) return false;
  if (window.sinceTime !== undefined && window.untilTime !== undefined) {
    return at >= Date.parse(window.sinceTime) && at < Date.parse(window.untilTime);
  }
  const day = localDay(at, window.timeZone);
  return day >= window.sinceDay && day <= window.untilDay;
}

interface TokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

function tokenTotal(tokens: TokenTotals): number {
  return (
    tokens.uncachedInputTokens +
    tokens.cachedInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens
  );
}

function inputTotal(tokens: TokenTotals): number {
  return tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
}

function cacheHitRateOf(tokens: TokenTotals): number | null {
  const input = inputTotal(tokens);
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

interface TokenCounter {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function emptyCounter(): TokenCounter {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function addTokens(counter: TokenCounter, tokens: TokenTotals): void {
  counter.uncachedInputTokens += tokens.uncachedInputTokens;
  counter.cachedInputTokens += tokens.cachedInputTokens;
  counter.cacheCreationTokens += tokens.cacheCreationTokens;
  counter.outputTokens += tokens.outputTokens;
  counter.reasoningTokens += tokens.reasoningTokens;
}

interface ModelCounter extends TokenCounter {
  readonly model: string;
  costUsd: number;
}

function countModel(models: Map<string, ModelCounter>, model: string | null): ModelCounter {
  const key = model?.trim() || "Unknown model";
  let counter = models.get(key);
  if (counter === undefined) {
    counter = { ...emptyCounter(), model: key, costUsd: 0 };
    models.set(key, counter);
  }
  return counter;
}

interface DayCounter {
  totalTokens: number;
  costUsd: number;
}

function countDay(
  days: Map<string, DayCounter>,
  day: string,
  totalTokens: number,
  costUsd: number,
) {
  const counter = days.get(day);
  if (counter === undefined) days.set(day, { totalTokens, costUsd });
  else {
    counter.totalTokens += totalTokens;
    counter.costUsd += costUsd;
  }
}

function finalizeModels(models: Map<string, ModelCounter>): readonly AccountModelUsage[] {
  return [...models.values()]
    .map((counter) => ({
      model: counter.model,
      totalTokens: tokenTotal(counter),
      uncachedInputTokens: counter.uncachedInputTokens,
      cachedInputTokens: counter.cachedInputTokens,
      cacheCreationTokens: counter.cacheCreationTokens,
      outputTokens: counter.outputTokens,
      reasoningTokens: counter.reasoningTokens,
      costUsd: counter.costUsd,
      cacheHitRate: cacheHitRateOf(counter),
    }))
    .toSorted(
      (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
    );
}

function finalizeDaily(days: Map<string, DayCounter>): readonly AccountDailyUsage[] {
  return [...days.entries()]
    .map(([day, counter]) => ({ day, ...counter }))
    .toSorted((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0));
}

interface AccountAccumulator {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
  readonly providerKind: UsageProviderKind | null;
  readonly provider: ServerProvider | null;
  readonly unattributed: boolean;
  readonly serverTokens: TokenCounter;
  readonly serverModels: Map<string, ModelCounter>;
  readonly serverDaily: Map<string, DayCounter>;
  costUsd: number;
  cacheSavingsUsd: number;
  sessions: number;
  records: number;
  source: AccountUsageSource;
  readonly usageLimits: ServerProviderUsageLimits | null;
  readonly speeds: number[];
  readonly ttfts: number[];
  observedTurns: number;
  ledger: {
    readonly tokens: TokenTotals;
    readonly models: Map<string, ModelCounter>;
    readonly daily: Map<string, DayCounter>;
    readonly threads: ReadonlySet<string>;
    readonly turns: number;
  } | null;
}

interface AccountInit {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | null;
  readonly providerKind: UsageProviderKind | null;
  readonly provider: ServerProvider | null;
  readonly unattributed: boolean;
}

function newAccount(init: AccountInit): AccountAccumulator {
  return {
    ...init,
    serverTokens: emptyCounter(),
    serverModels: new Map(),
    serverDaily: new Map(),
    costUsd: 0,
    cacheSavingsUsd: 0,
    sessions: 0,
    records: 0,
    source: "server-scan",
    usageLimits: init.provider?.usageLimits ?? null,
    speeds: [],
    ttfts: [],
    observedTurns: 0,
    ledger: null,
  };
}

function accountDisplayName(
  provider: ServerProvider | null,
  driver: ProviderDriverKind | null,
  providerKind: UsageProviderKind | null,
): string {
  if (provider?.displayName !== undefined) return provider.displayName;
  if (providerKind !== null) return PROVIDER_PRESENTATION[providerKind].label;
  if (driver !== null) return driver;
  // oxlint-disable-next-line t3code/no-untranslated-copy -- last-resort label for a ledger turn with no driver info
  return "Unknown account";
}

interface ProviderInstanceInfo {
  readonly provider: ServerProvider;
  readonly candidatePaths: readonly string[];
}

function configHomePaths(config: unknown): readonly string[] {
  if (config === null || typeof config !== "object") return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (
      (CONFIG_HOME_KEYS.has(key) || HOME_PATH_ENV_VARS.has(key)) &&
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      paths.push(value);
    }
  }
  return paths;
}

function instanceCandidatePaths(
  provider: ServerProvider,
  settings: Pick<ServerSettings, "providerInstances"> | null | undefined,
): readonly string[] {
  const paths = new Set<string>();
  const push = (path: string | undefined) => {
    if (path !== undefined && path.trim() !== "") paths.add(normalizeUsagePath(path));
  };
  push(provider.runtimePaths?.homePath);
  push(provider.runtimePaths?.shadowHomePath ?? undefined);
  const instance = settings?.providerInstances[provider.instanceId];
  for (const variable of instance?.environment ?? []) {
    if (HOME_PATH_ENV_VARS.has(variable.name) && typeof variable.value === "string") {
      push(variable.value);
    }
  }
  for (const path of configHomePaths(instance?.config)) push(path);
  return [...paths];
}

function groupInstancesByDriver(
  providers: readonly ServerProvider[],
  settings: Pick<ServerSettings, "providerInstances"> | null | undefined,
  driver: ProviderDriverKind,
): readonly ProviderInstanceInfo[] {
  return providers
    .filter((provider) => provider.driver === driver && provider.enabled)
    .map((provider) => ({ provider, candidatePaths: instanceCandidatePaths(provider, settings) }));
}

/**
 * Longest-prefix match across enabled instances of the driver, with a single-instance fallback
 * when the bucket carries no usable path.
 */
function attributeBucket(
  bucket: UsageBucket,
  instances: readonly ProviderInstanceInfo[],
): ServerProvider | null {
  const sourcePath = bucket.sourcePath === undefined ? null : normalizeUsagePath(bucket.sourcePath);
  if (sourcePath !== null) {
    let best: { instance: ProviderInstanceInfo; depth: number } | null = null;
    for (const instance of instances) {
      for (const path of instance.candidatePaths) {
        const depth = matchDepth(sourcePath, path);
        if (depth !== null && (best === null || depth > best.depth)) {
          best = { instance, depth };
        }
      }
    }
    if (best !== null) return best.instance.provider;
  }
  return instances.length === 1 ? (instances[0]?.provider ?? null) : null;
}

interface LedgerAggregate {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | null;
  readonly driver: ProviderDriverKind | null;
  readonly tokens: TokenCounter;
  readonly models: Map<string, ModelCounter>;
  readonly daily: Map<string, DayCounter>;
  readonly speeds: number[];
  readonly ttfts: number[];
  readonly threads: Set<string>;
  turns: number;
}

export function buildAccountUsage(input: AccountUsageInput): AccountUsageReport {
  const {
    environments,
    providersByEnvironment,
    settingsByEnvironment,
    ledgerRecords,
    window,
    hiddenProviders,
  } = input;

  const accountsByKey = new Map<string, AccountAccumulator>();
  const accountFor = (init: AccountInit): AccountAccumulator => {
    let account = accountsByKey.get(init.key);
    if (account === undefined) {
      account = newAccount(init);
      accountsByKey.set(init.key, account);
    }
    return account;
  };

  for (const environment of environments) {
    const summary = environment.summary;
    if (summary === null) continue;
    const settings = settingsByEnvironment?.get(environment.environmentId) ?? null;
    for (const bucket of summary.buckets) {
      if (hiddenProviders.has(bucket.provider)) continue;
      const presentation = PROVIDER_PRESENTATION[bucket.provider];
      const instances = groupInstancesByDriver(
        providersByEnvironment.get(environment.environmentId) ?? [],
        settings,
        presentation.driverKind,
      );
      const provider = attributeBucket(bucket, instances);
      const account = accountFor({
        key:
          provider === null
            ? `${environment.environmentId}:unattributed:${bucket.provider}`
            : `${environment.environmentId}:${provider.instanceId}`,
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        instanceId: provider?.instanceId ?? null,
        driver: provider?.driver ?? presentation.driverKind,
        providerKind: bucket.provider,
        provider,
        unattributed: provider === null,
      });
      addTokens(account.serverTokens, bucket.totals);
      account.costUsd += bucket.costUsd;
      account.cacheSavingsUsd += bucket.cacheSavingsUsd;
      account.sessions += bucket.sessions;
      account.records += bucket.records;
      const model = countModel(account.serverModels, bucket.model);
      addTokens(model, bucket.totals);
      model.costUsd += bucket.costUsd;
      countDay(account.serverDaily, bucket.day, tokenTotal(bucket.totals), bucket.costUsd);
    }
  }

  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const ledgerByKey = new Map<string, LedgerAggregate>();
  const seenTurns = new Set<string>();
  for (const record of ledgerRecords) {
    if (record.providerInstanceId === null) continue;
    if (!environmentById.has(record.environmentId)) continue;
    if (seenTurns.has(record.turnId)) continue;
    seenTurns.add(record.turnId);
    const recordKind =
      record.driver === null ? null : (PROVIDER_KIND_BY_DRIVER.get(record.driver) ?? null);
    if (recordKind !== null && hiddenProviders.has(recordKind)) continue;
    if (!ledgerRecordWithinWindow(record, window)) continue;
    const key = `${record.environmentId}::${record.providerInstanceId}`;
    let aggregate = ledgerByKey.get(key);
    if (aggregate === undefined) {
      const environment = environmentById.get(record.environmentId);
      const provider =
        (providersByEnvironment.get(record.environmentId) ?? []).find(
          (candidate) => candidate.instanceId === record.providerInstanceId,
        ) ?? null;
      aggregate = {
        environmentId: record.environmentId,
        environmentLabel: environment?.label ?? record.environmentId,
        instanceId: record.providerInstanceId,
        provider,
        driver: record.driver ?? provider?.driver ?? null,
        tokens: emptyCounter(),
        models: new Map(),
        daily: new Map(),
        speeds: [],
        ttfts: [],
        threads: new Set(),
        turns: 0,
      };
      ledgerByKey.set(key, aggregate);
    }
    aggregate.turns += 1;
    aggregate.threads.add(record.threadId);
    addTokens(aggregate.tokens, record);
    addTokens(countModel(aggregate.models, record.model), record);
    const at = Date.parse(record.recordedAt);
    countDay(aggregate.daily, localDay(at, window.timeZone), tokenTotal(record), 0);
    if (record.outputTokensPerSec !== null) aggregate.speeds.push(record.outputTokensPerSec);
    if (record.ttftMs !== null) aggregate.ttfts.push(record.ttftMs);
  }

  const attachedLedgerKeys = new Set<string>();
  for (const account of accountsByKey.values()) {
    if (account.instanceId === null) continue;
    const key = `${account.environmentId}::${account.instanceId}`;
    const aggregate = ledgerByKey.get(key);
    if (aggregate === undefined) continue;
    account.speeds.push(...aggregate.speeds);
    account.ttfts.push(...aggregate.ttfts);
    account.observedTurns = aggregate.turns;
    account.source = "hybrid";
    attachedLedgerKeys.add(key);
  }

  for (const [key, aggregate] of ledgerByKey) {
    if (attachedLedgerKeys.has(key)) continue;
    // Recorded later than server runs, ledger turns cover accounts whose transcripts were never
    // scanned; their tokens ride the live record instead of the bucket.
    const kind =
      aggregate.driver === null ? null : (PROVIDER_KIND_BY_DRIVER.get(aggregate.driver) ?? null);
    const account = accountFor({
      key: `${aggregate.environmentId}:${aggregate.instanceId}`,
      environmentId: aggregate.environmentId,
      environmentLabel: aggregate.environmentLabel,
      instanceId: aggregate.instanceId,
      driver: aggregate.driver,
      providerKind: kind,
      provider: aggregate.provider,
      unattributed: false,
    });
    account.source = "live-ledger";
    account.sessions = aggregate.threads.size;
    account.records = aggregate.turns;
    account.ledger = {
      tokens: aggregate.tokens,
      models: aggregate.models,
      daily: aggregate.daily,
      threads: aggregate.threads,
      turns: aggregate.turns,
    };
    account.speeds.push(...aggregate.speeds);
    account.ttfts.push(...aggregate.ttfts);
    account.observedTurns = aggregate.turns;
  }

  const accounts = [...accountsByKey.values()].map((account): AccountUsage => {
    const live = account.source === "live-ledger" ? account.ledger : null;
    const tokens: TokenTotals = live?.tokens ?? account.serverTokens;
    const models = live?.models ?? account.serverModels;
    const daily = live?.daily ?? account.serverDaily;
    return {
      key: account.key,
      environmentId: account.environmentId,
      environmentLabel: account.environmentLabel,
      instanceId: account.instanceId,
      driver: account.driver,
      providerKind: account.providerKind,
      displayName:
        account.unattributed && account.providerKind !== null
          ? `Unattributed (${PROVIDER_PRESENTATION[account.providerKind].label})`
          : accountDisplayName(account.provider, account.driver, account.providerKind),
      accentColor: account.provider?.accentColor,
      email: account.provider?.auth.email,
      source: account.source,
      unattributed: account.unattributed,
      totalTokens: tokenTotal(tokens),
      uncachedInputTokens: tokens.uncachedInputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
      outputTokens: tokens.outputTokens,
      reasoningTokens: tokens.reasoningTokens,
      cacheHitRate: cacheHitRateOf(tokens),
      costUsd: account.costUsd,
      cacheSavingsUsd: account.cacheSavingsUsd,
      sessions: account.sessions,
      records: account.records,
      avgOutputTokensPerSec:
        account.speeds.length === 0
          ? null
          : account.speeds.reduce((sum, speed) => sum + speed, 0) / account.speeds.length,
      avgTtftMs:
        account.ttfts.length === 0
          ? null
          : account.ttfts.reduce((sum, ttft) => sum + ttft, 0) / account.ttfts.length,
      observedTurns: account.observedTurns,
      models: finalizeModels(models),
      daily: finalizeDaily(daily),
      usageLimits: account.usageLimits,
    };
  });

  accounts.sort(
    (left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key),
  );

  return { accounts, totals: summarizeAccountUsage(accounts) };
}

export function summarizeAccountUsage(accounts: readonly AccountUsage[]): AccountUsageTotals {
  let totalUncachedInput = 0;
  let totalCachedInput = 0;
  let totalCacheCreation = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalCostUsd = 0;
  let totalCacheSavingsUsd = 0;
  let weightedSpeedSum = 0;
  let speedTokenSum = 0;
  for (const account of accounts) {
    totalUncachedInput += account.uncachedInputTokens;
    totalCachedInput += account.cachedInputTokens;
    totalCacheCreation += account.cacheCreationTokens;
    totalOutput += account.outputTokens;
    totalReasoning += account.reasoningTokens;
    totalCostUsd += account.costUsd;
    totalCacheSavingsUsd += account.cacheSavingsUsd;
    if (account.avgOutputTokensPerSec !== null && account.outputTokens > 0) {
      weightedSpeedSum += account.avgOutputTokensPerSec * account.outputTokens;
      speedTokenSum += account.outputTokens;
    }
  }
  const totalInputTokens = totalUncachedInput + totalCachedInput + totalCacheCreation;
  return {
    totalAccounts: accounts.length,
    totalTokens: totalInputTokens + totalOutput,
    totalInputTokens,
    totalCachedInputTokens: totalCachedInput,
    totalCacheCreationTokens: totalCacheCreation,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    overallCacheHitRate: totalInputTokens === 0 ? null : totalCachedInput / totalInputTokens,
    totalCostUsd,
    totalCacheSavingsUsd,
    weightedAvgSpeed: speedTokenSum === 0 ? null : weightedSpeedSum / speedTokenSum,
  };
}
