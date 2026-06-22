# Spisownik

Mobilna PWA do współdzielonych spisów produktów. Dane, konta i uprawnienia są obsługiwane przez Supabase.

## Funkcje

- logowanie e-mailem i hasłem z rolami administratora oraz pracownika,
- przypisywanie zarejestrowanych pracowników do sklepów przez administratora,
- wspólne spisy, globalny katalog produktów i ceny osobne dla sklepów,
- bezpośrednie tworzenie, edycja i usuwanie kategorii przez administratora,
- ręczne kończenie spisów, archiwum oraz oznaczanie flag przy każdej pozycji,
- niezależne oznaczanie archiwalnych pozycji jako zweryfikowane,
- codzienna kontrola globalnej listy produktów wrażliwych z limitem 2 sztuk na półce, zdjęciami i kodami kreskowymi gotowymi do skanowania,
- codzienne przypomnienie wewnątrz aplikacji,
- sklepowa lista numerów paragonów i aplikacji do sprawdzania podejrzanych transakcji,
- lokalny cache danych do odczytu bez internetu,
- jednorazowy import danych z wersji lokalnej oraz eksport JSON i CSV.

## Konfiguracja Supabase

1. Utwórz projekt w Supabase.
2. Otwórz **SQL Editor** i wykonaj cały plik `supabase/schema.sql`.

Jeśli aktualizujesz istniejącą instalację, wykonaj zamiast tego plik `supabase/offline_sync_migration.sql`.

Po aktualizacji istniejącej instalacji wykonaj również plik `supabase/suspicious_transactions_migration.sql`, aby dodać listę podejrzanych transakcji i jej przypomnienia.

Migracja tworzy również publiczny bucket `sensitive-product-images`, dodaje zdjęcia produktów wrażliwych oraz włącza bezpośrednie zarządzanie kategoriami i przypisaniami przez administratora.

Przy usunięciu kategorii wszystkie przypisane do niej produkty są automatycznie przenoszone do chronionej kategorii `Inne`.

Migracja udostępnia administratorowi funkcję do bezpiecznego usunięcia wyłącznie pustego aktywnego spisu po UUID:

```sql
select public.delete_empty_active_inventory('UUID-SPISU');
```

Funkcja odrzuci operację, jeśli wskazany spis nie jest aktywny, nie jest pusty albo wykonujący nie jest administratorem. Nie należy usuwać spisów według nazwy ani daty.
3. Załóż pierwsze konto w aplikacji, a następnie nadaj mu rolę administratora:

```sql
update public.profiles set role = 'admin' where email = 'twoj-email@example.com';
```

4. Skopiuj Project URL i publiczny klucz `anon` do `config.js`:

```js
window.SPISOWNIK_CONFIG = {
  supabaseUrl: "https://PROJECT.supabase.co",
  supabaseAnonKey: "PUBLIC_ANON_KEY",
};
```

Klucz `anon` jest przeznaczony do użycia w przeglądarce. Bezpieczeństwo danych zapewniają polityki RLS z migracji SQL. Nigdy nie umieszczaj w aplikacji klucza `service_role`.

## Uruchomienie lokalne

```powershell
node server.js
```

Następnie otwórz `http://localhost:8000`.

## Wdrożenie

Workflow `.github/workflows/pages.yml` publikuje aplikację na GitHub Pages. Plik `config.js` musi zawierać konfigurację projektu Supabase używanego przez wdrożenie.
