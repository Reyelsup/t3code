import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearTurnLedger,
  mergeTurnLedgerRecords,
  readTurnLedger,
  subscribeTurnLedger,
  TURN_LEDGER_MAX_RECORDS,
  TURN_LEDGER_STORAGE_KEY,
  upsertTurnLedgerRecords,
} from "./localTurnLedger";
import type { LocalTurnLedgerRecord } from "./types";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("thread-test");

function record(turnId: string, totalTokens: number, recordedAt: string): LocalTurnLedgerRecord {
  return {
    turnId,
    environmentId,
    threadId,
    providerInstanceId: null,
    driver: null,
    model: null,
    inputTokens: totalTokens,
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    durationMs: null,
    ttftMs: null,
    outputTokensPerSec: null,
    recordedAt,
  };
}

const iso = (second: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, second)).toISOString();

function stubWindow(initial: ReadonlyArray<readonly [string, string]> = []) {
  const store = new Map<string, string>(initial);
  const localStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage, addEventListener: () => {} });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearTurnLedger();
});

describe("readTurnLedger", () => {
  it("reads an empty ledger without storage", () => {
    expect(readTurnLedger()).toEqual([]);
  });

  it("ignores corrupted storage", () => {
    stubWindow([[TURN_LEDGER_STORAGE_KEY, "{not json"]]);
    expect(readTurnLedger()).toEqual([]);
  });

  it("ignores a stored value that is not an array", () => {
    stubWindow([[TURN_LEDGER_STORAGE_KEY, JSON.stringify({ turnId: "turn-1" })]]);
    expect(readTurnLedger()).toEqual([]);
  });

  it("drops malformed entries and keeps the rest", () => {
    stubWindow([
      [
        TURN_LEDGER_STORAGE_KEY,
        JSON.stringify([record("turn-1", 100, iso(1)), { turnId: "turn-2" }, null]),
      ],
    ]);

    expect(readTurnLedger().map((entry) => entry.turnId)).toEqual(["turn-1"]);
  });
});

describe("upsertTurnLedgerRecords", () => {
  it("persists records and reads them back", () => {
    const store = stubWindow();

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1)), record("turn-2", 200, iso(2))]);

    expect(readTurnLedger().map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(JSON.parse(store.get(TURN_LEDGER_STORAGE_KEY) ?? "[]")).toHaveLength(2);
  });

  it("keeps the richer record for a repeated turn", () => {
    stubWindow();

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);
    upsertTurnLedgerRecords([record("turn-1", 250, iso(2))]);
    upsertTurnLedgerRecords([record("turn-1", 150, iso(3))]);

    expect(readTurnLedger()).toHaveLength(1);
    expect(readTurnLedger()[0]?.totalTokens).toBe(250);
  });

  it("prefers the newer record when token counts tie", () => {
    stubWindow();

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);
    upsertTurnLedgerRecords([record("turn-1", 100, iso(5))]);

    expect(readTurnLedger()[0]?.recordedAt).toBe(iso(5));
  });

  it("keeps only the most recent records", () => {
    stubWindow();
    const records = Array.from({ length: TURN_LEDGER_MAX_RECORDS + 5 }, (_, index) =>
      record(`turn-${index}`, index + 1, iso(index)),
    );

    upsertTurnLedgerRecords(records);

    const ledger = readTurnLedger();
    expect(ledger).toHaveLength(TURN_LEDGER_MAX_RECORDS);
    expect(ledger[0]?.turnId).toBe("turn-5");
    expect(ledger.at(-1)?.turnId).toBe(`turn-${TURN_LEDGER_MAX_RECORDS + 4}`);
  });

  it("keeps the in-memory ledger when storage rejects the write", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
        removeItem: () => {},
      },
      addEventListener: () => {},
    });

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);

    expect(readTurnLedger().map((entry) => entry.turnId)).toEqual(["turn-1"]);
  });

  it("does nothing for an empty batch", () => {
    const store = stubWindow();

    upsertTurnLedgerRecords([]);

    expect(store.size).toBe(0);
  });
});

describe("subscribeTurnLedger", () => {
  it("notifies on writes and clears", () => {
    stubWindow();
    const listener = vi.fn();
    const unsubscribe = subscribeTurnLedger(listener);

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);
    expect(listener).toHaveBeenCalledTimes(1);

    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);
    expect(listener).toHaveBeenCalledTimes(1);

    clearTurnLedger();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    upsertTurnLedgerRecords([record("turn-2", 100, iso(2))]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("clearTurnLedger", () => {
  it("empties the stored ledger", () => {
    const store = stubWindow();
    upsertTurnLedgerRecords([record("turn-1", 100, iso(1))]);

    clearTurnLedger();

    expect(store.has(TURN_LEDGER_STORAGE_KEY)).toBe(false);
    expect(readTurnLedger()).toEqual([]);
  });
});

describe("mergeTurnLedgerRecords", () => {
  it("orders the merged ledger by recorded time", () => {
    const merged = mergeTurnLedgerRecords(
      [record("turn-2", 100, iso(2))],
      [record("turn-1", 100, iso(1)), record("turn-3", 100, iso(3))],
    );

    expect(merged.map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2", "turn-3"]);
  });
});
