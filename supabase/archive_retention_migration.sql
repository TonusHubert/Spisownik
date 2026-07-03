-- Przechowywanie archiwum niezaleznie od flag/weryfikacji: spis zostaje w archiwum do
-- konca okresu ustawionego przez admina (retention_days) + 14 dni zapasu, po czym jest
-- automatycznie usuwany. Nadanie flag ani zaznaczenie weryfikacji NIE usuwa juz spisu.

create or replace function public.delete_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid; retention integer; archived timestamptz;
begin
  select i.store_id, s.retention_days, i.archived_at into target_store, retention, archived
  from inventories i join stores s on s.id = i.store_id
  where i.id = target_inventory and i.status = 'archived';
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  if not is_admin() and archived + make_interval(days => retention + 14) > now() then raise exception 'Okres archiwum jeszcze nie minal'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  delete from inventories where id = target_inventory;
end;
$$;

-- Automatyczne porzadkowanie: usuwa wszystkie archiwalne spisy po okresie archiwum sklepu + 14 dni.
create or replace function public.purge_expired_inventories()
returns integer language plpgsql security definer set search_path = public
as $$
declare removed integer;
begin
  perform set_config('app.allow_inventory_flag', 'true', true);
  with expired as (
    delete from inventories i
    using stores s
    where s.id = i.store_id and i.status = 'archived'
      and i.archived_at + make_interval(days => s.retention_days + 14) <= now()
    returning i.id
  )
  select count(*) into removed from expired;
  return removed;
end;
$$;

revoke all on function public.purge_expired_inventories() from public, anon;
grant execute on function public.purge_expired_inventories() to authenticated;

-- Opcjonalnie: pelna automatyzacja po stronie serwera (czyszczenie nawet gdy nikt nie otworzy aplikacji).
-- Wymaga rozszerzenia pg_cron (Supabase: Database > Extensions > wlacz "pg_cron"), potem odkomentuj:
--   create extension if not exists pg_cron;
--   select cron.schedule('purge-expired-inventories', '0 3 * * *', $$select public.purge_expired_inventories();$$);
