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

function createFixture(role = "worker") {
  const userId = `summary-${role}`;
  const stores = [
    { id: "store-1", name: "1000 Sklep testowy", retention_days: 14 },
    { id: "store-2", name: "2000 Inny sklep", retention_days: 14 },
    { id: "store-empty", name: "3000 Pusty sklep", retention_days: 14 },
  ];
  const memberships = stores.map((store) => ({
    user_id: userId,
    store_id: store.id,
    status: "approved",
  }));
  const inventories = [
    { id: "archive-old", store_id: "store-1", name: "Spis stary", status: "archived", archived_at: "2026-07-01T08:00:00.000Z", created_at: "2026-07-01T07:00:00.000Z", updated_at: "2026-07-01T08:00:00.000Z" },
    { id: "archive-new", store_id: "store-1", name: "Spis nowy", status: "archived", archived_at: "2026-07-10T08:00:00.000Z", created_at: "2026-07-10T07:00:00.000Z", updated_at: "2026-07-10T08:00:00.000Z" },
    { id: "active-1", store_id: "store-1", name: "Spis aktywny", status: "active", archived_at: null, created_at: "2026-07-12T07:00:00.000Z", updated_at: "2026-07-12T08:00:00.000Z" },
    { id: "archive-other", store_id: "store-2", name: "Spis innego sklepu", status: "archived", archived_at: "2026-06-01T08:00:00.000Z", created_at: "2026-06-01T07:00:00.000Z", updated_at: "2026-06-01T08:00:00.000Z" },
  ];
  const items = [
    { id: "item-old", inventory_id: "archive-old", name: "Krem", ean: "5900000000001", quantity: 2, price: 10, verified: false, verified_from: "2026-06-01", verified_to: "2026-06-30" },
    { id: "item-new", inventory_id: "archive-new", name: "Krem", ean: "5900000000001", quantity: 3, price: 5, verified: false },
    { id: "item-null", inventory_id: "archive-new", name: "Szampon", ean: "5900000000002", quantity: 1, price: 12, verified: null },
    { id: "item-verified", inventory_id: "archive-old", name: "Zweryfikowany", ean: "5900000000003", quantity: 9, price: 99, verified: true },
    { id: "item-active", inventory_id: "active-1", name: "Aktywny", ean: "5900000000004", quantity: 8, price: 88, verified: false },
    { id: "item-other", inventory_id: "archive-other", name: "Inny sklep", ean: "5900000000005", quantity: 7, price: 77, verified: false },
  ];
  return {
    user: { id: userId, email: `${userId}@example.com` },
    profile: { id: userId, email: `${userId}@example.com`, display_name: "Tester", role },
    activeStoreId: "store-1",
    activeInventoryId: "active-1",
    state: {
      profiles: [],
      stores,
      memberships,
      categories: [],
      inventories,
      items,
      catalog: [],
      prices: [],
      sensitiveProducts: [],
      sensitiveChecks: [],
      suspiciousTransactions: [],
    },
  };
}

function createApp(role = "worker") {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost:8000/",
  });
  const { window } = dom;
  const fixture = createFixture(role);

  window.SPISOWNIK_CONFIG = {};
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };

  window.eval(syncSource);
  window.__SHORTAGES_FIXTURE__ = fixture;
  window.eval(`${appSource}
    {
      const fixture = window.__SHORTAGES_FIXTURE__;
      user = fixture.user;
      profile = fixture.profile;
      state = fixture.state;
      activeStoreId = fixture.activeStoreId;
      activeInventoryId = fixture.activeInventoryId;
      renderAll();
      window.__SHORTAGES_TEST__ = {
        unverifiedArchiveRows,
        sortUnverifiedArchiveRows,
        summarizeUnverifiedArchiveRows,
        renderShortagesSummary,
        setActiveStore: (id) => { activeStoreId = id; renderAll(); },
      };
    }
  `);

  return { dom, window, fixture, api: window.__SHORTAGES_TEST__ };
}

