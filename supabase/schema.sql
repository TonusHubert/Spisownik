create extension if not exists pgcrypto;

create type public.app_role as enum ('admin', 'worker');
create type public.membership_status as enum ('pending', 'approved', 'rejected');
create type public.category_request_type as enum ('create', 'rename', 'delete');
create type public.request_status as enum ('pending', 'approved', 'rejected');
create type public.inventory_status as enum ('active', 'archived');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role public.app_role not null default 'worker',
  created_at timestamptz not null default now()
);

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 80),
  retention_days integer not null default 14 check (retention_days between 1 and 365),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create table public.store_memberships (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status public.membership_status not null default 'pending',
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  primary key (store_id, user_id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 80),
  is_fallback boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index one_fallback_category on public.categories (is_fallback) where is_fallback;

create table public.category_requests (
  id uuid primary key default gen_random_uuid(),
  request_type public.category_request_type not null,
  category_id uuid references public.categories(id) on delete cascade,
  proposed_name text,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  status public.request_status not null default 'pending',
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (
    (request_type = 'create' and category_id is null and proposed_name is not null) or
    (request_type = 'rename' and category_id is not null and proposed_name is not null) or
    (request_type = 'delete' and category_id is not null)
  )
);

create table public.catalog_products (
  ean text primary key,
  name text not null,
  category_id uuid not null references public.categories(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

create table public.store_prices (
  store_id uuid not null references public.stores(id) on delete cascade,
  ean text not null references public.catalog_products(ean) on delete cascade,
  price numeric(12,2) not null check (price >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),
  primary key (store_id, ean)
);

create table public.inventories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  status public.inventory_status not null default 'active',
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references public.inventories(id) on delete cascade,
  ean text not null,
  name text not null,
  category_id uuid not null references public.categories(id),
  quantity integer not null check (quantity > 0),
  price numeric(12,2) not null check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  flag_assigned boolean not null default false
);

create unique index inventory_items_active_ean on public.inventory_items (inventory_id, ean) where deleted_at is null;

create table public.reminder_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  reminder_date date not null default current_date,
  primary key (user_id, store_id, reminder_date)
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;

create or replace function public.is_approved_member(target_store uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from store_memberships
  where store_id = target_store and user_id = auth.uid() and status = 'approved'
) or is_admin() $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'display_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.approve_store_creator()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.created_by is not null then
    insert into store_memberships (store_id, user_id, status, reviewed_at, reviewed_by)
    values (new.id, new.created_by, 'approved', now(), new.created_by);
  end if;
  return new;
end;
$$;

create trigger on_store_created after insert on public.stores
for each row execute function public.approve_store_creator();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  if new.updated_at = old.updated_at then new.updated_at = now(); end if;
  return new;
end;
$$;

create trigger inventories_updated before update on public.inventories
for each row execute function public.set_updated_at();
create trigger inventory_items_updated before update on public.inventory_items
for each row execute function public.set_updated_at();
create trigger catalog_products_updated before update on public.catalog_products
for each row execute function public.set_updated_at();

create or replace function public.protect_fallback_category()
returns trigger language plpgsql as $$
begin
  if old.is_fallback then
    raise exception 'Nie można zmienić ani usunąć kategorii Inne';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger categories_protect_fallback before update or delete on public.categories
for each row execute function public.protect_fallback_category();

create or replace function public.protect_inventory_status()
returns trigger language plpgsql as $$
begin
  if old.status = 'archived' and new is distinct from old then
    raise exception 'Archiwalny spis jest tylko do odczytu';
  end if;
  if new.status <> old.status and auth.uid() is not null
    and coalesce(current_setting('app.allow_inventory_status', true), '') <> 'true' then
    raise exception 'Status spisu może zmienić tylko automatyczne zadanie archiwizacji';
  end if;
  return new;
end;
$$;

create trigger inventories_protect_status before update on public.inventories
for each row execute function public.protect_inventory_status();

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

create trigger inventory_items_protect_archive before insert or update or delete on public.inventory_items
for each row execute function public.protect_archived_inventory_item();

create or replace function public.review_membership(target_store uuid, target_user uuid, decision public.membership_status)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_admin() or decision not in ('approved', 'rejected') then raise exception 'Brak uprawnień'; end if;
  update store_memberships set status = decision, reviewed_at = now(), reviewed_by = auth.uid()
  where store_id = target_store and user_id = target_user;
end;
$$;

create or replace function public.leave_store(target_store uuid)
returns void language sql security definer set search_path = public
as $$ delete from store_memberships where store_id = target_store and user_id = auth.uid() $$;

create or replace function public.request_store_membership(target_store uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  insert into store_memberships (store_id, user_id, status, requested_at, reviewed_at, reviewed_by)
  values (target_store, auth.uid(), 'pending', now(), null, null)
  on conflict (store_id, user_id) do update
    set status = 'pending', requested_at = now(), reviewed_at = null, reviewed_by = null;
end;
$$;

create or replace function public.review_category_request(target_request uuid, approve boolean)
returns void language plpgsql security definer set search_path = public
as $$
declare req category_requests%rowtype; fallback_id uuid;
begin
  if not is_admin() then raise exception 'Brak uprawnień'; end if;
  select * into req from category_requests where id = target_request and status = 'pending' for update;
  if req.id is null then raise exception 'Nie znaleziono zgłoszenia'; end if;
  if approve then
    if req.request_type = 'create' then
      insert into categories(name) values (trim(req.proposed_name));
    elsif req.request_type = 'rename' then
      update categories set name = trim(req.proposed_name) where id = req.category_id and not is_fallback;
    else
      select id into fallback_id from categories where is_fallback;
      if exists(select 1 from categories where id = req.category_id and is_fallback) then raise exception 'Nie można usunąć kategorii Inne'; end if;
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

alter table public.profiles enable row level security;
alter table public.stores enable row level security;
alter table public.store_memberships enable row level security;
alter table public.categories enable row level security;
alter table public.category_requests enable row level security;
alter table public.catalog_products enable row level security;
alter table public.store_prices enable row level security;
alter table public.inventories enable row level security;
alter table public.inventory_items enable row level security;
alter table public.reminder_views enable row level security;

create policy profiles_self_read on profiles for select using (id = auth.uid() or is_admin());
create policy stores_authenticated_read on stores for select to authenticated using (true);
create policy stores_admin_write on stores for all to authenticated using (is_admin()) with check (is_admin());
create policy memberships_self_or_admin_read on store_memberships for select using (user_id = auth.uid() or is_admin());
create policy memberships_self_request on store_memberships for insert with check (user_id = auth.uid() and status = 'pending');
create policy memberships_admin_write on store_memberships for all using (is_admin()) with check (is_admin());
create policy categories_authenticated_read on categories for select to authenticated using (true);
create policy categories_admin_write on categories for all to authenticated using (is_admin()) with check (is_admin());
create policy category_requests_read on category_requests for select using (requested_by = auth.uid() or is_admin());
create policy category_requests_create on category_requests for insert with check (requested_by = auth.uid() and status = 'pending');
create policy catalog_read on catalog_products for select to authenticated using (true);
create policy catalog_member_write on catalog_products for all to authenticated using (exists(select 1 from store_memberships where user_id = auth.uid() and status = 'approved')) with check (exists(select 1 from store_memberships where user_id = auth.uid() and status = 'approved'));
create policy prices_member_read on store_prices for select using (is_approved_member(store_id));
create policy prices_member_write on store_prices for all using (is_approved_member(store_id)) with check (is_approved_member(store_id));
create policy inventories_member_read on inventories for select using (is_approved_member(store_id));
create policy inventories_member_insert on inventories for insert with check (is_approved_member(store_id) and created_by = auth.uid());
create policy inventories_member_update on inventories for update using (is_approved_member(store_id)) with check (is_approved_member(store_id));
create policy items_member_read on inventory_items for select using (exists(select 1 from inventories i where i.id = inventory_id and is_approved_member(i.store_id)));
create policy items_member_write on inventory_items for all using (exists(select 1 from inventories i where i.id = inventory_id and is_approved_member(i.store_id))) with check (exists(select 1 from inventories i where i.id = inventory_id and is_approved_member(i.store_id)));
create policy reminders_self on reminder_views for all using (user_id = auth.uid()) with check (user_id = auth.uid());

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

grant execute on function public.review_membership(uuid, uuid, public.membership_status) to authenticated;
grant execute on function public.leave_store(uuid) to authenticated;
grant execute on function public.request_store_membership(uuid) to authenticated;
grant execute on function public.review_category_request(uuid, boolean) to authenticated;
grant execute on function public.archive_inventory(uuid) to authenticated;
grant execute on function public.restore_archived_inventory(uuid) to authenticated;
grant execute on function public.cancel_inventory(uuid) to authenticated;
grant execute on function public.set_inventory_item_flag(uuid, boolean) to authenticated;
grant execute on function public.delete_archived_inventory(uuid) to authenticated;
grant execute on function public.sync_inventory(jsonb) to authenticated;
grant execute on function public.sync_inventory_item(jsonb) to authenticated;

insert into public.categories (name, is_fallback) values
('Perfumy', false), ('Makijaż', false), ('Pielęgnacja twarzy', false),
('Pielęgnacja ciała', false), ('Włosy', false), ('Higiena', false),
('Golenie', false), ('Zdrowie', false), ('Chemia domowa', false),
('Artykuły dziecięce', false), ('Inne', true);

-- Po utworzeniu pierwszego konta nadaj administratora:
-- update public.profiles set role = 'admin' where email = 'admin@example.com';
