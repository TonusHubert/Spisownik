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
const migrationSource = readFileSync(join(root, "supabase", "rpc_repair_migration.sql"), "utf8");

function createApp() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8000/" });
  const { window } = dom;
  const calls = { rpc: [], reset: [], update: [], signOut: [] };
  const behavior = { resetError: null, updateError: null, signOutError: null };
  const authListeners = [];
  const db = {
    auth: {
      onAuthStateChange(listener) { authListeners.push(listener); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null }, error: null }; },
      async signInWithPassword() { return { data: { session: null }, error: null }; },
      async signUp() { return { data: { session: null }, error: null }; },
      async resetPasswordForEmail(email, options) { calls.reset.push({ email, options }); return { data: {}, error: behavior.resetError }; },
      async updateUser(attributes) { calls.update.push(attributes); return { data: { user: {} }, error: behavior.updateError }; },
      async signOut(options) { calls.signOut.push(options); return { error: behavior.signOutError }; },
    },
    async rpc(name, args) { calls.rpc.push({ name, args }); return { data: null, error: null }; },
  };

  window.SPISOWNIK_CONFIG = { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" };
  window.supabase = { createClient: () => db };
  window.indexedDB = globalThis.indexedDB;
  window.IDBKeyRange = globalThis.IDBKeyRange;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
  window.eval(syncSource);
  window.eval(`${appSource}
    {
      loadData = async () => {};
      refreshExpiredInventoryCandidates = async () => {};
      window.__REPAIRS_TEST__ = {
        authSubmit,
        handleAuthStateChange,
        submitSuspiciousTransaction,
        updateTransactionTypeFields,
        getAuthMode: () => authMode,
        setFixture: (fixture) => {
          user = fixture.user;
          profile = fixture.profile;
          state = { ...window.SpisownikSync.emptyState(), ...fixture.state };
          activeStoreId = fixture.activeStoreId;
          activeInventoryId = fixture.activeInventoryId;
          renderAll();
        },
      };
    }
  `);
  return { dom, window, calls, behavior, authListeners, api: window.__REPAIRS_TEST__ };
}

function inventoryFixture() {
  const user = { id: "admin-1", email: "admin@example.com" };
  return {
    user,
    profile: { ...user, display_name: "Administrator", role: "admin" },
    activeStoreId: "store-1",
    activeInventoryId: "archive-1",
    state: {
      stores: [{ id: "store-1", name: "1000 Sklep", retention_days: 14 }],
      inventories: [{ id: "archive-1", store_id: "store-1", name: "Spis testowy", status: "archived", archived_at: "2026-08-01T08:00:00.000Z", created_at: "2026-08-01T07:00:00.000Z", updated_at: "2026-08-01T08:00:00.000Z" }],
      items: [],
    },
  };
}

function transactionFixture() {
  const user = { id: "worker-1", email: "worker@example.com" };
  return {
    user,
    profile: { ...user, display_name: "Pracownik", role: "worker" },
    activeStoreId: "store-1",
    activeInventoryId: null,
    state: {
      stores: [
        { id: "store-1", name: "1000 Sklep", retention_days: 14 },
        { id: "store-2", name: "2000 Sklep", retention_days: 21 },
      ],
      memberships: [
        { user_id: user.id, store_id: "store-1", status: "approved" },
        { user_id: user.id, store_id: "store-2", status: "approved" },
      ],
    },
  };
}

