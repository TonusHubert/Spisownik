require("fake-indexeddb/auto");
const { randomUUID } = require("node:crypto");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const SpisownikSync = require("../sync.js");

function createMockDb({ rpcResults = {}, inventoryStatuses = {} } = {}) {
  const calls = { rpc: [], from: [] };
  return {
    calls,
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      const result = rpcResults[name];
      if (typeof result === "function") return result(args);
      return result || { error: null };
    },
    from(table) {
      calls.from.push(table);
      let filterId;
      return {
        select() { return this; },
        eq(_column, value) { filterId = value; return this; },
        async maybeSingle() {
          const status = inventoryStatuses[filterId];
          return { data: status ? { status } : null, error: null };
        },
      };
    },
  };
}

function makeEngine(overrides = {}) {
  const dbName = overrides.dbName || `spisownik-offline-test-${randomUUID()}`;
  let isOnline = overrides.online ?? true;
  const statusEvents = [];
  const discardEvents = [];
  const syncErrors = [];
  let syncCompleteCount = 0;
  const mockDb = overrides.db || createMockDb();
  const snapshotState = { profile: null, state: {} };
  const engine = SpisownikSync.createSyncEngine({
    db: mockDb,
    getUserId: overrides.getUserId || (() => "user-1"),
    getSnapshotPayload: () => ({ profile: snapshotState.profile, state: snapshotState.state }),
    online: () => isOnline,
    onStatusChange: (status) => statusEvents.push(status),
    onDiscard: (discarded, inventoryId) => discardEvents.push({ discarded, inventoryId }),
    onSyncError: (error) => syncErrors.push(error),
    onSyncComplete: () => { syncCompleteCount += 1; },
    dbName,
    dbVersion: 1,
  });
  return {
    engine, mockDb, dbName, statusEvents, discardEvents, syncErrors,
    getSyncCompleteCount: () => syncCompleteCount,
    setOnline: (value) => { isOnline = value; },
  };
}

describe("offline queue", () => {
  test("enqueue then readQueue returns the queued operation for that user", async () => {
    const { engine } = makeEngine({ online: false });
    await engine.enqueue("flag_update", { id: "item-1", flag_assigned: true });
    const queue = await engine.readQueue("user-1");
    assert.equal(queue.length, 1);
    assert.equal(queue[0].type, "flag_update");
    assert.deepEqual(queue[0].payload, { id: "item-1", flag_assigned: true });
    assert.equal(queue[0].userId, "user-1");
    assert.ok(queue[0].queuedAt);
  });

  test("clearOfflineData empties queue and snapshot for one user but leaves another user's data", async () => {
    const dbName = `spisownik-offline-test-${randomUUID()}`;
    const owner1 = makeEngine({ dbName, online: false, getUserId: () => "user-1" });
    const owner2 = makeEngine({ dbName, online: false, getUserId: () => "user-2" });
    await owner1.engine.enqueue("flag_update", { id: "item-1" });
    await owner2.engine.enqueue("flag_update", { id: "item-2" });
    await owner1.engine.saveSnapshot();
    await owner2.engine.saveSnapshot();

    await owner1.engine.clearOfflineData("user-1");

    assert.deepEqual(await owner1.engine.readQueue("user-1"), []);
    assert.equal(await owner1.engine.readSnapshot("user-1"), undefined);
    const remaining = await owner2.engine.readQueue("user-2");
    assert.equal(remaining.length, 1);
    assert.ok(await owner2.engine.readSnapshot("user-2"));
  });
});

describe("syncPending", () => {
  test("happy path: two queued ops of different types succeed", async () => {
    const { engine, mockDb, setOnline, getSyncCompleteCount } = makeEngine({ online: false });
    await engine.enqueue("inventory_upsert", { id: "inv-1", name: "Spis" });
    await engine.enqueue("flag_update", { id: "item-1", flag_assigned: true });

    setOnline(true);
    await engine.syncPending();

    assert.equal(engine.pendingCount, 0);
    assert.deepEqual(await engine.readQueue(), []);
    assert.equal(getSyncCompleteCount(), 1);
    assert.deepEqual(mockDb.calls.rpc.map((call) => call.name), ["sync_inventory", "set_inventory_item_flag"]);
    assert.deepEqual(mockDb.calls.rpc[0].args, { payload: { id: "inv-1", name: "Spis" } });
    assert.deepEqual(mockDb.calls.rpc[1].args, { target_item: "item-1", assigned: true });
  });

  test("discards operations for an archived inventory and continues syncing the rest", async () => {
    const mockDb = createMockDb({
      rpcResults: { sync_inventory: { error: { message: "conflict" } } },
      inventoryStatuses: { "inv-archived": "archived" },
    });
    const { engine, discardEvents, getSyncCompleteCount, setOnline } = makeEngine({ online: false, db: mockDb });
    await engine.enqueue("inventory_upsert", { id: "inv-archived", name: "Spis" });
    await engine.enqueue("flag_update", { id: "item-1", inventory_id: "inv-other", flag_assigned: true });

    setOnline(true);
    await engine.syncPending();

    assert.equal(discardEvents.length, 1);
    assert.equal(discardEvents[0].inventoryId, "inv-archived");
    assert.equal(discardEvents[0].discarded.length, 1);
    assert.deepEqual(await engine.readQueue(), []);
    assert.equal(engine.syncError, "");
    assert.equal(getSyncCompleteCount(), 1);
  });

  test("stops on a non-archived error, leaving remaining ops queued", async () => {
    const mockDb = createMockDb({ rpcResults: { sync_inventory: { error: { message: "network down" } } } });
    const { engine, syncErrors, getSyncCompleteCount, setOnline } = makeEngine({ online: false, db: mockDb });
    await engine.enqueue("inventory_upsert", { id: "inv-1", name: "Spis" });
    await engine.enqueue("flag_update", { id: "item-1", inventory_id: "inv-2", flag_assigned: true });

    setOnline(true);
    await engine.syncPending();

    assert.equal(engine.syncing, false);
    assert.equal(engine.syncError, "network down");
    assert.equal(syncErrors.length, 1);
    assert.equal(getSyncCompleteCount(), 0);
    assert.equal((await engine.readQueue()).length, 2);
  });

  test("is a no-op when offline", async () => {
    const { engine, mockDb } = makeEngine({ online: false });
    await engine.enqueue("flag_update", { id: "item-1", flag_assigned: true });
    await engine.syncPending();
    assert.equal(mockDb.calls.rpc.length, 0);
    assert.equal((await engine.readQueue()).length, 1);
  });
});
