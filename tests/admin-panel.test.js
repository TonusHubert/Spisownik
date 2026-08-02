require("fake-indexeddb/auto");

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const root = join(__dirname, "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const syncSource = readFileSync(join(root, "sync.js"), "utf8");
const appSource = readFileSync(join(root, "app.js"), "utf8");

function createFixture(role = "admin", withApprovedStore = true) {
  const userId = `admin-panel-${role}`;
  const stores = [
    { id: "store-1", name: "1000 Sklep testowy", retention_days: 14 },
    { id: "store-2", name: "2000 Sklep drugi", retention_days: 21 },
  ];
  const memberships = [
    { user_id: userId, store_id: "store-1", status: withApprovedStore ? "approved" : "pending", requested_at: "2026-08-01T08:00:00.000Z" },
    { user_id: userId, store_id: "store-2", status: "pending", requested_at: "2026-08-02T08:00:00.000Z" },
  ];
  if (role === "admin") {
    memberships.splice(0, 2);
    memberships.push({ user_id: "worker-1", store_id: "store-1", status: "approved", requested_at: "2026-07-01T08:00:00.000Z" });
    memberships.push({ user_id: "worker-2", store_id: "store-2", status: "approved", requested_at: "2026-07-02T08:00:00.000Z" });
    memberships.push({ user_id: "worker-3", store_id: "store-2", status: "pending", requested_at: "2026-07-03T08:00:00.000Z" });
  }
  return {
    user: { id: userId, email: `${userId}@example.com` },
    profile: { id: userId, email: `${userId}@example.com`, display_name: "Tester", role },
    activeStoreId: withApprovedStore ? "store-1" : null,
    activeInventoryId: null,
    state: {
      profiles: [
        { id: "worker-1", email: "anna@example.com", display_name: "Anna Pracownik", role: "worker" },
        { id: "worker-2", email: "jan@example.com", display_name: "Jan Pracownik", role: "worker" },
        { id: "worker-3", email: "ola@example.com", display_name: "Ola Pracownik", role: "worker" },
      ],
      stores,
      memberships,
      categories: [
        { id: "category-1", name: "Pielęgnacja" },
        { id: "category-2", name: "Makijaż" },
        { id: "category-3", name: "Inne", is_fallback: true },
      ],
      inventories: [],
      items: [],
      catalog: [],
      prices: [],
      sensitiveProducts: [
        { id: "sensitive-1", ean: "5900000000001", name: "Produkt 1" },
        { id: "sensitive-2", ean: "5900000000002", name: "Produkt 2" },
      ],
      sensitiveChecks: [],
      suspiciousTransactions: [],
    },
    audit: [{
      inventory_id: "inventory-1",
      store_id: "store-1",
      inventory_name: "Spis sierpniowy",
      item_count: 12,
      deleted_by: "worker-1",
      deleted_at: "2026-08-02T10:00:00.000Z",
    }],
  };
}

function createApp(role = "admin", withApprovedStore = true) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8000/" });
  const { window } = dom;
  const fixture = createFixture(role, withApprovedStore);
  window.SPISOWNIK_CONFIG = {};
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
  window.eval(syncSource);
  window.__ADMIN_PANEL_FIXTURE__ = fixture;
  window.eval(`${appSource}
    {
      const fixture = window.__ADMIN_PANEL_FIXTURE__;
      user = fixture.user;
      profile = fixture.profile;
      state = fixture.state;
      activeStoreId = fixture.activeStoreId;
      activeInventoryId = fixture.activeInventoryId;
      adminRetentionAudit = fixture.audit;
      renderAll();
      window.__ADMIN_PANEL_TEST__ = {
        setTab: (tab) => { adminActiveTab = tab; renderAdmin(); },
        getAudit: () => adminRetentionAudit,
      };
    }
  `);
  return { dom, window, fixture, api: window.__ADMIN_PANEL_TEST__ };
}

describe("panel administratora", () => {
  test("renderuje liczniki, aktywną zakładkę i historię audytu", () => {
    const { dom, window } = createApp();
    try {
      assert.equal(window.document.querySelector("#adminStoresCount").textContent, "2");
      assert.equal(window.document.querySelector("#adminEmployeesCount").textContent, "2");
      assert.equal(window.document.querySelector("#adminPendingCount").textContent, "1");
      assert.equal(window.document.querySelector("#adminCategoriesCount").textContent, "3");
      assert.equal(window.document.querySelector("#adminSensitiveCount").textContent, "2");
      assert.equal(window.document.querySelector("#adminAuditCount").textContent, "1");
      assert.equal(window.document.querySelector("#adminPanelStores").classList.contains("hidden"), false);
      assert.equal(window.document.querySelector("#adminPanelEmployees").classList.contains("hidden"), true);

      window.document.querySelector("#adminTabEmployees").click();
      assert.equal(window.document.querySelector("#adminTabEmployees").getAttribute("aria-selected"), "true");
      assert.equal(window.document.querySelector("#adminPanelEmployees").classList.contains("hidden"), false);
      assert.equal(window.document.querySelector("#adminPanelStores").classList.contains("hidden"), true);

      window.document.querySelector("#adminTabAudit").click();
      assert.match(window.document.querySelector("#adminAuditList").textContent, /Spis sierpniowy/);
      assert.match(window.document.querySelector("#adminAuditList").textContent, /Anna Pracownik/);
    } finally {
      dom.window.close();
    }
  });

  test("pracownik widzi prośby w ustawieniach, a nie w głównym widoku", () => {
    const { dom, window } = createApp("worker");
    try {
      assert.equal(window.document.querySelector("#adminButton").classList.contains("hidden"), true);
      assert.equal(window.document.querySelector("#noStoresState").classList.contains("hidden"), true);
      assert.equal(window.document.querySelector("#noStoresState #storeRequestList"), null);
      assert.equal(window.document.querySelector("#storeRequestsSection").classList.contains("hidden"), false);
      assert.equal(window.document.querySelectorAll("#storeRequestList .session-history-row").length, 2);

      window.document.querySelector("#openStoreRequestsButton").click();
      assert.equal(window.document.querySelector("#settingsDialog").hasAttribute("open"), true);
      assert.equal(window.document.activeElement.id, "storeRequestSearch");
    } finally {
      dom.window.close();
    }
  });

  test("pracownik bez aktywnego sklepu dostaje tylko skrócony komunikat", () => {
    const { dom, window } = createApp("worker", false);
    try {
      assert.equal(window.document.querySelector("#noStoresState").classList.contains("hidden"), false);
      assert.ok(window.document.querySelector("#openStoreRequestsButton"));
      assert.equal(window.document.querySelector("#noStoresState #storeRequestList"), null);
    } finally {
      dom.window.close();
    }
  });
});
