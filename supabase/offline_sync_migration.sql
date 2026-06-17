alter table public.inventory_items add column if not exists deleted_at timestamptz;
alter table public.inventory_items add column if not exists flag_assigned boolean not null default false;
alter table public.inventories add column if not exists archived_at timestamptz;
alter type public.inventory_status add value if not exists 'archived';
commit;

alter table public.reminder_views drop constraint if exists reminder_views_pkey;
delete from public.reminder_views;
alter table public.reminder_views add column if not exists store_id uuid references public.stores(id) on delete cascade;
alter table public.reminder_views alter column store_id set not null;
alter table public.reminder_views add primary key (user_id, store_id, reminder_date);

update public.inventories set status = 'archived', archived_at = coalesce(archived_at, created_at)
where status::text = 'awaiting_flags';

alter table public.inventory_items drop constraint if exists inventory_items_inventory_id_ean_key;
create unique index if not exists inventory_items_active_ean
  on public.inventory_items (inventory_id, ean) where deleted_at is null;

create or replace function public.is_approved_member(target_store uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from store_memberships
  where store_id = target_store and user_id = auth.uid() and status = 'approved'
) or is_admin() $$;

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
  where inventories.store_id = excluded.store_id and inventories.status = 'active' and excluded.updated_at >= inventories.updated_at;
end;
$$;

create or replace function public.protect_inventory_status()
returns trigger language plpgsql as $$
begin
  if old.status = 'archived' and new is distinct from old
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Archiwalny spis jest tylko do odczytu';
  end if;
  if new.status <> old.status and auth.uid() is not null
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Status spisu moze zmienic tylko funkcja archiwizacji';
  end if;
  return new;
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
  select store_id into target_store from inventories where id = target_inventory and status = 'active';
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

create or replace function public.protect_inventory_status()
returns trigger language plpgsql as $$
begin
  if old.status = 'archived' and new is distinct from old then
    raise exception 'Archiwalny spis jest tylko do odczytu';
  end if;
  if new.status <> old.status and auth.uid() is not null
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Status spisu moze zmienic tylko funkcja archiwizacji';
  end if;
  return new;
end;
$$;

create or replace function public.protect_archived_inventory_item()
returns trigger language plpgsql as $$
declare target_inventory uuid;
begin
  target_inventory := case when tg_op = 'DELETE' then old.inventory_id else new.inventory_id end;
  if exists (select 1 from inventories where id = target_inventory and status = 'archived')
    and coalesce(current_setting('app.allow_inventory_flag', true), '') <> 'true' then
    raise exception 'Archiwalny spis jest tylko do odczytu';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists inventory_items_protect_archive on public.inventory_items;
create trigger inventory_items_protect_archive before insert or update or delete on public.inventory_items
for each row execute function public.protect_archived_inventory_item();

create or replace function public.archive_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select store_id into target_store from inventories where id = target_inventory and status = 'active';
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories set status = 'archived', archived_at = now(), updated_at = now() where id = target_inventory;
end;
$$;

create or replace function public.set_inventory_item_flag(target_item uuid, assigned boolean)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from inventory_items ii join inventories i on i.id = ii.inventory_id
    where ii.id = target_item and ii.deleted_at is null and i.status = 'archived' and is_approved_member(i.store_id)
  ) then raise exception 'Brak uprawnien lub spis nie jest w archiwum'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  update inventory_items set flag_assigned = assigned, updated_at = now() where id = target_item;
end;
$$;

create or replace function public.delete_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid; retention integer; archived timestamptz;
begin
  select i.store_id, s.retention_days, i.archived_at into target_store, retention, archived
  from inventories i join stores s on s.id = i.store_id
  where i.id = target_inventory and i.status = 'archived';
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  if archived + make_interval(days => retention) > now() then raise exception 'Okres archiwum jeszcze nie minal'; end if;
  if exists (select 1 from inventory_items where inventory_id = target_inventory and deleted_at is null and not flag_assigned)
    then raise exception 'Nie wszystkie flagi zostaly nadane'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  delete from inventories where id = target_inventory;
end;
$$;

