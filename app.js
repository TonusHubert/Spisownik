const LEGACY_KEY = "spisownik-state-v2";
const CACHE_KEY = "spisownik-cloud-cache-v1";
const MIGRATION_KEY = "spisownik-migrated-v1";
const THEME_KEY = "spisownik-theme";
const $ = (selector) => document.querySelector(selector);
const config = window.SPISOWNIK_CONFIG || {};
const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
const db = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const el = {
  authView: $("#authView"), appView: $("#appView"), authForm: $("#authForm"), authTitle: $("#authTitle"), authSubmit: $("#authSubmit"),
  authModeButton: $("#authModeButton"), authError: $("#authError"), displayNameField: $("#displayNameField"), displayName: $("#displayName"),
  email: $("#email"), password: $("#password"), configWarning: $("#configWarning"), settingsButton: $("#settingsButton"),
  adminButton: $("#adminButton"), remindersButton: $("#remindersButton"), reminderBadge: $("#reminderBadge"), settingsDialog: $("#settingsDialog"),
  adminDialog: $("#adminDialog"), remindersDialog: $("#remindersDialog"), storeSelect: $("#storeSelect"), sessionName: $("#sessionName"),
  savedStatus: $("#savedStatus"), offlineBanner: $("#offlineBanner"), noStoresState: $("#noStoresState"), inventoryView: $("#inventoryView"),
  itemsStat: $("#itemsStat"), quantityStat: $("#quantityStat"), valueStat: $("#valueStat"), productForm: $("#productForm"),
  editingId: $("#editingId"), ean: $("#ean"), name: $("#name"), category: $("#category"), quantity: $("#quantity"), price: $("#price"),
  formError: $("#formError"), submitButton: $("#submitButton"), cancelEditButton: $("#cancelEditButton"), formTitle: $("#formTitle"),
  lookupStatus: $("#lookupStatus"), searchInput: $("#searchInput"), categoryFilter: $("#categoryFilter"), sortSelect: $("#sortSelect"),
  productList: $("#productList"), productTemplate: $("#productTemplate"), emptyState: $("#emptyState"), storeSettings: $("#storeSettings"),
  categorySettings: $("#categorySettings"), sessionSettings: $("#sessionSettings"), profileSummary: $("#profileSummary"),
  membershipRequests: $("#membershipRequests"), categoryRequests: $("#categoryRequests"), reminderList: $("#reminderList"),
  toast: $("#toast"), scannerDialog: $("#scannerDialog"), scannerVideo: $("#scannerVideo"), scannerMessage: $("#scannerMessage"),
};

let signupMode = false;
let user = null;
let profile = null;
let state = emptyState();
let activeStoreId = null;
let activeInventoryId = null;
let toastTimer = null;
let scannerControls = null;