describe("naprawy RPC i interfejsu", () => {
  test("kliknięcie Trwale usuń przekazuje UUID aktywnego archiwum", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      api.setFixture(inventoryFixture());
      const button = window.document.querySelector("#deleteArchiveButton");
      assert.equal(button.classList.contains("hidden"), false);
      button.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.rpc[0].name, "delete_archived_inventory");
      assert.equal(calls.rpc[0].args.target_inventory, "archive-1");
    } finally { dom.window.close(); }
  });

  test("numer aplikacji jest wysyłany atomowo dla wszystkich zaznaczonych sklepów", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      api.setFixture(transactionFixture());
      const type = window.document.querySelector("#transactionType");
      type.value = "application";
      api.updateTransactionTypeFields();
      window.document.querySelector("#transactionNumber").value = "APP-123";
      for (const checkbox of window.document.querySelectorAll("#transactionStoreCheckboxes input")) checkbox.checked = true;
      await api.submitSuspiciousTransaction({ preventDefault() {} });
      const request = calls.rpc.find((call) => call.name === "add_suspicious_transactions");
      assert.deepEqual(Array.from(request.args.target_entries, (entry) => entry.store_id), ["store-1", "store-2"]);
      assert.ok(request.args.target_entries.every((entry) => entry.entry_type === "application" && entry.reference_number === "APP-123"));
    } finally { dom.window.close(); }
  });

  test("migracja odtwarza RPC, uprawnienia i przeładowuje cache schematu", () => {
    for (const fragment of [
      "public.cancel_inventory(target_inventory uuid)",
      "public.delete_archived_inventory(target_inventory uuid)",
      "public.add_suspicious_transactions(target_entries jsonb)",
      "revoke all on function public.cancel_inventory(uuid) from public, anon",
      "grant execute on function public.add_suspicious_transactions(jsonb) to authenticated",
      "notify pgrst, 'reload schema'",
    ]) assert.match(migrationSource.toLocaleLowerCase("pl"), new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("odzyskiwanie hasła", () => {
  test("wysyła neutralny link odzyskiwania na bieżący adres aplikacji", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      window.document.querySelector("#forgotPasswordButton").click();
      window.document.querySelector("#email").value = "user@example.com";
      await api.authSubmit({ preventDefault() {} });
      assert.equal(calls.reset[0].email, "user@example.com");
      assert.equal(calls.reset[0].options.redirectTo, "http://localhost:8000/");
      assert.match(window.document.querySelector("#authMessage").textContent, /Jeśli konto z tym adresem istnieje/);
    } finally { dom.window.close(); }
  });

  test("pokazuje błąd API bez komunikatu o wysłaniu wiadomości", async () => {
    const { dom, window, behavior, api } = createApp();
    try {
      behavior.resetError = { message: "Błąd wysyłania" };
      window.document.querySelector("#forgotPasswordButton").click();
      window.document.querySelector("#email").value = "user@example.com";
      await api.authSubmit({ preventDefault() {} });
      assert.equal(window.document.querySelector("#authError").textContent, "Błąd wysyłania");
      assert.equal(window.document.querySelector("#authMessage").textContent, "");
    } finally { dom.window.close(); }
  });

  test("wymaga zgodnych haseł i po sukcesie wraca do logowania", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const recoverySession = { user: { email: "user@example.com" }, access_token: "recovery" };
      api.handleAuthStateChange("SIGNED_IN", recoverySession);
      api.handleAuthStateChange("PASSWORD_RECOVERY", recoverySession);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(api.getAuthMode(), "set-password");
      assert.equal(window.document.querySelector("#appView").classList.contains("hidden"), true);
      window.document.querySelector("#newPassword").value = "nowe-haslo";
      window.document.querySelector("#confirmPassword").value = "inne-haslo";
      await api.authSubmit({ preventDefault() {} });
      assert.match(window.document.querySelector("#authError").textContent, /nie są takie same/);
      assert.equal(calls.update.length, 0);

      window.document.querySelector("#confirmPassword").value = "nowe-haslo";
      await api.authSubmit({ preventDefault() {} });
      assert.equal(calls.update[0].password, "nowe-haslo");
      assert.equal(calls.signOut[0].scope, "local");
      assert.equal(api.getAuthMode(), "signin");
      assert.match(window.document.querySelector("#authMessage").textContent, /Hasło zostało zmienione/);
    } finally { dom.window.close(); }
  });
});