create or replace function public.sync_inventory(payload jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_store uuid := (payload->>'store_id')::uuid;
  target_inventory uuid := (payload->>'id')::uuid;
  existing_status public.inventory_status;
begin
  if not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  select status into existing_status from inventories where id = target_inventory;
  if existing_status = 'archived' and not is_admin() then raise exception 'Archiwalny spis jest tylko do odczytu'; end if;
  if existing_status = 'archived' then perform set_config('app.allow_inventory_status', 'true', true); end if;

  insert into inventories (id, store_id, name, status, created_at, created_by, updated_at)
  values (
    target_inventory, target_store, trim(payload->>'name'), 'active',
    (payload->>'created_at')::timestamptz, auth.uid(), (payload->>'updated_at')::timestamptz
  )
  on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
  where inventories.store_id = excluded.store_id
    and (inventories.status = 'active' or (inventories.status = 'archived' and is_admin()))
    and excluded.updated_at >= inventories.updated_at;
end;
$$;

create or replace function public.sync_inventory_item(payload jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_inventory uuid := (payload->>'inventory_id')::uuid;
  target_store uuid;
  target_status public.inventory_status;
  changed_at timestamptz := (payload->>'updated_at')::timestamptz;
begin
  select store_id, status into target_store, target_status from inventories where id = target_inventory;
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  if target_status = 'archived' and not is_admin() then raise exception 'Archiwalny spis jest tylko do odczytu'; end if;
  if target_status = 'archived' then perform set_config('app.allow_inventory_flag', 'true', true); end if;

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

create or replace function public.restore_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select store_id into target_store from inventories where id = target_inventory and status = 'archived';
  if target_store is null or not is_admin() then raise exception 'Brak uprawnien'; end if;
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories set status = 'active', archived_at = null, updated_at = now() where id = target_inventory;
end;
$$;

create or replace function public.protect_inventory_status()
returns trigger language plpgsql as $$
begin
  if old.status = 'archived' and new is distinct from old
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Archiwalny spis jest tylko do odczytu';
  end if;
  if new.status <> old.status and auth.uid() is not null
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Status spisu moze zmienic tylko funkcja archiwizacji';
  end if;
  return new;
end;
$$;

create or replace function public.cancel_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select store_id into target_store from inventories where id = target_inventory and status = 'active';
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  delete from inventories where id = target_inventory;
end;
$$;

create or replace function public.delete_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid; retention integer; archived timestamptz;
begin
  select i.store_id, s.retention_days, i.archived_at into target_store, retention, archived
  from inventories i join stores s on s.id = i.store_id
  where i.id = target_inventory and i.status = 'archived';
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  if not is_admin() and archived + make_interval(days => retention) > now() then raise exception 'Okres archiwum jeszcze nie minal'; end if;
  if not is_admin() and exists (select 1 from inventory_items where inventory_id = target_inventory and deleted_at is null and not flag_assigned)
    then raise exception 'Nie wszystkie flagi zostaly nadane'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  delete from inventories where id = target_inventory;
end;
$$;

grant execute on function public.archive_inventory(uuid) to authenticated;
grant execute on function public.restore_archived_inventory(uuid) to authenticated;
grant execute on function public.cancel_inventory(uuid) to authenticated;
grant execute on function public.set_inventory_item_flag(uuid, boolean) to authenticated;
grant execute on function public.delete_archived_inventory(uuid) to authenticated;

create or replace function public.mark_expired_inventories()
returns integer language sql security definer set search_path = public
as $$ select 0 $$;

create or replace function public.review_category_request(target_request uuid, approve boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare req category_requests%rowtype; fallback_id uuid;
begin
  if not is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into req from category_requests where id = target_request and status = 'pending' for update;
  if req.id is null then raise exception 'Nie znaleziono zgloszenia'; end if;
  if approve then
    if req.request_type = 'create' then
      insert into categories(name) values (trim(req.proposed_name));
    elsif req.request_type = 'rename' then
      update categories set name = trim(req.proposed_name) where id = req.category_id and not is_fallback;
    else
      select id into fallback_id from categories where is_fallback;
      if exists(select 1 from categories where id = req.category_id and is_fallback) then raise exception 'Nie mozna usunac kategorii Inne'; end if;
      update catalog_products set category_id = fallback_id where category_id = req.category_id;
      perform set_config('app.allow_inventory_flag', 'true', true);
      update inventory_items set category_id = fallback_id where category_id = req.category_id;
      delete from categories where id = req.category_id;
    end if;
  end if;
  update category_requests set status = case when approve then 'approved' else 'rejected' end,
    reviewed_at = now(), reviewed_by = auth.uid() where id = target_request;
end;
$$;
