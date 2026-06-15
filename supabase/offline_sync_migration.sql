alter table public.inventory_items add column if not exists deleted_at timestamptz;

alter table public.inventory_items drop constraint if exists inventory_items_inventory_id_ean_key;
create unique index if not exists inventory_items_active_ean
  on public.inventory_items (inventory_id, ean) where deleted_at is null;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  if new.updated_at = old.updated_at then new.updated_at = now(); end if;
  return new;
end;
$$;

create or replace function public.sync_inventory(payload jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid := (payload->>'store_id')::uuid;
begin
  if not is_approved_member(target_store) then raise exception 'Brak uprawnień'; end if;
  insert into inventories (id, store_id, name, status, created_at, created_by, updated_at)
  values (
    (payload->>'id')::uuid, target_store, trim(payload->>'name'), 'active',
    (payload->>'created_at')::timestamptz, auth.uid(), (payload->>'updated_at')::timestamptz
  )
  on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
  where inventories.store_id = excluded.store_id and excluded.updated_at >= inventories.updated_at;
end;
$$;

create or replace function public.sync_inventory_item(payload jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_inventory uuid := (payload->>'inventory_id')::uuid;
  target_store uuid;
  changed_at timestamptz := (payload->>'updated_at')::timestamptz;
begin
  select store_id into target_store from inventories where id = target_inventory;
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnień'; end if;

  if payload->>'deleted_at' is not null then
    update inventory_items set deleted_at = (payload->>'deleted_at')::timestamptz, updated_at = changed_at
    where id = (payload->>'id')::uuid and inventory_id = target_inventory and changed_at >= updated_at;
    return;
  end if;

  insert into catalog_products (ean, name, category_id, updated_at, updated_by)
  values (payload->>'ean', trim(payload->>'name'), (payload->>'category_id')::uuid, changed_at, auth.uid())
  on conflict (ean) do update set name = excluded.name, category_id = excluded.category_id, updated_at = excluded.updated_at, updated_by = auth.uid()
  where excluded.updated_at >= catalog_products.updated_at;

  insert into store_prices (store_id, ean, price, updated_at, updated_by)
  values (target_store, payload->>'ean', (payload->>'price')::numeric, changed_at, auth.uid())
  on conflict (store_id, ean) do update set price = excluded.price, updated_at = excluded.updated_at, updated_by = auth.uid()
  where excluded.updated_at >= store_prices.updated_at;

  insert into inventory_items (id, inventory_id, ean, name, category_id, quantity, price, created_at, updated_at, deleted_at)
  values (
    (payload->>'id')::uuid, target_inventory, payload->>'ean', trim(payload->>'name'),
    (payload->>'category_id')::uuid, (payload->>'quantity')::integer, (payload->>'price')::numeric,
    (payload->>'created_at')::timestamptz, changed_at, null
  )
  on conflict (id) do update set
    ean = excluded.ean, name = excluded.name, category_id = excluded.category_id, quantity = excluded.quantity,
    price = excluded.price, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
  where excluded.updated_at >= inventory_items.updated_at;
end;
$$;

grant execute on function public.sync_inventory(jsonb) to authenticated;
grant execute on function public.sync_inventory_item(jsonb) to authenticated;
