const LEGACY_KEY = "spisownik-state-v2";
const MIGRATION_KEY = "spisownik-migrated-v1";
const THEME_KEY = "spisownik-theme";
const OFFLINE_DB = "spisownik-offline-v1";
const OFFLINE_DB_VERSION = 1;
const $ = (selector) => document.querySelector(selector);
const config = window.SPISOWNIK_CONFIG || {};
const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
const db = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const el = {
  authView: $("#authView"), appView: $("#appView"), authForm: $("#authForm"), authTitle: $("#authTitle"), authSubmit: $("#authSubmit"),
  authModeButton: $("#authModeButton"), authError: $("#authError"), displayNameField: $("#displayNameField"), displayName: $("#displayName"),
  email: $("#email"), password: $("#password"), configWarning: $("#configWarning"), settingsButton: $("#settingsButton"),
  adminButton: $("#adminButton"), remindersButton: $("#remindersButton"), reminderBadge: $("#reminderBadge"), settingsDialog: $("#settingsDialog"),
  adminDialog: $("#adminDialog"), remindersDialog: $("#remindersDialog"), storeSelect: $("#storeSelect"), storeSearch: $("#storeSearch"), sessionName: $("#sessionName"),
  savedStatus: $("#savedStatus"), syncButton: $("#syncButton"), offlineBanner: $("#offlineBanner"), noStoresState: $("#noStoresState"), inventoryView: $("#inventoryView"),
  itemsStat: $("#itemsStat"), quantityStat: $("#quantityStat"), valueStat: $("#valueStat"), productForm: $("#productForm"),
  editingId: $("#editingId"), ean: $("#ean"), name: $("#name"), category: $("#category"), quantity: $("#quantity"), price: $("#price"),
  formError: $("#formError"), submitButton: $("#submitButton"), cancelEditButton: $("#cancelEditButton"), formTitle: $("#formTitle"),
  lookupStatus: $("#lookupStatus"), searchInput: $("#searchInput"), categoryFilter: $("#categoryFilter"), sortSelect: $("#sortSelect"),
  productList: $("#productList"), productTemplate: $("#productTemplate"), emptyState: $("#emptyState"), storeSettings: $("#storeSettings"),
  sessionSettings: $("#sessionSettings"), archiveSettings: $("#archiveSettings"), profileSummary: $("#profileSummary"),
  reminderList: $("#reminderList"), adminStoreList: $("#adminStoreList"), adminEmployeeSelect: $("#adminEmployeeSelect"),
  adminMembershipStore: $("#adminMembershipStore"), adminMembershipList: $("#adminMembershipList"), adminCategoryName: $("#adminCategoryName"),
  adminCategoryList: $("#adminCategoryList"),
  storeSettingsSearch: $("#storeSettingsSearch"), adminStoreSearch: $("#adminStoreSearch"), addPanel: $("#addPanel"), archiveBanner: $("#archiveBanner"),
  archiveStatus: $("#archiveStatus"), restoreArchiveButton: $("#restoreArchiveButton"), deleteArchiveButton: $("#deleteArchiveButton"), finishSessionButton: $("#finishSessionButton"),
  newSessionButton: $("#newSessionButton"), cancelSessionButton: $("#cancelSessionButton"), undoLastItemButton: $("#undoLastItemButton"),
  toast: $("#toast"), scannerDialog: $("#scannerDialog"), scannerVideo: $("#scannerVideo"), scannerMessage: $("#scannerMessage"),
  inventoryTabButton: $("#inventoryTabButton"), sensitiveTabButton: $("#sensitiveTabButton"), sensitiveView: $("#sensitiveView"),
  sensitiveCheckForm: $("#sensitiveCheckForm"), sensitiveEan: $("#sensitiveEan"), sensitiveQuantity: $("#sensitiveQuantity"),
  sensitiveFormError: $("#sensitiveFormError"), sensitiveProductList: $("#sensitiveProductList"), sensitiveProgress: $("#sensitiveProgress"),
  sensitiveEmptyState: $("#sensitiveEmptyState"), sensitiveAdminForm: $("#sensitiveAdminForm"), sensitiveAdminList: $("#sensitiveAdminList"),
  sensitiveAdminEditingId: $("#sensitiveAdminEditingId"), sensitiveAdminEan: $("#sensitiveAdminEan"), sensitiveAdminName: $("#sensitiveAdminName"),
  sensitiveAdminImage: $("#sensitiveAdminImage"), sensitiveRemoveImage: $("#sensitiveRemoveImage"), sensitiveRemoveImageLabel: $("#sensitiveRemoveImageLabel"),
  sensitiveAdminSubmit: $("#sensitiveAdminSubmit"), sensitiveAdminCancel: $("#sensitiveAdminCancel"), sensitiveAdminError: $("#sensitiveAdminError"),
  transactionsTabButton: $("#transactionsTabButton"), transactionsView: $("#transactionsView"), transactionForm: $("#transactionForm"),
  transactionEditingId: $("#transactionEditingId"), transactionType: $("#transactionType"), transactionNumber: $("#transactionNumber"),
  transactionDateField: $("#transactionDateField"), transactionDate: $("#transactionDate"), transactionDateNote: $("#transactionDateNote"),
  transactionNote: $("#transactionNote"), transactionFormTitle: $("#transactionFormTitle"), transactionSubmitButton: $("#transactionSubmitButton"),
  transactionCancelEdit: $("#transactionCancelEdit"), transactionFormError: $("#transactionFormError"),
  transactionEligibleStat: $("#transactionEligibleStat"), transactionPendingStat: $("#transactionPendingStat"),
  transactionCheckedStat: $("#transactionCheckedStat"), transactionThresholdStatus: $("#transactionThresholdStatus"),
  transactionPendingList: $("#transactionPendingList"), transactionHistoryList: $("#transactionHistoryList"),
  transactionPendingEmpty: $("#transactionPendingEmpty"), transactionHistoryEmpty: $("#transactionHistoryEmpty"),
  inventoryReminderSection: $("#inventoryReminderSection"), transactionReminderSection: $("#transactionReminderSection"),
  transactionReminderText: $("#transactionReminderText"), transactionReminderList: $("#transactionReminderList"),
  noRemindersText: $("#noRemindersText"),
};

let signupMode = false;
let user = null;
let profile = null;
let state = emptyState();
let activeStoreId = null;
let activeInventoryId = null;
let toastTimer = null;
let scannerControls = null;
let pendingCount = 0;
let syncing = false;
let syncError = "";
let scheduledAuthKey = null;
let activeView = "inventories";