describe("podsumowanie niezweryfikowanych braków", () => {
  test("filtruje sklep, status spisu i weryfikację oraz poprawnie liczy sumy", () => {
    const { dom, api } = createApp();
    try {
      const rows = api.unverifiedArchiveRows("store-1");
      assert.deepEqual(rows.map((row) => row.id), ["item-old", "item-new", "item-null"]);
      assert.equal(rows[0].total, 20);
      assert.equal(rows[1].total, 15);
      assert.equal(rows[0].verified_from, "2026-06-01");
      assert.deepEqual({ ...api.summarizeUnverifiedArchiveRows(rows) }, {
        positions: 3,
        quantity: 6,
        value: 47,
      });
    } finally {
      dom.window.close();
    }
  });

  test("obsługuje wszystkie warianty sortowania i jednoznaczne remisy", () => {
    const { dom, api } = createApp();
    const rows = [
      { id: "2", name: "Zebra", archived_at: "2026-07-01T08:00:00.000Z", price: 10, total: 20 },
      { id: "3", name: "Alfa", archived_at: "2026-07-03T08:00:00.000Z", price: 5, total: 15 },
      { id: "1", name: "Alfa", archived_at: "2026-07-01T08:00:00.000Z", price: 10, total: 20 },
      { id: "0", name: "Alfa", archived_at: "2026-07-01T08:00:00.000Z", price: 10, total: 20 },
    ];
    const ids = (sort) => Array.from(api.sortUnverifiedArchiveRows(rows, sort), (row) => row.id);
    try {
      assert.deepEqual(ids("date-asc"), ["0", "1", "2", "3"]);
      assert.deepEqual(ids("date-desc"), ["3", "0", "1", "2"]);
      assert.deepEqual(ids("value-asc"), ["3", "0", "1", "2"]);
      assert.deepEqual(ids("value-desc"), ["0", "1", "2", "3"]);
      assert.deepEqual(ids("unit-asc"), ["3", "0", "1", "2"]);
      assert.deepEqual(ids("unit-desc"), ["0", "1", "2", "3"]);
      assert.deepEqual(rows.map((row) => row.id), ["2", "3", "1", "0"], "sortowanie nie powinno zmieniać tablicy źródłowej");
    } finally {
      dom.window.close();
    }
  });

  for (const role of ["worker", "admin"]) {
    test(`otwiera czytelne zestawienie offline dla roli ${role}`, () => {
      const { dom, window, api } = createApp(role);
      try {
        const button = window.document.querySelector("#shortagesSummaryButton");
        assert.equal(button.disabled, false);
        button.click();

        const dialog = window.document.querySelector("#shortagesSummaryDialog");
        assert.equal(dialog.hasAttribute("open"), true);
        assert.equal(window.document.querySelector("#shortagesStoreName").textContent, "1000 Sklep testowy");
        assert.equal(window.document.querySelector("#shortagesSort").value, "date-asc");
        assert.equal(window.document.querySelector("#shortagesPositionsStat").textContent, "3");
        assert.equal(window.document.querySelector("#shortagesQuantityStat").textContent, "6");
        assert.match(window.document.querySelector("#shortagesValueStat").textContent, /47[,.]00/);

        const rows = [...window.document.querySelectorAll("#shortagesTableBody tr")];
        assert.equal(rows.length, 3);
        assert.equal(rows[0].children[1].textContent, "Spis stary");
        assert.equal(rows[0].children[2].textContent, "Krem");
        assert.equal(rows[0].children[3].textContent, "5900000000001");
        assert.equal(rows[0].children.length, 7);
        assert.equal(window.document.querySelectorAll(".summary-table thead th").length, 7);

        const sort = window.document.querySelector("#shortagesSort");
        sort.value = "unit-asc";
        sort.dispatchEvent(new window.Event("change", { bubbles: true }));
        assert.equal(window.document.querySelector("#shortagesTableBody tr").children[2].textContent, "Krem");
        assert.match(window.document.querySelector("#shortagesTableBody tr").children[5].textContent, /5[,.]00/);

        api.setActiveStore("store-empty");
        assert.equal(window.document.querySelector("#shortagesStoreName").textContent, "3000 Pusty sklep");
        assert.equal(window.document.querySelectorAll("#shortagesTableBody tr").length, 0);
        assert.equal(window.document.querySelector("#shortagesEmptyState").classList.contains("hidden"), false);
      } finally {
        dom.window.close();
      }
    });
  }
});
