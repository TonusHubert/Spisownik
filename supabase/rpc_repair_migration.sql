-- Idempotentna naprawa RPC spisow i zbiorczego dodawania podejrzanych
-- transakcji. Uruchom po r3_destructive_operations_migration.sql.

drop function if exists public.cancel_inventory(uuid);
drop function if exists public.delete_empty_active_inventory(uuid);
drop function if exists public.delete_archived_inventory(uuid);

create or replace function public.cancel_inventory(target_inventory uuid, target_reason text)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  return public.soft_delete_inventory(target_inventory, target_reason);
end;
$$;

create or replace function public.delete_archived_inventory(target_inventory uuid, target_reason text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  inventory_row public.inventories%rowtype;
  summary jsonb;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  if length(trim(coalesce(target_reason, ''))) not between 1 and 500 then
    raise exception 'Powod usuniecia jest wymagany';
  end if;
  select * into inventory_row
  from inventories
  where id = target_inventory and status = 'archived' and deleted_at is null
  for update;
  if not found then
    raise exception 'Nie znaleziono aktywnego archiwalnego spisu';
  end if;

  summary := public.preview_inventory_deletion(target_inventory);
  perform public.record_audit_event(
    'hard_delete', 'inventory', target_inventory, trim(target_reason),
    summary || jsonb_build_object('permanently_deleted', true)
  );
  perform set_config('app.allow_destructive_operation', 'true', true);
  perform set_config('app.allow_inventory_status', 'true', true);
  perform set_config('app.allow_inventory_flag', 'true', true);
  delete from inventories where id = target_inventory;
  return summary || jsonb_build_object('permanently_deleted', true);
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

revoke all on function public.cancel_inventory(uuid, text) from public, anon;
revoke all on function public.delete_archived_inventory(uuid, text) from public, anon;
revoke all on function public.add_suspicious_transactions(jsonb) from public, anon;
grant execute on function public.cancel_inventory(uuid, text) to authenticated;
grant execute on function public.delete_archived_inventory(uuid, text) to authenticated;
grant execute on function public.add_suspicious_transactions(jsonb) to authenticated;

notify pgrst, 'reload schema';
