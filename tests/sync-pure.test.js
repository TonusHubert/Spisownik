const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const SpisownikSync = require("../sync.js");
const { emptyState, upsertLocal, applyOperation, applyPending, operationInventoryId, rpcForOperation } = SpisownikSync;

describe("emptyState", () => {
  test("returns object with all expected keys as empty arrays", () => {
    const state = emptyState();
    for (const key of ["profiles", "stores", "memberships", "categories", "inventories", "items", "catalog", "prices", "sensitiveProducts", "sensitiveChecks", "suspiciousTransactions"]) {
      assert.deepEqual(state[key], []);
    }
  });

  test("returns a fresh object each call", () => {
    const first = emptyState();
    first.items.push({ id: "x" });
    const second = emptyState();
    assert.deepEqual(second.items, []);
  });
});

describe("upsertLocal", () => {
  test("inserts a new item when id not present", () => {
    const collection = [{ id: "1", name: "A" }];
    upsertLocal(collection, { id: "2", name: "B" });
    assert.equal(collection.length, 2);
    assert.deepEqual(collection[1], { id: "2", name: "B" });
  });

  test("merges into existing item, preserving untouched fields", () => {
    const collection = [{ id: "1", name: "A", quantity: 5 }];
    upsertLocal(collection, { id: "1", quantity: 9 });
    assert.deepEqual(collection[0], { id: "1", name: "A", quantity: 9 });
  });
});

describe("applyOperation", () => {
  test("inventory_upsert adds/merges into collections.inventories", () => {
    const collections = { inventories: [], items: [] };
    applyOperation(collections, { type: "inventory_upsert", payload: { id: "inv-1", name: "Spis 1" } });
    assert.deepEqual(collections.inventories, [{ id: "inv-1", name: "Spis 1" }]);
  });

  test("item_upsert without deleted_at upserts into collections.items", () => {
    const collections = { inventories: [], items: [] };
    applyOperation(collections, { type: "item_upsert", payload: { id: "item-1", name: "Produkt" } });
    assert.deepEqual(collections.items, [{ id: "item-1", name: "Produkt" }]);
  });

  test("item_upsert with deleted_at removes the matching item from collections.items", () => {
    const collections = { inventories: [], items: [{ id: "item-1", name: "Produkt" }] };
    applyOperation(collections, { type: "item_upsert", payload: { id: "item-1", deleted_at: "2026-06-26T00:00:00.000Z" } });
    assert.deepEqual(collections.items, []);
  });

  test("flag_update upserts into collections.items, merging fields", () => {
    const collections = { inventories: [], items: [{ id: "item-1", name: "Produkt", flag_assigned: false }] };
    applyOperation(collections, { type: "flag_update", payload: { id: "item-1", flag_assigned: true } });
    assert.deepEqual(collections.items, [{ id: "item-1", name: "Produkt", flag_assigned: true }]);
  });

  test("verified_update upserts into collections.items, merging fields", () => {
    const collections = { inventories: [], items: [{ id: "item-1", name: "Produkt", verified: false }] };
    applyOperation(collections, { type: "verified_update", payload: { id: "item-1", verified: true } });
    assert.deepEqual(collections.items, [{ id: "item-1", name: "Produkt", verified: true }]);
  });

  test("verified_period_update upserts into collections.items, merging fields", () => {
    const collections = { inventories: [], items: [{ id: "item-1", name: "Produkt", verified_from: null, verified_to: null }] };
    applyOperation(collections, { type: "verified_period_update", payload: { id: "item-1", verified_from: "18:00", verified_to: "22:00" } });
    assert.deepEqual(collections.items, [{ id: "item-1", name: "Produkt", verified_from: "18:00", verified_to: "22:00" }]);
  });
});

describe("applyPending", () => {
  test("applies an array of mixed operation types in order, last write wins for same id", () => {
    const collections = { inventories: [], items: [{ id: "item-1", flag_assigned: false }] };
    applyPending(collections, [
      { type: "flag_update", payload: { id: "item-1", flag_assigned: true } },
      { type: "flag_update", payload: { id: "item-1", flag_assigned: false } },
    ]);
    assert.equal(collections.items[0].flag_assigned, false);
  });
});

describe("operationInventoryId", () => {
  test("inventory_upsert reads payload.id", () => {
    assert.equal(operationInventoryId({ type: "inventory_upsert", payload: { id: "inv-1", inventory_id: "wrong" } }), "inv-1");
  });

  for (const type of ["item_upsert", "flag_update", "verified_update", "verified_period_update"]) {
    test(`${type} reads payload.inventory_id`, () => {
      assert.equal(operationInventoryId({ type, payload: { id: "item-1", inventory_id: "inv-1" } }), "inv-1");
    });
  }
});

describe("rpcForOperation", () => {
  test("inventory_upsert maps to sync_inventory with full payload", () => {
    const operation = { type: "inventory_upsert", payload: { id: "inv-1" } };
    assert.deepEqual(rpcForOperation(operation), { rpc: "sync_inventory", args: { payload: operation.payload } });
  });

  test("item_upsert maps to sync_inventory_item with full payload", () => {
    const operation = { type: "item_upsert", payload: { id: "item-1" } };
    assert.deepEqual(rpcForOperation(operation), { rpc: "sync_inventory_item", args: { payload: operation.payload } });
  });

  test("flag_update maps to set_inventory_item_flag with target_item/assigned", () => {
    const operation = { type: "flag_update", payload: { id: "item-1", flag_assigned: true } };
    assert.deepEqual(rpcForOperation(operation), { rpc: "set_inventory_item_flag", args: { target_item: "item-1", assigned: true } });
  });

  test("verified_update maps to set_inventory_item_verified with target_item/verified_value", () => {
    const operation = { type: "verified_update", payload: { id: "item-1", verified: true } };
    assert.deepEqual(rpcForOperation(operation), { rpc: "set_inventory_item_verified", args: { target_item: "item-1", verified_value: true } });
  });

  test("verified_period_update maps to set_inventory_item_verified_period with target_item/from_value/to_value", () => {
    const operation = { type: "verified_period_update", payload: { id: "item-1", verified_from: "18:00", verified_to: "22:00" } };
    assert.deepEqual(rpcForOperation(operation), { rpc: "set_inventory_item_verified_period", args: { target_item: "item-1", from_value: "18:00", to_value: "22:00" } });
  });
});