function emptyState() {
  return { stores: [], memberships: [], categories: [], inventories: [], items: [], catalog: [], prices: [], membershipRequests: [], categoryRequests: [] };
}
function isAdmin() { return profile?.role === "admin"; }
function online() { return navigator.onLine && configured; }
function approvedStoreIds() { return new Set(state.memberships.filter((m) => m.status === "approved").map((m) => m.store_id)); }
function activeInventory() { return state.inventories.find((x) => x.id === activeInventoryId); }
function activeItems() { return state.items.filter((x) => x.inventory_id === activeInventoryId); }
function categoryName(id) { return state.categories.find((x) => x.id === id)?.name || "Inne"; }
function storeName(id) { return state.stores.find((x) => x.id === id)?.name || "Nieznany sklep"; }
function money(value) { return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" }).format(Number(value) || 0); }
function date(value) { return new Intl.DateTimeFormat("pl-PL", { dateStyle: "short" }).format(new Date(value)); }
function defaultInventoryName() { return `Spis ${new Intl.DateTimeFormat("pl-PL", { dateStyle: "short" }).format(new Date())}`; }
function showToast(message) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.classList.add("visible"); toastTimer = setTimeout(() => el.toast.classList.remove("visible"), 3000); }
function report(error, fallback = "Nie udało się wykonać operacji.") { console.error(error); showToast(error?.message || fallback); }
function requireOnline() { if (online()) return true; showToast("Ta operacja wymaga połączenia z internetem."); return false; }

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
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached?.userId === user.id) { state = cached.state; profile = cached.profile; }
    renderAll();
    return;
  }
  try {
    const [profiles, stores, memberships, categories, inventories, catalog] = await Promise.all([
      query("profiles", "*", [["eq", "id", user.id]]), query("stores"), query("store_memberships"),
      query("categories", "*"), query("inventories", "*"), query("catalog_products", "*"),
    ]);
    profile = profiles[0];
    if (!profile) throw new Error("Nie znaleziono profilu użytkownika. Sprawdź migrację Supabase.");
    state = { ...emptyState(), stores, memberships: memberships.filter((m) => m.user_id === user.id), categories, inventories, catalog };
    const inventoryIds = inventories.map((x) => x.id);
    const storeIds = [...approvedStoreIds()];
    const extra = await Promise.all([
      inventoryIds.length ? query("inventory_items", "*", [["in", "inventory_id", inventoryIds]]) : [],
      storeIds.length ? query("store_prices", "*", [["in", "store_id", storeIds]]) : [],
      isAdmin() ? query("store_memberships", "*, stores(name), profiles!store_memberships_user_id_fkey(email,display_name)", [["eq", "status", "pending"]]) : [],
      query("category_requests", "*, categories(name)", isAdmin() ? [["eq", "status", "pending"]] : [["eq", "requested_by", user.id]]),
    ]);
    state.items = extra[0]; state.prices = extra[1]; state.membershipRequests = extra[2]; state.categoryRequests = extra[3];
    chooseActive();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: user.id, profile, state }));
    el.savedStatus.textContent = `Zsynchronizowano: ${new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    renderAll();
    maybeShowDailyReminder();
  } catch (error) { report(error, "Nie udało się pobrać danych."); }
}

function chooseActive() {
  const allowed = approvedStoreIds();
  if (!allowed.has(activeStoreId)) activeStoreId = [...allowed][0] || null;
  const storeInventories = state.inventories.filter((x) => x.store_id === activeStoreId && x.status === "active");
  if (!storeInventories.some((x) => x.id === activeInventoryId)) activeInventoryId = storeInventories.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0]?.id || null;
}

function renderAll() {
  const isOffline = !online();
  el.offlineBanner.classList.toggle("hidden", !isOffline);
  el.profileSummary.textContent = profile ? `${profile.display_name || profile.email} · ${isAdmin() ? "administrator" : "pracownik"}` : "";
  el.adminButton.classList.toggle("hidden", !isAdmin());
  renderStores(); renderCategories(); renderInventory(); renderSettings(); renderReminders(); renderAdmin();
  document.querySelectorAll("[data-offline-disabled]").forEach((node) => { node.disabled = false; delete node.dataset.offlineDisabled; });
  document.querySelectorAll("button, input, select").forEach((node) => {
    if (node.closest("#authView") || node.id === "themeButton" || node.dataset.close) return;
    if (isOffline && !["settingsButton", "remindersButton"].includes(node.id)) { node.disabled = true; node.dataset.offlineDisabled = "true"; }
  });
}

function renderStores() {
  const approved = state.stores.filter((s) => approvedStoreIds().has(s.id));
  el.storeSelect.replaceChildren(...approved.map((s) => new Option(s.name, s.id)));
  el.storeSelect.value = activeStoreId || "";
  el.noStoresState.classList.toggle("hidden", approved.length > 0);
  el.inventoryView.classList.toggle("hidden", approved.length === 0);
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
  el.sessionName.value = inventory?.name || "";
  el.sessionName.disabled = !inventory;
  const queryText = el.searchInput.value.trim().toLocaleLowerCase("pl");
  let products = activeItems().filter((x) => `${x.name} ${x.ean}`.toLocaleLowerCase("pl").includes(queryText))
    .filter((x) => !el.categoryFilter.value || x.category_id === el.categoryFilter.value);
  products.sort(el.sortSelect.value === "name-asc" ? (a, b) => a.name.localeCompare(b.name, "pl") : el.sortSelect.value === "total-desc" ? (a, b) => b.quantity * b.price - a.quantity * a.price : (a, b) => new Date(b.created_at) - new Date(a.created_at));
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
    const button = document.createElement("button"); button.className = danger ? "danger-button compact" : "ghost-button compact"; button.textContent = label; button.onclick = handler; buttons.append(button);
  }
  wrapper.append(text, buttons); return wrapper;
}

function renderSettings() {
  el.storeSettings.replaceChildren();
  for (const store of state.stores) {
    const membership = state.memberships.find((m) => m.store_id === store.id);
    const status = membership?.status;
    const actions = [];
    if (!status || status === "rejected") actions.push(["Poproś o dostęp", () => requestMembership(store.id)]);
    if (status === "approved") actions.push(["Opuść", () => leaveStore(store.id), true]);
    if (isAdmin()) actions.push(["Edytuj", () => adminEditStore(store)], ["Usuń", () => adminDeleteStore(store), true]);
    el.storeSettings.append(row(store.name, status === "approved" ? `Dostęp aktywny · archiwum ${store.retention_days} dni` : status === "pending" ? "Oczekuje na zatwierdzenie" : status === "rejected" ? "Prośba odrzucona" : "Brak dostępu", actions));
  }
  el.categorySettings.replaceChildren();
  for (const category of state.categories) {
    const actions = category.is_fallback ? [] : [["Zmień", () => requestCategory("rename", category)], ["Usuń", () => requestCategory("delete", category), true]];
    el.categorySettings.append(row(category.name, category.is_fallback ? "Kategoria chroniona" : "Kategoria globalna", actions));
  }
  el.sessionSettings.replaceChildren();
  for (const inventory of state.inventories.filter((x) => x.store_id === activeStoreId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
    el.sessionSettings.append(row(inventory.name, `${date(inventory.created_at)} · ${inventory.status === "awaiting_flags" ? "oczekuje na flagi" : "aktywny"}`, inventory.status === "active" ? [["Otwórz", () => { activeInventoryId = inventory.id; renderAll(); el.settingsDialog.close(); }]] : []));
  }
}

function renderReminders() {
  const awaiting = state.inventories.filter((x) => x.status === "awaiting_flags");
  el.reminderBadge.textContent = awaiting.length;
  el.remindersButton.classList.toggle("has-badge", awaiting.length > 0);
  el.reminderList.replaceChildren(...awaiting.map((x) => row(x.name, `${storeName(x.store_id)} · utworzono ${date(x.created_at)}`, [["Flagi zostały nadane", () => confirmFlags(x.id)]])));
}

function renderAdmin() {
  el.membershipRequests.replaceChildren(...state.membershipRequests.map((m) => row(m.profiles?.display_name || m.profiles?.email || m.user_id, m.stores?.name || storeName(m.store_id), [["Zatwierdź", () => reviewMembership(m, "approved")], ["Odrzuć", () => reviewMembership(m, "rejected"), true]])));
  el.categoryRequests.replaceChildren(...state.categoryRequests.filter((r) => r.status === "pending").map((r) => row(`${r.request_type === "create" ? "Dodaj" : r.request_type === "rename" ? "Zmień" : "Usuń"}: ${r.proposed_name || r.categories?.name}`, "Oczekuje na decyzję", [["Zatwierdź", () => reviewCategory(r.id, true)], ["Odrzuć", () => reviewCategory(r.id, false), true]])));
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
  if (user) await loadData(); else { profile = null; state = emptyState(); }
}

async function requestMembership(storeId) { if (!requireOnline()) return; const { error } = await db.rpc("request_store_membership", { target_store: storeId }); if (error) return report(error); showToast("Prośba została wysłana."); await loadData(); }
async function leaveStore(storeId) { if (!requireOnline() || !confirm("Opuścić ten sklep?")) return; const { error } = await db.rpc("leave_store", { target_store: storeId }); if (error) return report(error); await loadData(); }
async function reviewMembership(membership, decision) { const { error } = await db.rpc("review_membership", { target_store: membership.store_id, target_user: membership.user_id, decision }); if (error) return report(error); await loadData(); }

async function requestCategory(type, category = null) {
  if (!requireOnline()) return;
  let proposedName = null;
  if (type !== "delete") { proposedName = prompt(type === "create" ? "Nazwa nowej kategorii:" : "Nowa nazwa kategorii:", category?.name || "")?.trim(); if (!proposedName) return; }
  const { data, error } = await db.from("category_requests").insert({ request_type: type, category_id: category?.id || null, proposed_name: proposedName, requested_by: user.id }).select().single();
  if (error) return report(error);
  if (isAdmin()) { const result = await db.rpc("review_category_request", { target_request: data.id, approve: true }); if (result.error) return report(result.error); showToast("Kategoria została zmieniona."); }
  else showToast("Zmiana czeka na zatwierdzenie administratora.");
  await loadData();
}
async function reviewCategory(id, approve) { const { error } = await db.rpc("review_category_request", { target_request: id, approve }); if (error) return report(error); await loadData(); }

async function adminEditStore(store) {
  const name = prompt("Nazwa sklepu:", store.name)?.trim(); if (!name) return;
  const retention = Number(prompt("Liczba dni archiwum:", store.retention_days)); if (!Number.isInteger(retention) || retention < 1 || retention > 365) return showToast("Podaj od 1 do 365 dni.");
  const { error } = await db.from("stores").update({ name, retention_days: retention }).eq("id", store.id); if (error) return report(error); await loadData();
}
async function adminDeleteStore(store) { if (!confirm(`Trwale usunąć sklep „${store.name}” i wszystkie jego dane?`)) return; const { error } = await db.from("stores").delete().eq("id", store.id); if (error) return report(error); await loadData(); }

async function newInventory() {
  if (!requireOnline() || !activeStoreId) return;
  const { data, error } = await db.from("inventories").insert({ store_id: activeStoreId, name: defaultInventoryName(), created_by: user.id }).select().single();
  if (error) return report(error); activeInventoryId = data.id; await loadData();
}
async function renameInventory() { const inventory = activeInventory(); if (!inventory || !requireOnline()) return; const name = el.sessionName.value.trim() || defaultInventoryName(); const { error } = await db.from("inventories").update({ name }).eq("id", inventory.id); if (error) return report(error); await loadData(); }

function resetForm() { el.productForm.reset(); el.quantity.value = 1; el.editingId.value = ""; el.formTitle.textContent = "Dodaj produkt"; el.submitButton.textContent = "Dodaj do spisu"; el.cancelEditButton.classList.add("hidden"); el.formError.textContent = ""; renderCategories(); }
function editProduct(product) { el.editingId.value = product.id; el.ean.value = product.ean; el.name.value = product.name; el.category.value = product.category_id; el.quantity.value = product.quantity; el.price.value = String(product.price).replace(".", ","); el.formTitle.textContent = "Edytuj produkt"; el.submitButton.textContent = "Zapisz zmiany"; el.cancelEditButton.classList.remove("hidden"); }
async function deleteProduct(product) { if (!requireOnline() || !confirm(`Usunąć „${product.name}” ze spisu?`)) return; const { error } = await db.from("inventory_items").delete().eq("id", product.id); if (error) return report(error); await loadData(); }

async function submitProduct(event) {
  event.preventDefault(); if (!requireOnline() || !activeInventoryId) return;
  const quantity = Number(el.quantity.value), price = Number(el.price.value.replace(",", "."));
  const product = { ean: el.ean.value.trim(), name: el.name.value.trim(), category_id: el.category.value, quantity, price };
  if (!product.ean || !product.name || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(price) || price < 0) return el.formError.textContent = "Uzupełnij poprawnie wszystkie pola.";
  const catalogResult = await db.from("catalog_products").upsert({ ean: product.ean, name: product.name, category_id: product.category_id, updated_by: user.id });
  if (catalogResult.error) return report(catalogResult.error);
  const priceResult = await db.from("store_prices").upsert({ store_id: activeStoreId, ean: product.ean, price, updated_by: user.id });
  if (priceResult.error) return report(priceResult.error);
  const editingId = el.editingId.value;
  const result = editingId ? await db.from("inventory_items").update(product).eq("id", editingId) : await db.from("inventory_items").insert({ ...product, inventory_id: activeInventoryId });
  if (result.error) return report(result.error); resetForm(); await loadData();
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

async function confirmFlags(id) { if (!requireOnline() || !confirm("Czy flagi na produkty zostały nadane? Potwierdzenie trwale usunie spis.")) return; const { error } = await db.rpc("confirm_inventory_flags", { target_inventory: id }); if (error) return report(error); showToast("Potwierdzono flagi i usunięto spis."); await loadData(); }
async function maybeShowDailyReminder() {
  if (!online() || !state.inventories.some((x) => x.status === "awaiting_flags")) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db.from("reminder_views").select("reminder_date").eq("user_id", user.id).eq("reminder_date", today);
  if (error || data.length) return;
  const saved = await db.from("reminder_views").insert({ user_id: user.id, reminder_date: today });
  if (!saved.error && !el.remindersDialog.open) el.remindersDialog.showModal();
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
el.productForm.onsubmit = submitProduct; el.cancelEditButton.onclick = resetForm; el.storeSelect.onchange = () => { activeStoreId = el.storeSelect.value; activeInventoryId = null; chooseActive(); renderAll(); };
el.sessionName.onchange = renameInventory; $("#newSessionButton").onclick = newInventory; $("#lookupButton").onclick = resolveEan; el.ean.onchange = resolveEan;
el.searchInput.oninput = renderInventory; el.categoryFilter.onchange = renderInventory; el.sortSelect.onchange = renderInventory;
$("#requestCategoryButton").onclick = async () => { const value = $("#newCategoryName").value.trim(); if (!value) return; $("#newCategoryName").value = ""; const { data, error } = await db.from("category_requests").insert({ request_type: "create", proposed_name: value, requested_by: user.id }).select().single(); if (error) return report(error); if (isAdmin()) { const result = await db.rpc("review_category_request", { target_request: data.id, approve: true }); if (result.error) return report(result.error); } else showToast("Zmiana czeka na zatwierdzenie."); await loadData(); };
$("#adminAddStore").onclick = async () => { const name = $("#adminStoreName").value.trim(), retention_days = Number($("#adminRetention").value); if (!name) return; const { error } = await db.from("stores").insert({ name, retention_days, created_by: user.id }); if (error) report(error); else { $("#adminStoreName").value = ""; await loadData(); } };
el.settingsButton.onclick = () => { renderAll(); el.settingsDialog.showModal(); }; el.remindersButton.onclick = () => el.remindersDialog.showModal();
el.adminButton.onclick = () => { renderAll(); el.adminDialog.showModal(); };
$("#logoutButton").onclick = () => db.auth.signOut(); $("#migrateButton").onclick = migrateLegacy; $("#exportBackupButton").onclick = exportBackup; $("#exportCsvButton").onclick = exportCsv;
$("#scanButton").onclick = startScanner; $("#closeScannerButton").onclick = stopScanner; el.scannerDialog.addEventListener("close", stopScanner);
document.querySelectorAll("[data-close]").forEach((button) => button.onclick = () => document.getElementById(button.dataset.close).close());
$("#themeButton").onclick = () => { const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = theme; localStorage.setItem(THEME_KEY, theme); };
window.addEventListener("online", loadData); window.addEventListener("offline", renderAll);
document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
el.configWarning.classList.toggle("hidden", configured);
if (configured) { db.auth.onAuthStateChange((_event, session) => onAuth(session)); db.auth.getSession().then(({ data }) => onAuth(data.session)); }
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./service-worker.js");
