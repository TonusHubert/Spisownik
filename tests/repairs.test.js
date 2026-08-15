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
const r3MigrationSource = readFileSync(join(root, "supabase", "r3_destructive_operations_migration.sql"), "utf8");
const schemaSource = readFileSync(join(root, "supabase", "schema.sql"), "utf8");

function createApp() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8000/" });
  const { window } = dom;
  const calls = { rpc: [], reset: [], update: [], signOut: [] };
  const behavior = { resetError: null, updateError: null, signOutError: null, rpcErrors: {} };
  const authListeners = [];
  const db = {
    auth: {
      onAuthStateChange(listener) { authListeners.push(listener); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session: null }, error: null }; },
      async signInWithPassword() { return { data: { session: null }, error: null }; },
      async signUp() { return { data: { session: null }, error: null }; },
      async resetPasswordForEmail(email, options) { calls.reset.push({ email, options }); return { data: {}, error: behavior.resetError }; },
      async updateUser(attributes) { calls.update.push(attributes); return { data: { user: {} }, error: behavior.updateError }; },
      async signOut(options) {
        calls.signOut.push(options);
        if (!behavior.signOutError) authListeners.forEach((listener) => listener("SIGNED_OUT", null));
        return { error: behavior.signOutError };
      },
    },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (behavior.rpcErrors[name]) return { data: null, error: behavior.rpcErrors[name] };
      if (name === "preview_inventory_deletion") return { data: { inventory_id: args.target_inventory, inventory_name: "Spis testowy", store_name: "1000 Sklep", status: "archived", item_count: 1, quantity_total: 2, value_total: 19.98 }, error: null };
      if (name === "restore_archived_inventory") window.__TEST_RESTORED_ID__ = args.target_inventory;
      if (name === "cancel_inventory" || name === "delete_archived_inventory") window.__TEST_REMOVED_ID__ = args.target_inventory;
      return { data: null, error: null };
    },
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
      loadData = async () => {
        if (window.__TEST_RESTORED_ID__) {
          const restored = state.inventories.find((item) => item.id === window.__TEST_RESTORED_ID__);
          if (restored) { restored.status = "active"; restored.archived_at = null; }
          window.__TEST_RESTORED_ID__ = null;
        }
        if (window.__TEST_REMOVED_ID__) {
          state.inventories = state.inventories.filter((item) => item.id !== window.__TEST_REMOVED_ID__);
          state.items = state.items.filter((item) => item.inventory_id !== window.__TEST_REMOVED_ID__);
          window.__TEST_REMOVED_ID__ = null;
        }
        chooseActive();
        renderAll();
      };
      refreshExpiredInventoryCandidates = async () => {};
      loadAdminAudit = async () => {};
      window.__REPAIRS_TEST__ = {
        authSubmit,
        handleAuthStateChange,
        restoreArchivedInventory,
        cancelInventory,
        submitSuspiciousTransaction,
        updateTransactionTypeFields,
        getAuthMode: () => authMode,
        getActiveInventoryId: () => activeInventoryId,
        getInventories: () => state.inventories,
        setFixture: (fixture) => {
          user = fixture.user;
          profile = fixture.profile;
          state = { ...window.SpisownikSync.emptyState(), ...fixture.state };
          activeStoreId = fixture.activeStoreId;
          activeInventoryId = fixture.activeInventoryId;
          scheduledAuthKey = "fixture-session";
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
  test("Trwale usuń pokazuje podsumowanie, wymaga potwierdzenia i wywołuje dwuargumentowe RPC", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      api.setFixture(inventoryFixture());
      const button = window.document.querySelector("#deleteArchiveButton");
      assert.equal(button.classList.contains("hidden"), false);
      button.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.rpc[0].name, "preview_inventory_deletion");
      assert.equal(calls.rpc[0].args.target_inventory, "archive-1");
      assert.equal(window.document.querySelector("#destructiveActionDialog").hasAttribute("open"), true);
      assert.match(window.document.querySelector("#destructiveActionNotice").textContent, /nieodwracalna/);
      assert.match(window.document.querySelector("#destructiveActionSummary").textContent, /Spis testowy/);
      assert.match(window.document.querySelector("#destructiveActionSummary").textContent, /19,98/);
      window.document.querySelector("#destructiveActionReason").value = "duplikat";
      window.document.querySelector("#destructiveActionConfirm").click();
      await new Promise((resolve) => setImmediate(resolve));
      const deletion = calls.rpc.find((call) => call.name === "delete_archived_inventory");
      assert.equal(deletion.args.target_inventory, "archive-1");
      assert.equal(deletion.args.target_reason, "duplikat");
      assert.equal(api.getInventories().some((item) => item.id === "archive-1"), false);
      assert.equal(calls.rpc.some((call) => call.name === "delete_archived_inventory" && !("target_reason" in call.args)), false);
    } finally { dom.window.close(); }
  });

  test("przywrócenie archiwum i anulowanie używa odzyskiwalnego RPC bez fizycznej ścieżki", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      api.setFixture(inventoryFixture());
      await api.restoreArchivedInventory();
      assert.equal(calls.rpc.find((call) => call.name === "restore_archived_inventory").args.target_inventory, "archive-1");
      assert.equal(api.getInventories()[0].status, "active");

      const cancellationPromise = api.cancelInventory();
      for (let attempt = 0; attempt < 40 && !calls.rpc.some((call) => call.name === "preview_inventory_deletion"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(calls.rpc.at(-1).name, "preview_inventory_deletion");
      assert.match(window.document.querySelector("#destructiveActionNotice").textContent, /odwracalna przez 14 dni/);
      const reason = window.document.querySelector("#destructiveActionReason");
      reason.value = "other";
      reason.dispatchEvent(new window.Event("change"));
      window.document.querySelector("#destructiveActionReasonDetailInput").value = "anulowanie testowego spisu";
      window.document.querySelector("#destructiveActionConfirm").click();
      await cancellationPromise;

      const cancellation = calls.rpc.find((call) => call.name === "cancel_inventory");
      assert.equal(cancellation.args.target_inventory, "archive-1");
      assert.equal(cancellation.args.target_reason, "anulowanie testowego spisu");
      assert.equal(calls.rpc.some((call) => call.name === "delete_empty_active_inventory"), false);
      assert.equal(calls.rpc.some((call) => call.name === "cancel_inventory" && !("target_reason" in call.args)), false);
      assert.equal(api.getActiveInventoryId(), null);
      assert.equal(api.getInventories().some((item) => item.id === "archive-1"), false);
      assert.doesNotMatch(window.document.querySelector("#toast").textContent, /Fizyczne usuwanie jest zablokowane/);
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

  test("migracja usuwa stare przeciążenia i rozdziela anulowanie od trwałego usunięcia", () => {
    const normalized = migrationSource.toLocaleLowerCase("pl");
    for (const fragment of [
      "drop function if exists public.cancel_inventory(uuid)",
      "drop function if exists public.delete_empty_active_inventory(uuid)",
      "drop function if exists public.delete_archived_inventory(uuid)",
      "public.cancel_inventory(target_inventory uuid, target_reason text)",
      "return public.soft_delete_inventory(target_inventory, target_reason)",
      "public.delete_archived_inventory(target_inventory uuid, target_reason text)",
      "'hard_delete', 'inventory'",
      "perform set_config('app.allow_destructive_operation', 'true', true)",
      "delete from inventories where id = target_inventory",
      "public.add_suspicious_transactions(target_entries jsonb)",
      "grant execute on function public.cancel_inventory(uuid, text) to authenticated",
      "grant execute on function public.delete_archived_inventory(uuid, text) to authenticated",
      "grant execute on function public.add_suspicious_transactions(jsonb) to authenticated",
      "notify pgrst, 'reload schema'",
    ]) assert.match(normalized, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(normalized, /create or replace function public\.cancel_inventory\(target_inventory uuid\)\s/);
    assert.doesNotMatch(normalized, /create or replace function public\.delete_archived_inventory\(target_inventory uuid\)\s/);
    for (const source of [r3MigrationSource, schemaSource]) {
      assert.match(source, /'hard_delete', 'inventory'/);
      assert.match(source, /delete from inventories where id = target_inventory/);
      assert.match(source, /notify pgrst, 'reload schema'/);
    }
  });
});

describe("odzyskiwanie hasła", () => {
  test("po wylogowaniu pokazuje klikalną opcję Nie pamiętasz hasła", async () => {
    const { dom, window, calls, api } = createApp();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      api.setFixture(inventoryFixture());
      window.document.querySelector("#logoutButton").click();
      for (let attempt = 0; attempt < 40 && calls.signOut.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(calls.signOut.at(-1).scope, "local");
      assert.equal(window.document.querySelector("#authView").classList.contains("hidden"), false);
      const forgot = window.document.querySelector("#forgotPasswordButton");
      assert.equal(forgot.classList.contains("hidden"), false);
      forgot.click();
      assert.equal(api.getAuthMode(), "request-reset");
      assert.equal(window.document.querySelector("#authTitle").textContent, "Odzyskaj hasło");
    } finally { dom.window.close(); }
  });

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
