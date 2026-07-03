function now() { return new Date().toISOString(); }

function emptyState() {
  return { profiles: [], stores: [], memberships: [], categories: [], inventories: [], items: [], catalog: [], prices: [], sensitiveProducts: [], sensitiveChecks: [], suspiciousTransactions: [] };
}

function upsertLocal(collection, value) {
  const index = collection.findIndex((item) => item.id === value.id);
  if (index === -1) collection.push(value);
  else collection[index] = { ...collection[index], ...value };
}

function applyOperation(collections, operation) {
  const value = operation.payload;
  if (operation.type === "inventory_upsert") upsertLocal(collections.inventories, value);
  if (operation.type === "item_upsert") {
    if (value.deleted_at) collections.items = collections.items.filter((item) => item.id !== value.id);
    else upsertLocal(collections.items, value);
  }
  if (operation.type === "flag_update") upsertLocal(collections.items, value);
  if (operation.type === "verified_update") upsertLocal(collections.items, value);
  if (operation.type === "verified_period_update") upsertLocal(collections.items, value);
}

function applyPending(collections, operations) { operations.forEach((operation) => applyOperation(collections, operation)); }

function operationInventoryId(operation) {
  return operation.type === "inventory_upsert" ? operation.payload.id : operation.payload.inventory_id;
}

function rpcForOperation(operation) {
  const rpc = operation.type === "inventory_upsert" ? "sync_inventory"
    : operation.type === "flag_update" ? "set_inventory_item_flag"
      : operation.type === "verified_update" ? "set_inventory_item_verified"
        : operation.type === "verified_period_update" ? "set_inventory_item_verified_period"
          : "sync_inventory_item";
  const args = operation.type === "flag_update" ? { target_item: operation.payload.id, assigned: operation.payload.flag_assigned }
    : operation.type === "verified_update" ? { target_item: operation.payload.id, verified_value: operation.payload.verified }
      : operation.type === "verified_period_update" ? { target_item: operation.payload.id, from_value: operation.payload.verified_from, to_value: operation.payload.verified_to }
        : { payload: operation.payload };
  return { rpc, args };
}

function openOfflineDb(dbName, dbVersion) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("snapshots")) database.createObjectStore("snapshots", { keyPath: "userId" });
      if (!database.objectStoreNames.contains("queue")) {
        const queue = database.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
        queue.createIndex("userId", "userId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function offlineStore(dbName, dbVersion, storeName, mode, action) {
  const database = await openOfflineDb(dbName, dbVersion);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

function createSyncEngine(options) {
  const {
    db, getUserId, getSnapshotPayload, online,
    onStatusChange, onDiscard, onSyncError, onSyncComplete,
    dbName = "spisownik-offline-v1", dbVersion = 1,
  } = options;

  let pendingCount = 0;
  let syncing = false;
  let syncError = "";

  function emitStatus() { onStatusChange?.({ pendingCount, syncing, syncError }); }
  function store(storeName, mode, action) { return offlineStore(dbName, dbVersion, storeName, mode, action); }

  async function readSnapshot(userId) { return store("snapshots", "readonly", (s) => s.get(userId)); }

  async function saveSnapshot() {
    const userId = getUserId();
    if (!userId) return;
    const { profile, state } = getSnapshotPayload();
    await store("snapshots", "readwrite", (s) => s.put({ userId, profile, state, savedAt: now() }));
  }

  async function clearOfflineData(userId) {
    await store("snapshots", "readwrite", (s) => s.delete(userId));
    const operations = await readQueue(userId);
    await Promise.all(operations.map((operation) => store("queue", "readwrite", (s) => s.delete(operation.id))));
  }

  async function readQueue(userId = getUserId()) {
    if (!userId) return [];
    return store("queue", "readonly", (s) => s.index("userId").getAll(userId));
  }

  async function refreshPendingCount() {
    pendingCount = (await readQueue()).length;
    emitStatus();
  }

  async function enqueue(type, payload) {
    const userId = getUserId();
    await store("queue", "readwrite", (s) => s.add({ userId, type, payload, queuedAt: now() }));
    await saveSnapshot();
    await refreshPendingCount();
    if (online()) await syncPending();
  }

  async function queuedOperationsForInventory(inventoryId) {
    return (await readQueue()).filter((operation) => operationInventoryId(operation) === inventoryId);
  }

  async function discardOperationsForInventory(inventoryId) {
    const operations = await queuedOperationsForInventory(inventoryId);
    await Promise.all(operations.map((operation) => store("queue", "readwrite", (s) => s.delete(operation.id))));
    await refreshPendingCount();
  }

  async function discardStaleArchivedOperations(inventoryId) {
    const operations = await readQueue();
    const stale = operations.filter((operation) =>
      operationInventoryId(operation) === inventoryId && ["inventory_upsert", "item_upsert"].includes(operation.type));
    await Promise.all(stale.map((operation) => store("queue", "readwrite", (s) => s.delete(operation.id))));
    pendingCount = Math.max(0, pendingCount - stale.length);
    return stale;
  }

  async function syncPending() {
    if (!online() || syncing || !getUserId()) return;
    syncing = true; syncError = ""; emitStatus();
    const operations = await readQueue();
    const discardedIds = new Set();
    pendingCount = operations.length;
    for (const operation of operations) {
      if (discardedIds.has(operation.id)) continue;
      const { rpc, args } = rpcForOperation(operation);
      const { error } = await db.rpc(rpc, args);
      if (error) {
        const inventoryId = operationInventoryId(operation);
        if (inventoryId && ["inventory_upsert", "item_upsert"].includes(operation.type)) {
          const { data: serverInventory } = await db.from("inventories").select("status").eq("id", inventoryId).maybeSingle();
          if (serverInventory?.status === "archived") {
            const discarded = await discardStaleArchivedOperations(inventoryId);
            discarded.forEach((item) => discardedIds.add(item.id));
            onDiscard?.(discarded, inventoryId);
            emitStatus();
            continue;
          }
        }
        syncError = error.message;
        syncing = false;
        emitStatus();
        onSyncError?.(error);
        return;
      }
      await store("queue", "readwrite", (s) => s.delete(operation.id));
      pendingCount -= 1;
      emitStatus();
    }
    syncing = false;
    emitStatus();
    await onSyncComplete?.();
    if (pendingCount) await syncPending();
  }

  function reset() {
    pendingCount = 0; syncing = false; syncError = "";
    emitStatus();
  }

  return {
    get pendingCount() { return pendingCount; },
    get syncing() { return syncing; },
    get syncError() { return syncError; },
    enqueue, readQueue, saveSnapshot, readSnapshot, clearOfflineData, refreshPendingCount,
    syncPending, queuedOperationsForInventory, discardOperationsForInventory, discardStaleArchivedOperations,
    reset,
  };
}

const api = { createSyncEngine, emptyState, upsertLocal, applyOperation, applyPending, operationInventoryId, rpcForOperation };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else window.SpisownikSync = api;