function emptyState() {
  return { profiles: [], stores: [], memberships: [], categories: [], inventories: [], items: [], catalog: [], prices: [], sensitiveProducts: [], sensitiveChecks: [], suspiciousTransactions: [] };
}
function isAdmin() { return profile?.role === "admin"; }
function online() { return navigator.onLine && configured; }
function approvedStoreIds() {
  return new Set(isAdmin() ? state.stores.map((store) => store.id) : state.memberships.filter((membership) => membership.status === "approved").map((membership) => membership.store_id));
}
function activeInventory() { return state.inventories.find((x) => x.id === activeInventoryId); }
function activeItems() { return state.items.filter((x) => x.inventory_id === activeInventoryId); }
function canEditInventory(inventory = activeInventory()) { return Boolean(inventory && (inventory.status === "active" || (inventory.status === "archived" && isAdmin()))); }
function categoryName(id) { return state.categories.find((x) => x.id === id)?.name || "Inne"; }
function storeName(id) { return state.stores.find((x) => x.id === id)?.name || "Nieznany sklep"; }
function storeNumber(name) { return Number(String(name).match(/^\s*(\d+)/)?.[1] || Number.MAX_SAFE_INTEGER); }
function compareStores(a, b) { return storeNumber(a.name) - storeNumber(b.name) || a.name.localeCompare(b.name, "pl", { numeric: true }); }
function storeMatches(store, value) { return store.name.toLocaleLowerCase("pl").includes(value.trim().toLocaleLowerCase("pl")); }
function archiveDeadline(inventory) { const store = state.stores.find((x) => x.id === inventory.store_id); return new Date(new Date(inventory.archived_at).getTime() + (store?.retention_days || 0) * 86400000); }
function missingFlags(inventoryId) { return state.items.filter((x) => x.inventory_id === inventoryId && !x.flag_assigned).length; }
function activeStoreTransactions() { return state.suspiciousTransactions.filter((item) => item.store_id === activeStoreId); }
function transactionIsEligible(item) { return !item.checked_at && (item.entry_type === "application" || item.receipt_date < localDate()); }
function eligibleTransactions() { return activeStoreTransactions().filter(transactionIsEligible); }
function money(value) { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(Number(value) || 0); }
function date(value) { return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short" }).format(new Date(value)); }
function dateTime(value) { return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function defaultInventoryName() { return `Spis ${new Intl.DateTimeFormat("pl-PL", { dateStyle: "short" }).format(new Date())}`; }
function localDate() { return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Warsaw" }).format(new Date()); }
function showToast(message) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.classList.add("visible"); toastTimer = setTimeout(() => el.toast.classList.remove("visible"), 3000); }
function report(error, fallback = "Nie udało się wykonać operacji.") { console.error(error); showToast(error?.message || fallback); }
function requireOnline() { if (online()) return true; showToast("Ta operacja wymaga połączenia z internetem."); return false; }
function now() { return new Date().toISOString(); }
function sensitiveImageUrl(path) {
  if (!path || !db) return "";
  return db.storage.from("sensitive-product-images").getPublicUrl(path).data.publicUrl;
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION);
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

async function offlineStore(name, mode, action) {
  const database = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    const request = action(transaction.objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function readSnapshot(userId) { return offlineStore("snapshots", "readonly", (store) => store.get(userId)); }
async function saveSnapshot() {
  if (!user) return;
  await offlineStore("snapshots", "readwrite", (store) => store.put({ userId: user.id, profile, state, savedAt: now() }));
}
async function clearOfflineData(userId) {
  await offlineStore("snapshots", "readwrite", (store) => store.delete(userId));
  const operations = await readQueue(userId);
  await Promise.all(operations.map((operation) => offlineStore("queue", "readwrite", (store) => store.delete(operation.id))));
}
async function readQueue(userId = user?.id) {
  if (!userId) return [];
  return offlineStore("queue", "readonly", (store) => store.index("userId").getAll(userId));
}
async function refreshPendingCount() { pendingCount = (await readQueue()).length; renderSyncStatus(); }
async function enqueue(type, payload) {
  await offlineStore("queue", "readwrite", (store) => store.add({ userId: user.id, type, payload, queuedAt: now() }));
  await saveSnapshot();
  await refreshPendingCount();
  if (online()) syncPending();
}
function renderSyncStatus() {
  if (!user) return;
  el.syncButton.classList.toggle("hidden", !syncError && !pendingCount);
  el.syncButton.disabled = syncing || !online();
  if (syncing) el.savedStatus.textContent = `Synchronizacja… (${pendingCount})`;
  else if (syncError) el.savedStatus.textContent = `Błąd synchronizacji · ${pendingCount} oczekuje`;
  else if (pendingCount) el.savedStatus.textContent = `${pendingCount} zmian oczekuje na synchronizację`;
  else if (!online()) el.savedStatus.textContent = "Praca offline · wszystkie lokalne zmiany zapisane";
}

async function query(table, select = "*", filters = []) {
  let request = db.from(table).select(select);
  for (const [method, column, value] of filters) request = request[method](column, value);
  const { data, error } = await request;
  if (error) throw error;
  return data || [];
}

async function loadData() {
  if (!user) return;
  if (!online()) {
    const cached = await readSnapshot(user.id);
    if (cached) { state = { ...emptyState(), ...cached.state }; profile = cached.profile; }
    chooseActive();
    await refreshPendingCount();
    renderAll();
    return;
  }
  try {
    const [profiles, stores, memberships, categories, inventories, catalog, sensitiveProducts] = await Promise.all([
      query("profiles", "*", [["eq", "id", user.id]]), query("stores"), query("store_memberships"),
      query("categories", "*"), query("inventories", "*"), query("catalog_products", "*"), query("sensitive_products", "*"),
    ]);
    profile = profiles[0];
    if (!profile) throw new Error("Nie znaleziono profilu użytkownika. Sprawdź migrację Supabase.");
    state = { ...emptyState(), stores, memberships, categories, inventories, catalog, sensitiveProducts };
    const inventoryIds = inventories.map((x) => x.id);
    const storeIds = [...approvedStoreIds()];
    const extra = await Promise.all([
      inventoryIds.length ? query("inventory_items", "*", [["in", "inventory_id", inventoryIds]]) : [],
      storeIds.length ? query("store_prices", "*", [["in", "store_id", storeIds]]) : [],
      isAdmin() ? query("profiles", "*", [["eq", "role", "worker"]]) : [],
      storeIds.length ? query("sensitive_product_checks", "*", [["in", "store_id", storeIds], ["eq", "check_date", localDate()]]) : [],
      storeIds.length ? query("suspicious_transactions", "*", [["in", "store_id", storeIds]]) : [],
    ]);
    state.items = extra[0].filter((x) => !x.deleted_at); state.prices = extra[1]; state.profiles = extra[2]; state.sensitiveChecks = extra[3]; state.suspiciousTransactions = extra[4];
    applyPending(await readQueue());
    chooseActive();
    await saveSnapshot();
    await refreshPendingCount();
    el.savedStatus.textContent = `Zsynchronizowano: ${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    renderAll();
    maybeShowDailyReminder();
  } catch (error) {
    const cached = await readSnapshot(user.id);
    if (cached) {
      state = { ...emptyState(), ...cached.state }; profile = cached.profile; chooseActive(); await refreshPendingCount(); renderAll();
      showToast("Nie udało się połączyć z serwerem. Pracujesz na danych lokalnych.");
    } else report(error, "Nie udało się pobrać danych.");
  }
}

function upsertLocal(collection, value) {
  const index = collection.findIndex((item) => item.id === value.id);
  if (index === -1) collection.push(value);
  else collection[index] = { ...collection[index], ...value };
}
function applyOperation(operation) {
  const value = operation.payload;
  if (operation.type === "inventory_upsert") upsertLocal(state.inventories, value);
  if (operation.type === "item_upsert") {
    if (value.deleted_at) state.items = state.items.filter((item) => item.id !== value.id);
    else upsertLocal(state.items, value);
  }
  if (operation.type === "flag_update") upsertLocal(state.items, value);
  if (operation.type === "verified_update") upsertLocal(state.items, value);
}
function applyPending(operations) { operations.forEach(applyOperation); }

function operationInventoryId(operation) {
  return operation.type === "inventory_upsert" ? operation.payload.id : operation.payload.inventory_id;
}

async function discardStaleArchivedOperations(inventoryId) {
  const operations = await readQueue();
  const stale = operations.filter((operation) =>
    operationInventoryId(operation) === inventoryId && ["inventory_upsert", "item_upsert"].includes(operation.type));
  await Promise.all(stale.map((operation) => offlineStore("queue", "readwrite", (store) => store.delete(operation.id))));
  pendingCount = Math.max(0, pendingCount - stale.length);
  return stale;
}

async function queuedOperationsForInventory(inventoryId) {
  return (await readQueue()).filter((operation) => operationInventoryId(operation) === inventoryId);
}

async function discardOperationsForInventory(inventoryId) {
  const operations = await queuedOperationsForInventory(inventoryId);
  await Promise.all(operations.map((operation) => offlineStore("queue", "readwrite", (store) => store.delete(operation.id))));
  await refreshPendingCount();
}

async function syncPending() {
  if (!online() || syncing || !user) return;
  syncing = true; syncError = ""; renderSyncStatus();
  const operations = await readQueue();
  const discardedIds = new Set();
  pendingCount = operations.length;
  for (const operation of operations) {
    if (discardedIds.has(operation.id)) continue;
    const rpc = operation.type === "inventory_upsert" ? "sync_inventory"
      : operation.type === "flag_update" ? "set_inventory_item_flag"
        : operation.type === "verified_update" ? "set_inventory_item_verified"
          : "sync_inventory_item";
    const args = operation.type === "flag_update" ? { target_item: operation.payload.id, assigned: operation.payload.flag_assigned }
      : operation.type === "verified_update" ? { target_item: operation.payload.id, verified_value: operation.payload.verified }
        : { payload: operation.payload };
    const { error } = await db.rpc(rpc, args);
    if (error) {
      const inventoryId = operationInventoryId(operation);
      if (inventoryId && ["inventory_upsert", "item_upsert"].includes(operation.type)) {
        const { data: serverInventory } = await db.from("inventories").select("status").eq("id", inventoryId).maybeSingle();
        if (serverInventory?.status === "archived") {
          const discarded = await discardStaleArchivedOperations(inventoryId);
          discarded.forEach((item) => discardedIds.add(item.id));
          showToast(`Odrzucono ${discarded.length} nieaktualnych zmian archiwalnego spisu.`);
          renderSyncStatus();
          continue;
        }
      }
      syncError = error.message;
      syncing = false;
      renderSyncStatus();
      report(error, "Nie udało się zsynchronizować zmian.");
      return;
    }
    await offlineStore("queue", "readwrite", (store) => store.delete(operation.id));
    pendingCount -= 1;
    renderSyncStatus();
  }
  syncing = false;
  await loadData();
  if (pendingCount) syncPending();
}

function chooseActive() {
  const allowed = approvedStoreIds();
  if (!allowed.has(activeStoreId)) activeStoreId = [...allowed][0] || null;
  if (state.inventories.some((x) => x.id === activeInventoryId && x.store_id === activeStoreId)) return;
  const storeInventories = state.inventories.filter((x) => x.store_id === activeStoreId && x.status === "active");
  activeInventoryId = storeInventories.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0]?.id || null;
}

function renderAll() {
  const isOffline = !online();
  el.offlineBanner.classList.toggle("hidden", !isOffline);
  el.offlineBanner.textContent = "Brak internetu. Zmiany w spisach zostaną zsynchronizowane po odzyskaniu połączenia. Transakcje są dostępne tylko do odczytu.";
  el.profileSummary.textContent = profile ? `${profile.display_name || profile.email} · ${isAdmin() ? "administrator" : "pracownik"}` : "";
  el.adminButton.classList.toggle("hidden", !isAdmin());
  renderStores(); renderCategories(); renderInventory(); renderSensitiveProducts(); renderTransactions(); renderSettings(); renderReminders(); renderAdmin(); renderWorkspace();
  document.querySelectorAll("[data-online-only]").forEach((node) => { node.disabled = isOffline; });
  el.adminButton.disabled = isOffline;
  renderSyncStatus();
}

function renderStores() {
  const approved = state.stores.filter((s) => approvedStoreIds().has(s.id)).sort(compareStores);
  const filtered = approved.filter((s) => storeMatches(s, el.storeSearch.value));
  el.storeSelect.replaceChildren(...filtered.map((s) => new Option(s.name, s.id)));
  el.storeSelect.value = activeStoreId || "";
  el.noStoresState.classList.toggle("hidden", approved.length > 0);
}

function renderWorkspace() {
  const hasStore = approvedStoreIds().size > 0;
  const sensitive = activeView === "sensitive";
  const transactions = activeView === "transactions";
  el.inventoryView.classList.toggle("hidden", !hasStore || sensitive || transactions);
  el.sensitiveView.classList.toggle("hidden", !hasStore || !sensitive);
  el.transactionsView.classList.toggle("hidden", !hasStore || !transactions);
  el.inventoryTabButton.classList.toggle("active", !sensitive && !transactions);
  el.sensitiveTabButton.classList.toggle("active", sensitive);
  el.transactionsTabButton.classList.toggle("active", transactions);
}

function renderCategories() {
  const selected = el.category.value;
  const options = state.categories.sort((a, b) => a.name.localeCompare(b.name, "pl")).map((c) => new Option(c.name, c.id));
  el.category.replaceChildren(...options);
  el.category.value = state.categories.some((c) => c.id === selected) ? selected : state.categories[0]?.id || "";
  const filter = el.categoryFilter.value;
  el.categoryFilter.replaceChildren(new Option("Wszystkie kategorie", ""), ...state.categories.map((c) => new Option(c.name, c.id)));
  el.categoryFilter.value = filter;
}

function renderInventory() {
  const inventory = activeInventory();
  const archived = inventory?.status === "archived";
  const editable = canEditInventory(inventory);
  el.sessionName.value = inventory?.name || "";
  el.sessionName.disabled = !editable;
  el.addPanel.classList.toggle("hidden", !editable);
  el.archiveBanner.classList.toggle("hidden", !archived);
  el.finishSessionButton.classList.toggle("hidden", !inventory || archived);
  el.cancelSessionButton.classList.toggle("hidden", !inventory || archived);
  el.undoLastItemButton.classList.toggle("hidden", !editable || activeItems().length === 0);
  if (archived) {
    const missing = missingFlags(inventory.id), deadline = archiveDeadline(inventory), expired = deadline <= new Date();
    el.archiveStatus.textContent = `${missing ? `${missing} pozycji bez flagi` : "Wszystkie flagi nadane"} · koniec archiwum ${date(deadline)}${isAdmin() ? " · edycja administratora" : ""}`;
    el.restoreArchiveButton.classList.toggle("hidden", !isAdmin());
    el.deleteArchiveButton.classList.toggle("hidden", !(isAdmin() || (expired && missing === 0)));
  } else {
    el.restoreArchiveButton.classList.add("hidden");
    el.deleteArchiveButton.classList.add("hidden");
  }
  const queryText = el.searchInput.value.trim().toLocaleLowerCase("pl");
  let products = activeItems().filter((x) => `${x.name} ${x.ean}`.toLocaleLowerCase("pl").includes(queryText))
    .filter((x) => !el.categoryFilter.value || x.category_id === el.categoryFilter.value);
  products.sort(el.sortSelect.value === "name-asc"
    ? (a, b) => a.name.localeCompare(b.name, "pl")
    : el.sortSelect.value === "unit-desc"
      ? (a, b) => b.price - a.price
      : el.sortSelect.value === "total-desc"
        ? (a, b) => b.quantity * b.price - a.quantity * a.price
        : (a, b) => new Date(b.created_at) - new Date(a.created_at));
  el.productList.replaceChildren();
  for (const product of products) {
    const node = el.productTemplate.content.cloneNode(true);
    node.querySelector(".product-name").textContent = product.name;
    node.querySelector(".product-ean").textContent = `EAN/DAN: ${product.ean}`;
    node.querySelector(".quantity-badge").textContent = `${product.quantity} szt.`;
    node.querySelector(".product-price").textContent = `${money(product.price)} / szt.`;
    node.querySelector(".product-category").textContent = categoryName(product.category_id);
    node.querySelector(".product-total").textContent = money(product.quantity * product.price);
    node.querySelector(".edit-button").onclick = () => editProduct(product);
    node.querySelector(".delete-button").onclick = () => deleteProduct(product);
    node.querySelector(".edit-button").classList.toggle("hidden", !editable);
    node.querySelector(".delete-button").classList.toggle("hidden", !editable);
    const flag = node.querySelector(".flag-check");
    flag.classList.toggle("hidden", !archived);
    const checkbox = node.querySelector(".flag-checkbox");
    checkbox.checked = Boolean(product.flag_assigned);
    checkbox.onchange = () => setProductFlag(product, checkbox.checked);
    const verified = node.querySelector(".verified-check");
    verified.classList.toggle("hidden", !archived);
    const verifiedCheckbox = node.querySelector(".verified-checkbox");
    verifiedCheckbox.checked = Boolean(product.verified);
    verifiedCheckbox.onchange = () => setProductVerified(product, verifiedCheckbox.checked);
    el.productList.append(node);
  }
  const items = activeItems();
  el.itemsStat.textContent = items.length;
  el.quantityStat.textContent = items.reduce((sum, x) => sum + x.quantity, 0);
  el.valueStat.textContent = money(items.reduce((sum, x) => sum + x.quantity * x.price, 0));
  el.emptyState.classList.toggle("hidden", products.length > 0);
}

function row(title, detail, actions = []) {
  const wrapper = document.createElement("div"); wrapper.className = "session-history-row";
  const text = document.createElement("div"); text.innerHTML = "<strong></strong><span></span>";
  text.querySelector("strong").textContent = title; text.querySelector("span").textContent = detail;
  const buttons = document.createElement("div"); buttons.className = "row-actions";
  for (const [label, handler, danger = false] of actions) {
    const button = document.createElement("button"); button.type = "button"; button.className = danger ? "danger-button compact" : "ghost-button compact"; button.textContent = label; button.onclick = handler; buttons.append(button);
  }
  wrapper.append(text, buttons); return wrapper;
}

function renderSettings() {
  el.storeSettings.replaceChildren();
  for (const store of state.stores.filter((x) => approvedStoreIds().has(x.id) && storeMatches(x, el.storeSettingsSearch.value)).sort(compareStores)) {
    el.storeSettings.append(row(store.name, `Dostęp aktywny · archiwum ${store.retention_days} dni`));
  }
  el.sessionSettings.replaceChildren();
  for (const inventory of state.inventories.filter((x) => x.store_id === activeStoreId && x.status === "active").sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
    el.sessionSettings.append(row(inventory.name, `${date(inventory.created_at)} · aktywny`, [["Otwórz", () => openInventory(inventory.id)]]));
  }
  el.archiveSettings.replaceChildren();
  for (const inventory of state.inventories.filter((x) => x.store_id === activeStoreId && x.status === "archived").sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at))) {
    const missing = missingFlags(inventory.id);
    const actions = [["Otwórz", () => openInventory(inventory.id)]];
    if (isAdmin()) {
      actions.push(["Przywróć", () => { openInventory(inventory.id); restoreArchivedInventory(); }]);
      actions.push(["Usuń", () => { openInventory(inventory.id); deleteArchivedInventory(); }, true]);
    }
    el.archiveSettings.append(row(inventory.name, `${date(inventory.archived_at)} · ${missing ? `${missing} bez flagi` : "flagi kompletne"}`, actions));
  }
}

function renderSensitiveProducts() {
  el.sensitiveProductList.replaceChildren();
  const checks = new Map(state.sensitiveChecks.filter((check) => check.store_id === activeStoreId).map((check) => [check.product_id, check]));
  const products = [...state.sensitiveProducts].sort((a, b) => a.name.localeCompare(b.name, "pl"));
  for (const product of products) {
    const check = checks.get(product.id);
    const card = document.createElement("article");
    card.className = `product-card sensitive-card${check?.quantity > 2 ? " alert" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Wybierz produkt ${product.name}`);
    const media = document.createElement("div"); media.className = "sensitive-product-media";
    if (product.image_path) {
      const image = document.createElement("img");
      image.src = sensitiveImageUrl(product.image_path);
      image.alt = product.name;
      image.loading = "lazy";
      image.onerror = () => media.replaceChildren(createSensitivePlaceholder());
      media.append(image);
    } else media.append(createSensitivePlaceholder());
    const main = document.createElement("div"); main.className = "product-main";
    const title = document.createElement("h3"); title.textContent = product.name;
    const ean = document.createElement("p"); ean.className = "sensitive-ean"; ean.textContent = `EAN: ${product.ean}`;
    const barcodeFrame = document.createElement("div"); barcodeFrame.className = "barcode-frame";
    const barcode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    barcode.classList.add("sensitive-barcode");
    barcodeFrame.append(barcode);
    main.append(title, ean, barcodeFrame);
    window.SpisownikBarcode?.draw(barcode, product.ean);
    const status = document.createElement("strong");
    status.className = `sensitive-status${check ? check.quantity > 2 ? " alert" : " ok" : ""}`;
    status.textContent = check ? `${check.quantity} szt. · ${check.quantity > 2 ? "ALARM" : "OK"}` : "Do sprawdzenia";
    const details = document.createElement("div"); details.className = "sensitive-product-details"; details.append(main, status);
    card.append(media, details);
    const select = () => {
      el.sensitiveEan.value = product.ean;
      resolveSensitiveEan();
      card.classList.add("selected");
      setTimeout(() => card.classList.remove("selected"), 700);
    };
    card.onclick = select;
    card.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } };
    el.sensitiveProductList.append(card);
  }
  el.sensitiveProgress.textContent = `${checks.size} / ${products.length}`;
  el.sensitiveEmptyState.classList.toggle("hidden", products.length > 0);
}

function createSensitivePlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = "sensitive-image-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = "Brak zdjęcia";
  return placeholder;
}

function transactionTypeLabel(item) {
  return item.entry_type === "receipt" ? "Paragon" : "Aplikacja";
}

function transactionDetail(item, history = false) {
  const parts = [];
  if (item.receipt_date) parts.push(`Data paragonu: ${date(`${item.receipt_date}T12:00:00`)}`);
  if (item.note) parts.push(`Notatka: ${item.note}`);
  parts.push(`Dodał(a): ${item.created_by_name} · ${dateTime(item.created_at)}`);
  if (history) parts.push(`Sprawdził(a): ${item.checked_by_name} · ${dateTime(item.checked_at)}`);
  else if (!transactionIsEligible(item)) parts.push("Zacznie być liczony następnego dnia.");
  return parts.join("\n");
}

function renderTransactions() {
  const all = activeStoreTransactions();
  const pending = all.filter((item) => !item.checked_at).sort((a, b) =>
    Number(transactionIsEligible(b)) - Number(transactionIsEligible(a)) || new Date(b.created_at) - new Date(a.created_at));
  const history = all.filter((item) => item.checked_at).sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at));
  const eligible = pending.filter(transactionIsEligible);
  el.transactionEligibleStat.textContent = eligible.length;
  el.transactionPendingStat.textContent = pending.length;
  el.transactionCheckedStat.textContent = history.length;
  el.transactionThresholdStatus.textContent = eligible.length >= 5 ? `Próg osiągnięty: ${eligible.length}` : `${eligible.length} / 5`;
  el.transactionDate.max = localDate();
  el.transactionPendingList.replaceChildren(...pending.map((item) => {
    const entry = row(`${transactionTypeLabel(item)} · ${item.reference_number}`, transactionDetail(item), [
      ["Sprawdzone", () => checkSuspiciousTransaction(item)],
      ["Edytuj", () => editSuspiciousTransaction(item)],
      ["Usuń", () => deleteSuspiciousTransaction(item), true],
    ]);
    entry.querySelectorAll("button").forEach((button) => { button.disabled = !online(); });
    entry.classList.toggle("transaction-due", transactionIsEligible(item));
    return entry;
  }));
  el.transactionHistoryList.replaceChildren(...history.map((item) =>
    row(`${transactionTypeLabel(item)} · ${item.reference_number}`, transactionDetail(item, true))));
  el.transactionPendingEmpty.classList.toggle("hidden", pending.length > 0);
  el.transactionHistoryEmpty.classList.toggle("hidden", history.length > 0);
  updateTransactionTypeFields();
}

function renderReminders() {
  const awaiting = state.inventories.filter((x) => x.store_id === activeStoreId && x.status === "archived" && missingFlags(x.id));
  const transactions = eligibleTransactions();
  const reminderCount = awaiting.length + transactions.length;
  el.reminderBadge.textContent = reminderCount;
  el.remindersButton.classList.toggle("has-badge", reminderCount > 0);
  el.reminderList.replaceChildren(...awaiting.map((x) => row(x.name, `${missingFlags(x.id)} pozycji bez flagi · archiwum do ${date(archiveDeadline(x))}`, [["Otwórz", () => { openInventory(x.id); el.remindersDialog.close(); }]])));
  el.transactionReminderText.textContent = `${transactions.length} wpisów kwalifikuje się do sprawdzenia${transactions.length >= 5 ? " — osiągnięto próg przypomnienia." : "."}`;
  el.transactionReminderList.replaceChildren(...transactions.map((item) =>
    row(`${transactionTypeLabel(item)} · ${item.reference_number}`, transactionDetail(item), [["Otwórz", () => {
      activeView = "transactions"; renderAll(); el.remindersDialog.close();
    }]])));
  el.inventoryReminderSection.classList.toggle("hidden", awaiting.length === 0);
  el.transactionReminderSection.classList.toggle("hidden", transactions.length === 0);
  el.noRemindersText.classList.toggle("hidden", reminderCount > 0);
}

function renderAdmin() {
  el.adminStoreList.replaceChildren(...state.stores.filter((x) => storeMatches(x, el.adminStoreSearch.value)).sort(compareStores).map((store) => {
    const wrapper = document.createElement("form"); wrapper.className = "admin-store-row";
    wrapper.innerHTML = `<input name="name" maxlength="80" required /><input name="retention" type="number" min="1" max="365" required aria-label="Dni archiwum" /><button class="ghost-button compact" type="submit">Zapisz</button><button class="danger-button compact" type="button">Usuń</button>`;
    wrapper.elements.name.value = store.name; wrapper.elements.retention.value = store.retention_days;
    wrapper.onsubmit = (event) => adminEditStore(event, store);
    wrapper.querySelector(".danger-button").onclick = () => adminDeleteStore(store);
    return wrapper;
  }));
  const selectedEmployee = el.adminEmployeeSelect.value;
  const selectedStore = el.adminMembershipStore.value;
  const workers = [...state.profiles].sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email, "pl"));
  el.adminEmployeeSelect.replaceChildren(new Option("Wybierz pracownika", ""), ...workers.map((worker) => new Option(worker.display_name || worker.email, worker.id)));
  el.adminEmployeeSelect.value = workers.some((worker) => worker.id === selectedEmployee) ? selectedEmployee : "";
  el.adminMembershipStore.replaceChildren(new Option("Wybierz sklep", ""), ...[...state.stores].sort(compareStores).map((store) => new Option(store.name, store.id)));
  el.adminMembershipStore.value = state.stores.some((store) => store.id === selectedStore) ? selectedStore : "";
  const memberships = state.memberships.filter((membership) =>
    membership.status === "approved" && state.profiles.some((profileItem) => profileItem.id === membership.user_id)
  ).sort((a, b) => {
    const first = state.profiles.find((profileItem) => profileItem.id === a.user_id);
    const second = state.profiles.find((profileItem) => profileItem.id === b.user_id);
    return (first?.display_name || first?.email || "").localeCompare(second?.display_name || second?.email || "", "pl") || storeName(a.store_id).localeCompare(storeName(b.store_id), "pl");
  });
  el.adminMembershipList.replaceChildren(...memberships.map((membership) => {
    const worker = state.profiles.find((profileItem) => profileItem.id === membership.user_id);
    return row(worker?.display_name || worker?.email || membership.user_id, storeName(membership.store_id), [["Usuń", () => adminRemoveMembership(membership), true]]);
  }));
  el.adminCategoryList.replaceChildren(...[...state.categories].sort((a, b) => a.name.localeCompare(b.name, "pl")).map((category) =>
    row(category.name, category.is_fallback ? "Kategoria chroniona" : "Kategoria globalna", category.is_fallback ? [] : [["Zmień", () => adminRenameCategory(category)], ["Usuń", () => adminDeleteCategory(category), true]])));
  el.sensitiveAdminList.replaceChildren(...state.sensitiveProducts.sort((a, b) => a.name.localeCompare(b.name, "pl")).map((product) =>
    row(product.name, `EAN: ${product.ean}${product.image_path ? " · zdjęcie dodane" : " · bez zdjęcia"}`, [["Edytuj", () => editSensitiveProduct(product)], ["Usuń", () => deleteSensitiveProduct(product), true]])));
}

async function authSubmit(event) {
  event.preventDefault(); el.authError.textContent = "";
  if (!configured) return el.authError.textContent = "Brak konfiguracji Supabase.";
  const credentials = { email: el.email.value.trim(), password: el.password.value };
  const result = signupMode ? await db.auth.signUp({ ...credentials, options: { data: { display_name: el.displayName.value.trim() } } }) : await db.auth.signInWithPassword(credentials);
  if (result.error) el.authError.textContent = result.error.message;
  else if (signupMode && !result.data.session) showToast("Sprawdź pocztę i potwierdź rejestrację.");
}

async function onAuth(session) {
  user = session?.user || null;
  el.authView.classList.toggle("hidden", Boolean(user)); el.appView.classList.toggle("hidden", !user);
  el.settingsButton.classList.toggle("hidden", !user); el.remindersButton.classList.toggle("hidden", !user); if (!user) el.adminButton.classList.add("hidden");
  if (user) {
    el.savedStatus.textContent = "Pobieranie danych…";
    await loadData();
  } else {
    profile = null; state = emptyState(); pendingCount = 0; syncing = false; syncError = "";
  }
}

function scheduleAuth(session) {
  const key = session?.access_token || "signed-out";
  if (key === scheduledAuthKey) return;
  scheduledAuthKey = key;
  setTimeout(() => onAuth(session).catch((error) => report(error, "Nie udało się uruchomić aplikacji.")), 0);
}

async function refreshCategoryData() {
  state.categories = await query("categories", "*");
  await saveSnapshot();
  renderCategories();
  renderInventory();
  renderAdmin();
}

async function adminAddMembership() {
  if (!requireOnline()) return;
  const userId = el.adminEmployeeSelect.value;
  const storeId = el.adminMembershipStore.value;
  if (!userId || !storeId) return showToast("Wybierz pracownika i sklep.");
  const { error } = await db.from("store_memberships").upsert({
    user_id: userId, store_id: storeId, status: "approved", requested_at: now(), reviewed_at: now(), reviewed_by: user.id,
  });
  if (error) return report(error);
  showToast("Pracownik został przypisany do sklepu.");
  await loadData();
}

async function adminRemoveMembership(membership) {
  const worker = state.profiles.find((profileItem) => profileItem.id === membership.user_id);
  if (!requireOnline() || !confirm(`Usunąć przypisanie „${worker?.display_name || worker?.email || membership.user_id}” do sklepu „${storeName(membership.store_id)}”?`)) return;
  const { error } = await db.from("store_memberships").delete().eq("user_id", membership.user_id).eq("store_id", membership.store_id);
  if (error) return report(error);
  showToast("Przypisanie zostało usunięte.");
  await loadData();
}

async function adminAddCategory() {
  if (!requireOnline()) return;
  const name = el.adminCategoryName.value.trim();
  if (!name) return;
  if (state.categories.some((category) => category.name.toLocaleLowerCase("pl") === name.toLocaleLowerCase("pl"))) return showToast("Kategoria o tej nazwie już istnieje.");
  const { error } = await db.from("categories").insert({ name });
  if (error) return report(error);
  el.adminCategoryName.value = "";
  showToast("Kategoria została dodana.");
  await refreshCategoryData();
}

async function adminRenameCategory(category) {
  if (!requireOnline()) return;
  const name = prompt("Nowa nazwa kategorii:", category.name)?.trim();
  if (!name || name === category.name) return;
  if (state.categories.some((item) => item.id !== category.id && item.name.toLocaleLowerCase("pl") === name.toLocaleLowerCase("pl"))) return showToast("Kategoria o tej nazwie już istnieje.");
  const { error } = await db.from("categories").update({ name }).eq("id", category.id);
  if (error) return report(error);
  showToast("Nazwa kategorii została zmieniona.");
  await refreshCategoryData();
}

async function adminDeleteCategory(category) {
  if (!requireOnline() || !confirm(`Usunąć kategorię „${category.name}”? Wszystkie przypisane produkty zostaną przeniesione do „Inne”.`)) return;
  const { error } = await db.rpc("admin_delete_category", { target_category: category.id });
  if (error) return report(error);
  showToast("Kategoria została usunięta, a produkty przeniesione do „Inne”.");
  await loadData();
}

async function adminEditStore(event, store) {
  event.preventDefault(); if (!requireOnline()) return;
  const name = event.currentTarget.elements.name.value.trim();
  const retention = Number(event.currentTarget.elements.retention.value);
  if (!name || !Number.isInteger(retention) || retention < 1 || retention > 365) return showToast("Podaj nazwę oraz od 1 do 365 dni.");
  if (state.stores.some((item) => item.id !== store.id && item.name.toLocaleLowerCase("pl") === name.toLocaleLowerCase("pl"))) return showToast("Sklep o tej nazwie już istnieje.");
  const { error } = await db.from("stores").update({ name, retention_days: retention }).eq("id", store.id); if (error) return report(error); await loadData();
}
async function adminDeleteStore(store) { if (!requireOnline() || !confirm(`Trwale usunąć sklep „${store.name}” i wszystkie jego dane?`)) return; const { error } = await db.from("stores").delete().eq("id", store.id); if (error) return report(error); await loadData(); }

function openInventory(id) { activeInventoryId = id; renderAll(); if (el.settingsDialog.open) el.settingsDialog.close(); }
async function finishInventory() {
  const inventory = activeInventory();
  if (!inventory || inventory.status !== "active" || !requireOnline()) return;
  if ((await queuedOperationsForInventory(inventory.id)).length || syncing) return showToast("Najpierw zsynchronizuj zmiany tego spisu.");
  if (!confirm("Zakończyć spis i przenieść go do archiwum?")) return;
  const { error } = await db.rpc("archive_inventory", { target_inventory: inventory.id });
  if (error) return report(error);
  showToast("Spis został przeniesiony do archiwum."); await loadData();
}
async function cancelInventory() {
  const inventory = activeInventory();
  if (!inventory || inventory.status !== "active" || !requireOnline()) return;
  if (!confirm(`Anulować spis „${inventory.name}”? Spis i jego pozycje zostaną usunięte.`)) return;
  if (isAdmin() && activeItems().length === 0) return deleteBrokenEmptyInventory(inventory);
  if ((await queuedOperationsForInventory(inventory.id)).length || syncing) return showToast("Najpierw zsynchronizuj zmiany tego spisu.");
  const { error } = await db.rpc("cancel_inventory", { target_inventory: inventory.id });
  if (error) return report(error);
  activeInventoryId = null; showToast("Spis został anulowany."); await loadData();
}

async function deleteBrokenEmptyInventory(inventory) {
  const { data: serverInventory, error: inventoryError } = await db.from("inventories").select("id,status").eq("id", inventory.id).maybeSingle();
  if (inventoryError) return report(inventoryError, "Nie udało się sprawdzić spisu.");
  if (!serverInventory) {
    await discardOperationsForInventory(inventory.id);
    activeInventoryId = null;
    showToast("Usunięto lokalny pusty spis.");
    return loadData();
  }
  const { count, error: countError } = await db.from("inventory_items").select("id", { count: "exact", head: true }).eq("inventory_id", inventory.id);
  if (countError) return report(countError, "Nie udało się sprawdzić pozycji spisu.");
  if (count !== 0) return showToast("Spis nie jest pusty i nie może zostać usunięty tą operacją.");
  const rpc = serverInventory.status === "archived" ? "delete_archived_inventory" : "delete_empty_active_inventory";
  const { error } = await db.rpc(rpc, { target_inventory: inventory.id });
  if (error) return report(error, "Nie udało się usunąć pustego spisu.");
  await discardOperationsForInventory(inventory.id);
  activeInventoryId = null;
  showToast("Pusty spis został bezpiecznie usunięty.");
  await loadData();
}
async function setProductFlag(product, assigned) {
  const changed = { ...product, flag_assigned: assigned, updated_at: now() };
  upsertLocal(state.items, changed); renderAll();
  await enqueue("flag_update", changed);
}
async function setProductVerified(product, verified) {
  const changed = { ...product, verified, updated_at: now() };
  upsertLocal(state.items, changed); renderAll();
  await enqueue("verified_update", changed);
}
async function deleteArchivedInventory() {
  const inventory = activeInventory();
  if (!inventory || !requireOnline() || !confirm("Trwale usunąć ten spis z archiwum? Tej operacji nie można cofnąć.")) return;
  const { error } = await db.rpc("delete_archived_inventory", { target_inventory: inventory.id });
  if (error) return report(error);
  activeInventoryId = null; showToast("Spis został trwale usunięty."); await loadData();
}
async function restoreArchivedInventory() {
  const inventory = activeInventory();
  if (!inventory || inventory.status !== "archived" || !isAdmin() || !requireOnline()) return;
  if (pendingCount || syncing) return showToast("Najpierw zsynchronizuj wszystkie zmiany.");
  if (!confirm(`Przywrócić spis „${inventory.name}” do aktywnych?`)) return;
  const { error } = await db.rpc("restore_archived_inventory", { target_inventory: inventory.id });
  if (error) return report(error);
  showToast("Spis został przywrócony."); await loadData();
}

async function newInventory() {
  if (!activeStoreId) return;
  const timestamp = now();
  const inventory = { id: crypto.randomUUID(), store_id: activeStoreId, name: defaultInventoryName(), status: "active", created_by: user.id, created_at: timestamp, updated_at: timestamp };
  upsertLocal(state.inventories, inventory); activeInventoryId = inventory.id; renderAll();
  await enqueue("inventory_upsert", inventory);
}
async function renameInventory() {
  const inventory = activeInventory(); if (!canEditInventory(inventory)) return;
  const changed = { ...inventory, name: el.sessionName.value.trim() || defaultInventoryName(), updated_at: now() };
  upsertLocal(state.inventories, changed); renderAll();
  await enqueue("inventory_upsert", changed);
}

function resetForm() { el.productForm.reset(); el.quantity.value = 1; el.editingId.value = ""; el.formTitle.textContent = "Dodaj produkt"; el.submitButton.textContent = "Dodaj do spisu"; el.cancelEditButton.classList.add("hidden"); el.formError.textContent = ""; renderCategories(); }
function editProduct(product) { el.editingId.value = product.id; el.ean.value = product.ean; el.name.value = product.name; el.category.value = product.category_id; el.quantity.value = product.quantity; el.price.value = String(product.price).replace(".", ","); el.formTitle.textContent = "Edytuj produkt"; el.submitButton.textContent = "Zapisz zmiany"; el.cancelEditButton.classList.remove("hidden"); }
async function deleteProduct(product) {
  if (!canEditInventory()) return;
  if (!confirm(`Usunąć „${product.name}” ze spisu?`)) return;
  const deleted = { ...product, store_id: activeStoreId, updated_at: now(), deleted_at: now() };
  state.items = state.items.filter((item) => item.id !== product.id); resetForm(); renderAll();
  await enqueue("item_upsert", deleted);
}
async function undoLastItem() {
  if (!canEditInventory()) return;
  const last = [...activeItems()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!last) return showToast("Nie ma pozycji do usunięcia.");
  if (!confirm(`Usunąć ostatnio dodaną pozycję „${last.name}”?`)) return;
  const deleted = { ...last, store_id: activeStoreId, updated_at: now(), deleted_at: now() };
  state.items = state.items.filter((item) => item.id !== last.id); resetForm(); renderAll();
  await enqueue("item_upsert", deleted);
}

async function submitProduct(event) {
  event.preventDefault(); if (!activeInventoryId || !canEditInventory()) return;
  const quantity = Number(el.quantity.value), price = Number(el.price.value.replace(",", "."));
  const product = { ean: el.ean.value.trim(), name: el.name.value.trim(), category_id: el.category.value, quantity, price };
  if (!product.ean || !product.name || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price < 0) return el.formError.textContent = "Uzupełnij poprawnie wszystkie pola.";
  const editingId = el.editingId.value;
  const existing = editingId ? state.items.find((item) => item.id === editingId) : null;
  const timestamp = now();
  const item = {
    ...existing, ...product, id: editingId || crypto.randomUUID(), inventory_id: activeInventoryId, store_id: activeStoreId,
    created_at: existing?.created_at || timestamp, updated_at: timestamp, deleted_at: null,
  };
  upsertLocal(state.items, item);
  const catalogIndex = state.catalog.findIndex((entry) => entry.ean === item.ean);
  const localCatalog = { ean: item.ean, name: item.name, category_id: item.category_id, updated_at: timestamp, updated_by: user.id };
  if (catalogIndex === -1) state.catalog.push(localCatalog); else state.catalog[catalogIndex] = localCatalog;
  const priceIndex = state.prices.findIndex((entry) => entry.store_id === activeStoreId && entry.ean === item.ean);
  const localPrice = { store_id: activeStoreId, ean: item.ean, price: item.price, updated_at: timestamp, updated_by: user.id };
  if (priceIndex === -1) state.prices.push(localPrice); else state.prices[priceIndex] = localPrice;
  resetForm(); renderAll();
  await enqueue("item_upsert", item);
}

async function resolveEan() {
  const ean = el.ean.value.trim(); if (!ean) return;
  const existing = activeItems().find((x) => x.ean === ean); if (existing) return editProduct(existing);
  const catalog = state.catalog.find((x) => x.ean === ean);
  if (catalog) {
    el.name.value = catalog.name; el.category.value = catalog.category_id;
    const price = state.prices.find((x) => x.store_id === activeStoreId && x.ean === ean); if (price) el.price.value = String(price.price).replace(".", ",");
    el.lookupStatus.textContent = "Uzupełniono ze wspólnego katalogu."; return;
  }
  if (!navigator.onLine) return;
  for (const source of ["openbeautyfacts", "openfoodfacts"]) {
    try { const response = await fetch(`https://world.${source}.org/api/v2/product/${encodeURIComponent(ean)}.json?fields=product_name,product_name_pl,brands`); const data = await response.json(); const found = [data.product?.product_name_pl || data.product?.product_name, data.product?.brands].filter(Boolean).join(" — "); if (found) { el.name.value = found; el.lookupStatus.textContent = "Znaleziono nazwę produktu. Sprawdź dane."; return; } } catch {}
  }
}

async function submitSensitiveCheck(event) {
  event.preventDefault();
  el.sensitiveFormError.textContent = "";
  if (!activeStoreId || !requireOnline()) return;
  const ean = el.sensitiveEan.value.trim();
  const quantity = Number(el.sensitiveQuantity.value);
  const product = state.sensitiveProducts.find((item) => item.ean === ean);
  if (!product) return el.sensitiveFormError.textContent = "Ten kod nie znajduje się na liście produktów wrażliwych.";
  if (!Number.isInteger(quantity) || quantity < 0) return el.sensitiveFormError.textContent = "Podaj prawidłową liczbę sztuk.";
  const { error } = await db.rpc("submit_sensitive_product_check", { target_store: activeStoreId, target_product: product.id, shelf_quantity: quantity });
  if (error) return report(error, "Nie udało się zapisać kontroli.");
  showToast(quantity > 2 ? "Zapisano. Ilość przekracza limit 2 sztuk." : "Kontrola zapisana.");
  el.sensitiveCheckForm.reset();
  await loadData();
}

function resolveSensitiveEan() {
  const ean = el.sensitiveEan.value.trim();
  if (!ean) return;
  const product = state.sensitiveProducts.find((item) => item.ean === ean);
  el.sensitiveFormError.textContent = product ? `Produkt: ${product.name}` : "Ten kod nie znajduje się na liście produktów wrażliwych.";
  if (product) el.sensitiveQuantity.focus();
}

async function saveSensitiveProduct(event) {
  event.preventDefault();
  if (!requireOnline()) return;
  el.sensitiveAdminError.textContent = "";
  const editing = state.sensitiveProducts.find((product) => product.id === el.sensitiveAdminEditingId.value);
  const ean = el.sensitiveAdminEan.value.trim();
  const name = el.sensitiveAdminName.value.trim();
  const image = el.sensitiveAdminImage.files[0];
  if (!ean || !name) return el.sensitiveAdminError.textContent = "Podaj kod EAN i nazwę produktu.";
  if (state.sensitiveProducts.some((product) => product.id !== editing?.id && product.ean === ean)) return el.sensitiveAdminError.textContent = "Produkt z tym kodem EAN już istnieje.";
  if (image && !["image/jpeg", "image/png", "image/webp"].includes(image.type)) return el.sensitiveAdminError.textContent = "Zdjęcie musi być plikiem JPEG, PNG lub WebP.";
  if (image && image.size > 5 * 1024 * 1024) return el.sensitiveAdminError.textContent = "Zdjęcie może mieć maksymalnie 5 MB.";

  let uploadedPath = "";
  let imagePath = editing?.image_path || null;
  if (image) {
    const extension = image.type === "image/png" ? "png" : image.type === "image/webp" ? "webp" : "jpg";
    uploadedPath = `${crypto.randomUUID()}.${extension}`;
    const upload = await db.storage.from("sensitive-product-images").upload(uploadedPath, image, { contentType: image.type, upsert: false });
    if (upload.error) return report(upload.error, "Nie udało się przesłać zdjęcia.");
    imagePath = uploadedPath;
  } else if (editing && el.sensitiveRemoveImage.checked) imagePath = null;

  const payload = { ean, name, image_path: imagePath };
  const result = editing
    ? await db.from("sensitive_products").update(payload).eq("id", editing.id)
    : await db.from("sensitive_products").insert({ ...payload, created_by: user.id });
  if (result.error) {
    if (uploadedPath) await db.storage.from("sensitive-product-images").remove([uploadedPath]);
    return report(result.error, editing ? "Nie udało się zapisać zmian produktu." : "Nie udało się dodać produktu wrażliwego.");
  }
  if (editing?.image_path && editing.image_path !== imagePath) {
    const removal = await db.storage.from("sensitive-product-images").remove([editing.image_path]);
    if (removal.error) report(removal.error, "Produkt zapisano, ale nie udało się usunąć starego zdjęcia.");
  }
  resetSensitiveAdminForm();
  await loadData();
}

function editSensitiveProduct(product) {
  el.sensitiveAdminEditingId.value = product.id;
  el.sensitiveAdminEan.value = product.ean;
  el.sensitiveAdminName.value = product.name;
  el.sensitiveAdminImage.value = "";
  el.sensitiveRemoveImage.checked = false;
  el.sensitiveRemoveImageLabel.classList.toggle("hidden", !product.image_path);
  el.sensitiveAdminSubmit.textContent = "Zapisz zmiany";
  el.sensitiveAdminCancel.classList.remove("hidden");
  el.sensitiveAdminError.textContent = "";
  el.sensitiveAdminEan.focus();
}

function resetSensitiveAdminForm() {
  el.sensitiveAdminForm.reset();
  el.sensitiveAdminEditingId.value = "";
  el.sensitiveAdminSubmit.textContent = "Dodaj";
  el.sensitiveAdminCancel.classList.add("hidden");
  el.sensitiveRemoveImageLabel.classList.add("hidden");
  el.sensitiveAdminError.textContent = "";
}

async function deleteSensitiveProduct(product) {
  if (!requireOnline() || !confirm(`Usunąć „${product.name}” z listy produktów wrażliwych?`)) return;
  const { error } = await db.from("sensitive_products").delete().eq("id", product.id);
  if (error) return report(error, "Nie udało się usunąć produktu.");
  if (product.image_path) {
    const removal = await db.storage.from("sensitive-product-images").remove([product.image_path]);
    if (removal.error) report(removal.error, "Produkt usunięto, ale nie udało się usunąć jego zdjęcia.");
  }
  if (el.sensitiveAdminEditingId.value === product.id) resetSensitiveAdminForm();
  await loadData();
}

function updateTransactionTypeFields() {
  const receipt = el.transactionType.value === "receipt";
  el.transactionDateField.classList.toggle("hidden", !receipt);
  el.transactionDate.required = receipt;
  if (!receipt) el.transactionDate.value = "";
  el.transactionDateNote.textContent = receipt && el.transactionDate.value === localDate()
    ? "Dzisiejszy paragon zacznie być liczony jutro."
    : "";
}

function resetTransactionForm() {
  el.transactionForm.reset();
  el.transactionEditingId.value = "";
  el.transactionType.value = "receipt";
  el.transactionDate.max = localDate();
  el.transactionFormTitle.textContent = "Dodaj wpis";
  el.transactionSubmitButton.textContent = "Dodaj wpis";
  el.transactionCancelEdit.classList.add("hidden");
  el.transactionFormError.textContent = "";
  updateTransactionTypeFields();
}

function editSuspiciousTransaction(item) {
  el.transactionEditingId.value = item.id;
  el.transactionType.value = item.entry_type;
  el.transactionNumber.value = item.reference_number;
  el.transactionDate.value = item.receipt_date || "";
  el.transactionNote.value = item.note || "";
  el.transactionFormTitle.textContent = "Edytuj wpis";
  el.transactionSubmitButton.textContent = "Zapisz zmiany";
  el.transactionCancelEdit.classList.remove("hidden");
  el.transactionFormError.textContent = "";
  updateTransactionTypeFields();
  el.transactionForm.scrollIntoView({ behavior: "smooth", block: "start" });
  el.transactionNumber.focus();
}

async function submitSuspiciousTransaction(event) {
  event.preventDefault();
  el.transactionFormError.textContent = "";
  if (!activeStoreId || !requireOnline()) return;
  const id = el.transactionEditingId.value;
  const type = el.transactionType.value;
  const number = el.transactionNumber.value.trim();
  const receiptDate = type === "receipt" ? el.transactionDate.value : null;
  const note = el.transactionNote.value.trim() || null;
  if (!number) return el.transactionFormError.textContent = "Podaj numer paragonu lub aplikacji.";
  if (type === "receipt" && (!receiptDate || receiptDate > localDate())) return el.transactionFormError.textContent = "Podaj datę paragonu nie późniejszą niż dzisiaj.";
  const duplicate = activeStoreTransactions().some((item) =>
    item.id !== id && !item.checked_at && item.entry_type === type
      && item.reference_number.trim().toLocaleLowerCase("pl") === number.toLocaleLowerCase("pl"));
  if (duplicate) return el.transactionFormError.textContent = "Taki oczekujący numer już istnieje.";
  const rpc = id ? "update_suspicious_transaction" : "add_suspicious_transaction";
  const args = id
    ? { target_id: id, target_type: type, target_number: number, target_receipt_date: receiptDate, target_note: note }
    : { target_store: activeStoreId, target_type: type, target_number: number, target_receipt_date: receiptDate, target_note: note };
  const { error } = await db.rpc(rpc, args);
  if (error) return report(error, "Nie udało się zapisać wpisu.");
  showToast(id ? "Wpis został zaktualizowany." : "Wpis został dodany.");
  resetTransactionForm();
  await loadData();
}

async function deleteSuspiciousTransaction(item) {
  if (!requireOnline() || !confirm(`Usunąć oczekujący wpis „${item.reference_number}”?`)) return;
  const { error } = await db.rpc("delete_suspicious_transaction", { target_id: item.id });
  if (error) return report(error, "Nie udało się usunąć wpisu.");
  if (el.transactionEditingId.value === item.id) resetTransactionForm();
  showToast("Wpis został usunięty.");
  await loadData();
}

async function checkSuspiciousTransaction(item) {
  if (!requireOnline() || !confirm(`Oznaczyć numer „${item.reference_number}” jako sprawdzony?`)) return;
  const { error } = await db.rpc("check_suspicious_transaction", { target_id: item.id });
  if (error) return report(error, "Nie udało się oznaczyć wpisu jako sprawdzony.");
  if (el.transactionEditingId.value === item.id) resetTransactionForm();
  showToast("Wpis został oznaczony jako sprawdzony.");
  await loadData();
}

async function maybeShowDailyReminder() {
  if (!online() || !activeStoreId) return;
  const today = localDate();
  const hasInventoryReminder = state.inventories.some((x) => x.store_id === activeStoreId && x.status === "archived" && missingFlags(x.id));
  const hasTransactionReminder = eligibleTransactions().length >= 5;
  if (!hasInventoryReminder && !hasTransactionReminder) return;
  const checks = await Promise.all([
    hasInventoryReminder
      ? db.from("reminder_views").select("reminder_date").eq("user_id", user.id).eq("store_id", activeStoreId).eq("reminder_date", today)
      : Promise.resolve({ data: [], error: null }),
    hasTransactionReminder
      ? db.from("transaction_reminder_views").select("reminder_date").eq("user_id", user.id).eq("store_id", activeStoreId).eq("reminder_date", today)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (checks.some((result) => result.error)) return;
  const saves = [];
  if (hasInventoryReminder && !checks[0].data.length) saves.push(db.from("reminder_views").insert({ user_id: user.id, store_id: activeStoreId, reminder_date: today }));
  if (hasTransactionReminder && !checks[1].data.length) saves.push(db.from("transaction_reminder_views").insert({ user_id: user.id, store_id: activeStoreId, reminder_date: today }));
  if (!saves.length) return;
  const saved = await Promise.all(saves);
  if (saved.every((result) => !result.error) && !el.remindersDialog.open) el.remindersDialog.showModal();
}

async function migrateLegacy() {
  if (!requireOnline() || localStorage.getItem(MIGRATION_KEY)) return showToast("Import został już wykonany.");
  const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); if (!legacy?.sessions?.length) return showToast("Nie znaleziono lokalnych danych.");
  let importedStores = 0;
  for (const oldStore of legacy.stores || []) {
    let store = state.stores.find((x) => x.name === oldStore.name);
    if (!store && isAdmin()) { const result = await db.from("stores").insert({ name: oldStore.name, created_by: user.id }).select().single(); if (result.error) return report(result.error); store = result.data; }
    if (!store || (!isAdmin() && !approvedStoreIds().has(store.id))) continue;
    importedStores += 1;
    for (const oldSession of legacy.sessions.filter((x) => x.storeId === oldStore.id)) {
      const inserted = await db.from("inventories").insert({ store_id: store.id, name: oldSession.name, created_by: user.id, created_at: new Date(oldSession.createdAt).toISOString() }).select().single();
      if (inserted.error) return report(inserted.error);
      for (const item of oldSession.products || []) {
        const category = state.categories.find((x) => x.name.toLocaleLowerCase("pl") === item.category?.toLocaleLowerCase("pl")) || state.categories.find((x) => x.is_fallback);
        await db.from("catalog_products").upsert({ ean: item.ean, name: item.name, category_id: category.id, updated_by: user.id });
        await db.from("store_prices").upsert({ store_id: store.id, ean: item.ean, price: item.price, updated_by: user.id });
        await db.from("inventory_items").insert({ inventory_id: inserted.data.id, ean: item.ean, name: item.name, category_id: category.id, quantity: item.quantity, price: item.price });
      }
    }
  }
  if (!importedStores) return showToast("Nie znaleziono pasujących sklepów z aktywnym dostępem.");
  localStorage.setItem(MIGRATION_KEY, "true"); showToast("Import zakończony."); await loadData();
}

function exportBackup() { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), profile, state }, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `spisownik-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href); }
function exportCsv() { const inventory = activeInventory(); if (!inventory) return; const esc = (v) => `"${String(v).replaceAll('"', '""')}"`; const rows = [["Sklep", storeName(activeStoreId)], ["Nazwa spisu", inventory.name], [], ["EAN / DAN", "Nazwa", "Kategoria", "Ilość", "Cena"], ...activeItems().map((x) => [x.ean, x.name, categoryName(x.category_id), x.quantity, x.price])]; const blob = new Blob([`\uFEFF${rows.map((r) => r.map(esc).join(";")).join("\r\n")}`], { type: "text/csv;charset=utf-8" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${inventory.name}.csv`; a.click(); URL.revokeObjectURL(a.href); }

async function startScanner() {
  if (!window.ZXingBrowser?.BrowserMultiFormatReader) return showToast("Skaner nie jest dostępny.");
  try { el.scannerDialog.showModal(); const reader = new ZXingBrowser.BrowserMultiFormatReader(); scannerControls = await reader.decodeFromVideoDevice(undefined, el.scannerVideo, (result) => { const value = result?.getText?.(); if (value) { el.ean.value = value; stopScanner(); resolveEan(); } }); } catch { stopScanner(); showToast("Nie udało się uruchomić aparatu."); }
}
function stopScanner() { scannerControls?.stop?.(); scannerControls = null; el.scannerVideo.srcObject?.getTracks().forEach((x) => x.stop()); el.scannerVideo.srcObject = null; if (el.scannerDialog.open) el.scannerDialog.close(); }

el.authForm.onsubmit = authSubmit;
el.authModeButton.onclick = () => { signupMode = !signupMode; el.displayNameField.classList.toggle("hidden", !signupMode); el.authTitle.textContent = signupMode ? "Załóż konto" : "Zaloguj się"; el.authSubmit.textContent = signupMode ? "Zarejestruj się" : "Zaloguj się"; el.authModeButton.textContent = signupMode ? "Masz konto? Zaloguj się" : "Nie masz konta? Zarejestruj się"; };
el.productForm.onsubmit = submitProduct; el.cancelEditButton.onclick = resetForm; el.undoLastItemButton.onclick = undoLastItem; el.storeSelect.onchange = () => { activeStoreId = el.storeSelect.value; activeInventoryId = null; resetTransactionForm(); chooseActive(); renderAll(); maybeShowDailyReminder(); };
el.storeSearch.oninput = renderStores; el.storeSettingsSearch.oninput = renderSettings; el.adminStoreSearch.oninput = renderAdmin;
el.sessionName.onchange = renameInventory; el.newSessionButton.onclick = newInventory; el.finishSessionButton.onclick = finishInventory; el.cancelSessionButton.onclick = cancelInventory; el.restoreArchiveButton.onclick = restoreArchivedInventory; el.deleteArchiveButton.onclick = deleteArchivedInventory; $("#lookupButton").onclick = resolveEan; el.ean.onchange = resolveEan;
el.searchInput.oninput = renderInventory; el.categoryFilter.onchange = renderInventory; el.sortSelect.onchange = renderInventory;
el.inventoryTabButton.onclick = () => { activeView = "inventories"; renderWorkspace(); };
el.sensitiveTabButton.onclick = () => { activeView = "sensitive"; renderWorkspace(); renderSensitiveProducts(); };
el.transactionsTabButton.onclick = () => { activeView = "transactions"; renderWorkspace(); renderTransactions(); };
el.sensitiveCheckForm.onsubmit = submitSensitiveCheck; el.sensitiveEan.onchange = resolveSensitiveEan;
el.transactionForm.onsubmit = submitSuspiciousTransaction;
el.transactionType.onchange = updateTransactionTypeFields;
el.transactionDate.onchange = updateTransactionTypeFields;
el.transactionCancelEdit.onclick = resetTransactionForm;
el.sensitiveAdminForm.onsubmit = saveSensitiveProduct;
el.sensitiveAdminCancel.onclick = resetSensitiveAdminForm;
$("#adminAddMembership").onclick = adminAddMembership;
$("#adminAddCategory").onclick = adminAddCategory;
$("#adminAddStore").onclick = async () => {
  if (!requireOnline()) return;
  const name = $("#adminStoreName").value.trim(), retention_days = Number($("#adminRetention").value);
  if (!name || !Number.isInteger(retention_days) || retention_days < 1 || retention_days > 365) return showToast("Podaj nazwę oraz od 1 do 365 dni.");
  if (state.stores.some((store) => store.name.toLocaleLowerCase("pl") === name.toLocaleLowerCase("pl"))) return showToast("Sklep o tej nazwie już istnieje.");
  const { error } = await db.from("stores").insert({ name, retention_days, created_by: user.id }); if (error) report(error); else { $("#adminStoreName").value = ""; await loadData(); }
};
el.settingsButton.onclick = () => { renderAll(); el.settingsDialog.showModal(); }; el.remindersButton.onclick = () => el.remindersDialog.showModal();
el.adminButton.onclick = () => { renderAll(); el.adminDialog.showModal(); };
el.syncButton.onclick = syncPending;
$("#logoutButton").onclick = async () => {
  const queued = await readQueue();
  if (queued.length && !confirm(`Masz ${queued.length} niewysłanych zmian. Odrzucić je i wylogować się?`)) return;
  const userId = user.id;
  await clearOfflineData(userId);
  await db.auth.signOut({ scope: "local" });
}; $("#migrateButton").onclick = migrateLegacy; $("#exportBackupButton").onclick = exportBackup; $("#exportCsvButton").onclick = exportCsv;
$("#scanButton").onclick = startScanner; $("#closeScannerButton").onclick = stopScanner; el.scannerDialog.addEventListener("close", stopScanner);
document.querySelectorAll("[data-close]").forEach((button) => button.onclick = () => document.getElementById(button.dataset.close).close());
$("#themeButton").onclick = () => { const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); };
window.addEventListener("online", syncPending); window.addEventListener("offline", renderAll);
document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
el.configWarning.classList.toggle("hidden", configured);
if (configured) {
  db.auth.onAuthStateChange((_event, session) => scheduleAuth(session));
  db.auth.getSession().then(({ data, error }) => {
    if (error) report(error, "Nie udało się odczytać sesji.");
    else scheduleAuth(data.session);
  });
}
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./service-worker.js");
