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
const migrationSource = readFileSync(join(root, "supabase", "recidivism_migration.sql"), "utf8");

function fixture() {
  const userId = "recidivism-worker";
  return {
    user: { id: userId, email: "worker@example.com" },
    profile: { id: userId, email: "worker@example.com", display_name: "Tester", role: "worker" },
    state: {
      profiles: [],
      stores: [
        { id: "store-1", name: "1000 Sklep testowy", retention_days: 14, recidivism_default_interval_days: 7 },
        { id: "store-2", name: "2000 Sklep drugi", retention_days: 28, recidivism_default_interval_days: 14 },
      ],
      memberships: [
        { user_id: userId, store_id: "store-1", status: "approved" },
        { user_id: userId, store_id: "store-2", status: "approved" },
      ],
      categories: [], inventories: [], items: [], catalog: [], prices: [], sensitiveProducts: [], sensitiveChecks: [], suspiciousTransactions: [],
      recidivismEntries: [
        { id: "due-1", store_id: "store-1", entry_type: "application", reference_number: "APP-1", receipt_date: null, note: "Znany numer", interval_override_days: null, next_check_date: "2000-01-01", created_at: "2026-07-01T08:00:00.000Z", created_by_name: "Anna", last_checked_at: "2026-07-08T08:00:00.000Z", closed_at: null },
        { id: "future-1", store_id: "store-1", entry_type: "receipt", reference_number: "PAR-2", receipt_date: "2026-08-01", interval_override_days: 14, next_check_date: "2999-01-01", created_at: "2026-08-01T08:00:00.000Z", created_by_name: "Anna", closed_at: null },
        { id: "closed-1", store_id: "store-1", entry_type: "application", reference_number: "APP-OLD", receipt_date: null, interval_override_days: null, next_check_date: null, created_at: "2026-06-01T08:00:00.000Z", created_by_name: "Jan", closed_at: "2026-07-01T08:00:00.000Z", closed_by_name: "Jan" },
        { id: "due-2", store_id: "store-2", entry_type: "application", reference_number: "APP-2", receipt_date: null, interval_override_days: null, next_check_date: "2000-01-02", created_at: "2026-07-01T08:00:00.000Z", created_by_name: "Anna", closed_at: null },
      ],
      recidivismChecks: [
        { id: "check-1", entry_id: "due-1", checked_at: "2026-07-08T08:00:00.000Z", checked_by_name: "Piotr", period_from: "2026-07-02", period_to: "2026-07-08", interval_days: 7, gap_days: 0 },
      ],
    },
  };
}

function createApp() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8000/" });
  const { window } = dom;
  const data = fixture();
  window.SPISOWNIK_CONFIG = {};
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
  window.eval(syncSource);
  window.__RECIDIVISM_FIXTURE__ = data;
  window.eval(`${appSource}
    {
      const fixture = window.__RECIDIVISM_FIXTURE__;
      user = fixture.user; profile = fixture.profile; state = fixture.state;
      activeStoreId = "store-1"; activeInventoryId = null; renderAll();
      window.__RECIDIVISM_TEST__ = {
        updateTransactionTypeFields,
        transactionEntriesFromForm,
        resetRecidivismForm,
        updateRecidivismTypeFields,
        recidivismEntriesFromForm,
        validateRecidivismEntries,
      };
    }
  `);
  return { dom, window, api: window.__RECIDIVISM_TEST__ };
}

describe("Recydywa", () => {
  test("renderuje terminy aktywnego sklepu, historię kontroli i globalne przypomnienia", () => {
    const { dom, window } = createApp();
    try {
      assert.equal(window.document.querySelector("#recidivismDueStat").textContent, "1");
      assert.equal(window.document.querySelector("#recidivismActiveStat").textContent, "2");
      assert.equal(window.document.querySelector("#recidivismClosedStat").textContent, "1");
      assert.match(window.document.querySelector("#recidivismActiveList").textContent, /APP-1/);
      assert.match(window.document.querySelector("#recidivismActiveList").textContent, /Piotr/);
      assert.match(window.document.querySelector("#recidivismClosedList").textContent, /APP-OLD/);
      assert.match(window.document.querySelector("#recidivismReminderList").textContent, /1000 Sklep testowy/);
      assert.match(window.document.querySelector("#recidivismReminderList").textContent, /2000 Sklep drugi/);
      assert.equal(window.document.querySelector("#reminderBadge").textContent, "2");
    } finally { dom.window.close(); }
  });

  test("buduje atomową paczkę jednego numeru aplikacji dla wielu sklepów", () => {
    const { dom, window, api } = createApp();
    try {
      const type = window.document.querySelector("#transactionType");
      type.value = "application"; api.updateTransactionTypeFields();
      window.document.querySelector("#transactionNumber").value = "APP-WSPÓLNA";
      for (const checkbox of window.document.querySelectorAll("#transactionStoreCheckboxes input")) checkbox.checked = true;
      const entries = api.transactionEntriesFromForm();
      assert.equal(entries.length, 2);
      assert.deepEqual(Array.from(entries, (entry) => entry.store_id), ["store-1", "store-2"]);
      assert.ok(entries.every((entry) => entry.entry_type === "application" && entry.reference_number === "APP-WSPÓLNA"));
    } finally { dom.window.close(); }
  });

  test("odrzuca wyjątek przypomnienia dłuższy niż retencja sklepu", () => {
    const { dom, window, api } = createApp();
    try {
      api.resetRecidivismForm();
      const row = window.document.querySelector("#recidivismReceiptRows .transaction-receipt-row");
      row.querySelector(".reference-store").value = "store-1";
      row.querySelector(".reference-number").value = "PAR-TEST";
      row.querySelector(".reference-date").value = "2026-08-01";
      row.querySelector(".reference-interval").value = "custom";
      row.querySelector(".reference-custom-interval").value = "15";
      const entries = api.recidivismEntriesFromForm();
      assert.match(api.validateRecidivismEntries(entries), /przekracza archiwum/);
      entries[0].interval_override_days = 14;
      assert.equal(api.validateRecidivismEntries(entries), "");
    } finally { dom.window.close(); }
  });

  test("migracja zawiera harmonogram, RLS i wszystkie publiczne RPC", () => {
    for (const fragment of [
      "create table if not exists public.recidivism_entries",
      "create table if not exists public.recidivism_checks",
      "create policy recidivism_entries_member_read",
      "public.add_recidivism_entries",
      "public.check_recidivism_entry",
      "public.close_recidivism_entry",
      "public.delete_recidivism_entry",
      "public.update_store_settings",
      "timezone('Europe/Warsaw'",
    ]) assert.match(migrationSource, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
