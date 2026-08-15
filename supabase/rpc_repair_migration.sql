-- Naprawa funkcji RPC wymaganych przez archiwum spisow i zbiorcze dodawanie
-- podejrzanych transakcji. Uruchom po suspicious_transactions_migration.sql.

create or replace function public.cancel_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select store_id into target_store
  from inventories
  where id = target_inventory and status = 'active';
  if target_store is null or not is_approved_member(target_store) then
    raise exception 'Brak uprawnien';
  end if;
  delete from inventories where id = target_inventory;
end;
$$;

create or replace function public.delete_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid; retention integer; archived timestamptz;
begin
  select i.store_id, s.retention_days, i.archived_at
  into target_store, retention, archived
  from inventories i
  join stores s on s.id = i.store_id
  where i.id = target_inventory and i.status = 'archived';
  if target_store is null or not is_approved_member(target_store) then
    raise exception 'Brak uprawnien';
  end if;
  if not is_admin() and archived + make_interval(days => retention + 14) > now() then
    raise exception 'Okres archiwum jeszcze nie minal';
  end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  delete from inventories where id = target_inventory;
end;
$$;

create or replace function public.add_suspicious_transactions(target_entries jsonb)
returns uuid[] language plpgsql security definer set search_path = public
as $$
declare
  item jsonb;
  inserted_ids uuid[] := '{}';
  inserted_id uuid;
begin
  if jsonb_typeof(target_entries) <> 'array'
    or jsonb_array_length(target_entries) not between 1 and 100 then
    raise exception 'Podaj od 1 do 100 transakcji';
  end if;
  for item in select value from jsonb_array_elements(target_entries)
  loop
    inserted_id := add_suspicious_transaction(
      (item->>'store_id')::uuid,
      (item->>'entry_type')::public.suspicious_transaction_type,
      item->>'reference_number',
      nullif(item->>'receipt_date', '')::date,
      item->>'note'
    );
    inserted_ids := array_append(inserted_ids, inserted_id);
  end loop;
  return inserted_ids;
end;
$$;

revoke all on function public.cancel_inventory(uuid) from public, anon;
revoke all on function public.delete_archived_inventory(uuid) from public, anon;
revoke all on function public.add_suspicious_transactions(jsonb) from public, anon;
grant execute on function public.cancel_inventory(uuid) to authenticated;
grant execute on function public.delete_archived_inventory(uuid) to authenticated;
grant execute on function public.add_suspicious_transactions(jsonb) to authenticated;

notify pgrst, 'reload schema';
