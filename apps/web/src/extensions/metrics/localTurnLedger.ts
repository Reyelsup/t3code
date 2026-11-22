import type { LocalTurnLedgerRecord } from "./types";

export const TURN_LEDGER_STORAGE_KEY = "t3code:custom-metrics:turn-ledger:v1";
export const TURN_LEDGER_MAX_RECORDS = 2000;

type Listener = () => void;

const EMPTY: readonly LocalTurnLedgerRecord[] = [];
const listeners = new Set<Listener>();
let cachedRaw: string | null | undefined;
let snapshot: readonly LocalTurnLedgerRecord[] = EMPTY;
let watchingStorage = false;
// Set once a write is rejected: the in-memory ledger stays authoritative for this session.
let diverged = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return storage()?.getItem(TURN_LEDGER_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(value: string): boolean {
  try {
    const target = storage();
    if (target === null) return false;
    target.setItem(TURN_LEDGER_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function isLedgerRecord(value: unknown): value is LocalTurnLedgerRecord {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["turnId"] === "string" &&
    typeof entry["environmentId"] === "string" &&
    typeof entry["threadId"] === "string" &&
    typeof entry["recordedAt"] === "string" &&
    typeof entry["totalTokens"] === "number" &&
    Number.isFinite(entry["totalTokens"])
  );
}

function parseRecords(raw: string | null): readonly LocalTurnLedgerRecord[] {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const records: LocalTurnLedgerRecord[] = [];
    for (const entry of parsed) {
      if (isLedgerRecord(entry)) records.push(entry);
    }
    return records;
  } catch {
    return EMPTY;
  }
}

function recordedAtMs(record: LocalTurnLedgerRecord): number {
  const ms = Date.parse(record.recordedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function preferRecord(
  current: LocalTurnLedgerRecord,
  incoming: LocalTurnLedgerRecord,
): LocalTurnLedgerRecord {
  if (incoming.totalTokens !== current.totalTokens) {
    return incoming.totalTokens > current.totalTokens ? incoming : current;
  }
  return recordedAtMs(incoming) > recordedAtMs(current) ? incoming : current;
}

/** Merges by `turnId`, keeping the richer record, then drops the oldest beyond the cap. */
export function mergeTurnLedgerRecords(
  existing: readonly LocalTurnLedgerRecord[],
  incoming: readonly LocalTurnLedgerRecord[],
): readonly LocalTurnLedgerRecord[] {
  const byTurnId = new Map<string, LocalTurnLedgerRecord>();
  for (const record of existing) byTurnId.set(record.turnId, record);
  for (const record of incoming) {
    const current = byTurnId.get(record.turnId);
    byTurnId.set(record.turnId, current === undefined ? record : preferRecord(current, record));
  }
  const merged = [...byTurnId.values()].sort(
    (left, right) => recordedAtMs(left) - recordedAtMs(right),
  );
  return merged.length > TURN_LEDGER_MAX_RECORDS
    ? merged.slice(merged.length - TURN_LEDGER_MAX_RECORDS)
    : merged;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function watchStorage(): void {
  if (watchingStorage || typeof window === "undefined") return;
  watchingStorage = true;
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== TURN_LEDGER_STORAGE_KEY) return;
    notify();
  });
}

/** Stable snapshot for `useSyncExternalStore`; re-parsed only when the stored text changes. */
export function readTurnLedger(): readonly LocalTurnLedgerRecord[] {
  if (diverged) return snapshot;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    snapshot = parseRecords(raw);
  }
  return snapshot;
}

export function subscribeTurnLedger(listener: Listener): () => void {
  listeners.add(listener);
  watchStorage();
  return () => {
    listeners.delete(listener);
  };
}

export function upsertTurnLedgerRecords(records: readonly LocalTurnLedgerRecord[]): void {
  if (records.length === 0) return;
  const current = readTurnLedger();
  const merged = mergeTurnLedgerRecords(current, records);
  const unchanged =
    merged.length === current.length && merged.every((record, index) => record === current[index]);
  if (unchanged) return;
  const serialized = JSON.stringify(merged);
  snapshot = merged;
  cachedRaw = serialized;
  diverged = !writeRaw(serialized);
  notify();
}

export function clearTurnLedger(): void {
  snapshot = EMPTY;
  cachedRaw = null;
  diverged = false;
  try {
    storage()?.removeItem(TURN_LEDGER_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  notify();
}
