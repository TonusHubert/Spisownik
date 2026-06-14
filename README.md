# Spisownik

Mobilna PWA do współdzielonych spisów produktów. Dane, konta i uprawnienia są obsługiwane przez Supabase.

## Funkcje

- logowanie e-mailem i hasłem z rolami administratora oraz pracownika,
- publiczna lista sklepów i prośby pracowników o przypisanie,
- akceptowanie członkostw przez administratora,
- wspólne spisy, globalny katalog produktów i ceny osobne dla sklepów,
- propozycje zmian kategorii zatwierdzane przez administratora,
- okres archiwum ustawiany dla sklepu i usuwanie spisu po potwierdzeniu flag,
- codzienne przypomnienie wewnątrz aplikacji,
- lokalny cache danych do odczytu bez internetu,
- jednorazowy import danych z wersji lokalnej oraz eksport JSON i CSV.

## Konfiguracja Supabase

1. Utwórz projekt w Supabase.
2. Otwórz **SQL Editor** i wykonaj cały plik `supabase/schema.sql`.
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

5. Włącz rozszerzenie `pg_cron` w Supabase i zaplanuj codzienne oznaczanie przeterminowanych spisów:

```sql
select cron.schedule(
  'mark-expired-inventories',
  '5 0 * * *',
  'select public.mark_expired_inventories()'
);
```

## Uruchomienie lokalne

```powershell
node server.js
```

Następnie otwórz `http://localhost:8000`.

## Wdrożenie

Workflow `.github/workflows/pages.yml` publikuje aplikację na GitHub Pages. Plik `config.js` musi zawierać konfigurację projektu Supabase używanego przez wdrożenie.
