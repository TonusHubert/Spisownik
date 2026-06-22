create extension if not exists pgcrypto;

create type public.app_role as enum ('admin', 'worker');
create type public.membership_status as enum ('pending', 'approved', 'rejected');
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
  flag_assigned boolean not null default false,
  verified boolean not null default false
);

create unique index inventory_items_active_ean on public.inventory_items (inventory_id, ean) where deleted_at is null;

create table public.reminder_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  reminder_date date not null default current_date,
  primary key (user_id, store_id, reminder_date)
);

create table public.sensitive_products (
  id uuid primary key default gen_random_uuid(),
  ean text not null unique check (length(trim(ean)) between 1 and 32),
  name text not null check (length(trim(name)) between 1 and 120),
  image_path text,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id)
);

create table public.sensitive_product_checks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.sensitive_products(id) on delete cascade,
  check_date date not null,
  quantity integer not null check (quantity >= 0),
  checked_at timestamptz not null default now(),
  checked_by uuid not null references public.profiles(id),
  unique (store_id, product_id, check_date)
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

create or replace function public.admin_delete_category(target_category uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare fallback_id uuid;
begin
  if not is_admin() then raise exception 'Brak uprawnień'; end if;
  select id into fallback_id from categories where is_fallback;
  if fallback_id is null then raise exception 'Nie znaleziono kategorii zastępczej Inne'; end if;
  if target_category = fallback_id then raise exception 'Nie można usunąć kategorii Inne'; end if;
  if not exists(select 1 from categories where id = target_category) then raise exception 'Nie znaleziono kategorii'; end if;
  update catalog_products set category_id = fallback_id where category_id = target_category;
  perform set_config('app.allow_inventory_flag', 'true', true);
  update inventory_items set category_id = fallback_id where category_id = target_category;
  delete from categories where id = target_category;
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
alter table public.catalog_products enable row level security;
alter table public.store_prices enable row level security;
alter table public.inventories enable row level security;
alter table public.inventory_items enable row level security;
alter table public.reminder_views enable row level security;
alter table public.sensitive_products enable row level security;
alter table public.sensitive_product_checks enable row level security;

create policy profiles_self_read on profiles for select using (id = auth.uid() or is_admin());
create policy stores_authenticated_read on stores for select to authenticated using (true);
create policy stores_admin_write on stores for all to authenticated using (is_admin()) with check (is_admin());
create policy memberships_self_or_admin_read on store_memberships for select using (user_id = auth.uid() or is_admin());
create policy memberships_admin_write on store_memberships for all using (is_admin()) with check (is_admin());
create policy categories_authenticated_read on categories for select to authenticated using (true);
create policy categories_admin_write on categories for all to authenticated using (is_admin()) with check (is_admin());
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
create policy sensitive_products_authenticated_read on sensitive_products for select to authenticated using (true);
create policy sensitive_products_admin_write on sensitive_products for all to authenticated using (is_admin()) with check (is_admin());
create policy sensitive_checks_member_read on sensitive_product_checks for select to authenticated using (is_approved_member(store_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sensitive-product-images', 'sensitive-product-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy sensitive_product_images_public_read on storage.objects
for select using (bucket_id = 'sensitive-product-images');
create policy sensitive_product_images_admin_insert on storage.objects
for insert to authenticated with check (bucket_id = 'sensitive-product-images' and public.is_admin());
create policy sensitive_product_images_admin_update on storage.objects
for update to authenticated using (bucket_id = 'sensitive-product-images' and public.is_admin())
with check (bucket_id = 'sensitive-product-images' and public.is_admin());
create policy sensitive_product_images_admin_delete on storage.objects
for delete to authenticated using (bucket_id = 'sensitive-product-images' and public.is_admin());

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

revoke all on function public.admin_delete_category(uuid) from public, anon;
grant execute on function public.admin_delete_category(uuid) to authenticated;

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

create or replace function public.set_inventory_item_verified(target_item uuid, verified_value boolean)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if verified_value is null then raise exception 'Brak wartości weryfikacji'; end if;
  if not exists (
    select 1 from inventory_items ii join inventories i on i.id = ii.inventory_id
    where ii.id = target_item and ii.deleted_at is null and i.status = 'archived' and is_approved_member(i.store_id)
  ) then raise exception 'Brak uprawnień lub spis nie jest w archiwum'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  update inventory_items set verified = verified_value, updated_at = now() where id = target_item;
end;
$$;

create or replace function public.submit_sensitive_product_check(target_store uuid, target_product uuid, shelf_quantity integer)
returns void language plpgsql security definer set search_path = public
as $$
declare today_warsaw date := timezone('Europe/Warsaw', now())::date;
begin
  if not is_approved_member(target_store) then raise exception 'Brak uprawnień do sklepu'; end if;
  if shelf_quantity is null or shelf_quantity < 0 then raise exception 'Nieprawidłowa liczba sztuk'; end if;
  if not exists (select 1 from sensitive_products where id = target_product) then raise exception 'Nie znaleziono produktu wrażliwego'; end if;
  insert into sensitive_product_checks (store_id, product_id, check_date, quantity, checked_at, checked_by)
  values (target_store, target_product, today_warsaw, shelf_quantity, now(), auth.uid())
  on conflict (store_id, product_id, check_date) do update
    set quantity = excluded.quantity, checked_at = excluded.checked_at, checked_by = excluded.checked_by;
end;
$$;

create or replace function public.delete_empty_active_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  if not is_admin() then raise exception 'Brak uprawnień'; end if;
  select store_id into target_store from inventories where id = target_inventory and status = 'active' for update;
  if target_store is null then raise exception 'Nie znaleziono aktywnego spisu'; end if;
  if exists (select 1 from inventory_items where inventory_id = target_inventory) then raise exception 'Spis nie jest pusty'; end if;
  delete from inventories where id = target_inventory and status = 'active';
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

grant execute on function public.admin_delete_category(uuid) to authenticated;
grant execute on function public.archive_inventory(uuid) to authenticated;
grant execute on function public.restore_archived_inventory(uuid) to authenticated;
grant execute on function public.cancel_inventory(uuid) to authenticated;
grant execute on function public.set_inventory_item_flag(uuid, boolean) to authenticated;
revoke all on function public.set_inventory_item_verified(uuid, boolean) from public, anon;
revoke all on function public.submit_sensitive_product_check(uuid, uuid, integer) from public, anon;
revoke all on function public.delete_empty_active_inventory(uuid) from public, anon;
grant execute on function public.set_inventory_item_verified(uuid, boolean) to authenticated;
grant execute on function public.submit_sensitive_product_check(uuid, uuid, integer) to authenticated;
grant execute on function public.delete_empty_active_inventory(uuid) to authenticated;
grant execute on function public.delete_archived_inventory(uuid) to authenticated;
grant execute on function public.sync_inventory(jsonb) to authenticated;
grant execute on function public.sync_inventory_item(jsonb) to authenticated;

create type public.suspicious_transaction_type as enum ('receipt', 'application');

create table public.suspicious_transactions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  entry_type public.suspicious_transaction_type not null,
  reference_number text not null check (length(trim(reference_number)) between 1 and 80),
  receipt_date date,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  created_by_name text not null,
  checked_at timestamptz,
  checked_by uuid references public.profiles(id),
  checked_by_name text,
  check (
    (entry_type = 'receipt' and receipt_date is not null)
    or (entry_type = 'application' and receipt_date is null)
  ),
  check (
    (checked_at is null and checked_by is null and checked_by_name is null)
    or (checked_at is not null and checked_by is not null and checked_by_name is not null)
  )
);

create unique index suspicious_transactions_pending_number
on public.suspicious_transactions (store_id, entry_type, lower(trim(reference_number)))
where checked_at is null;

create index suspicious_transactions_store_created
on public.suspicious_transactions (store_id, created_at desc);

create table public.transaction_reminder_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  reminder_date date not null,
  primary key (user_id, store_id, reminder_date)
);

alter table public.suspicious_transactions enable row level security;
alter table public.transaction_reminder_views enable row level security;

create policy suspicious_transactions_member_read on public.suspicious_transactions
for select to authenticated using (is_approved_member(store_id));
create policy transaction_reminders_self on public.transaction_reminder_views
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and is_approved_member(store_id));

create or replace function public.add_suspicious_transaction(
  target_store uuid,
  target_type public.suspicious_transaction_type,
  target_number text,
  target_receipt_date date,
  target_note text
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  new_id uuid;
  author_name text;
  today_warsaw date := timezone('Europe/Warsaw', now())::date;
begin
  if not is_approved_member(target_store) then raise exception 'Brak uprawnien do sklepu'; end if;
  if target_type is null or length(trim(coalesce(target_number, ''))) not between 1 and 80 then raise exception 'Podaj prawidlowy numer'; end if;
  if target_note is not null and length(target_note) > 500 then raise exception 'Notatka jest za dluga'; end if;
  if target_type = 'receipt' and (target_receipt_date is null or target_receipt_date > today_warsaw) then raise exception 'Data paragonu nie moze byc przyszla'; end if;
  if target_type = 'application' then target_receipt_date := null; end if;
  if exists (
    select 1 from suspicious_transactions
    where store_id = target_store and entry_type = target_type
      and lower(trim(reference_number)) = lower(trim(target_number)) and checked_at is null
  ) then raise exception 'Taki oczekujacy numer juz istnieje'; end if;
  select coalesce(nullif(trim(display_name), ''), email) into author_name from profiles where id = auth.uid();
  insert into suspicious_transactions (store_id, entry_type, reference_number, receipt_date, note, created_by, created_by_name)
  values (target_store, target_type, trim(target_number), target_receipt_date, nullif(trim(coalesce(target_note, '')), ''), auth.uid(), author_name)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.update_suspicious_transaction(
  target_id uuid,
  target_type public.suspicious_transaction_type,
  target_number text,
  target_receipt_date date,
  target_note text
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_store uuid;
  today_warsaw date := timezone('Europe/Warsaw', now())::date;
begin
  select store_id into target_store from suspicious_transactions where id = target_id and checked_at is null for update;
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien lub wpis zostal juz sprawdzony'; end if;
  if target_type is null or length(trim(coalesce(target_number, ''))) not between 1 and 80 then raise exception 'Podaj prawidlowy numer'; end if;
  if target_note is not null and length(target_note) > 500 then raise exception 'Notatka jest za dluga'; end if;
  if target_type = 'receipt' and (target_receipt_date is null or target_receipt_date > today_warsaw) then raise exception 'Data paragonu nie moze byc przyszla'; end if;
  if target_type = 'application' then target_receipt_date := null; end if;
  if exists (
    select 1 from suspicious_transactions
    where id <> target_id and store_id = target_store and entry_type = target_type
      and lower(trim(reference_number)) = lower(trim(target_number)) and checked_at is null
  ) then raise exception 'Taki oczekujacy numer juz istnieje'; end if;
  update suspicious_transactions
  set entry_type = target_type, reference_number = trim(target_number), receipt_date = target_receipt_date,
      note = nullif(trim(coalesce(target_note, '')), '')
  where id = target_id;
end;
$$;

create or replace function public.delete_suspicious_transaction(target_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select store_id into target_store from suspicious_transactions where id = target_id and checked_at is null for update;
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien lub wpis zostal juz sprawdzony'; end if;
  delete from suspicious_transactions where id = target_id;
end;
$$;

create or replace function public.check_suspicious_transaction(target_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_store uuid;
  checker_name text;
begin
  select store_id into target_store from suspicious_transactions where id = target_id and checked_at is null for update;
  if target_store is null or not is_approved_member(target_store) then raise exception 'Brak uprawnien lub wpis zostal juz sprawdzony'; end if;
  select coalesce(nullif(trim(display_name), ''), email) into checker_name from profiles where id = auth.uid();
  update suspicious_transactions
  set checked_at = now(), checked_by = auth.uid(), checked_by_name = checker_name
  where id = target_id;
end;
$$;

revoke all on function public.add_suspicious_transaction(uuid, public.suspicious_transaction_type, text, date, text) from public, anon;
revoke all on function public.update_suspicious_transaction(uuid, public.suspicious_transaction_type, text, date, text) from public, anon;
revoke all on function public.delete_suspicious_transaction(uuid) from public, anon;
revoke all on function public.check_suspicious_transaction(uuid) from public, anon;
grant execute on function public.add_suspicious_transaction(uuid, public.suspicious_transaction_type, text, date, text) to authenticated;
grant execute on function public.update_suspicious_transaction(uuid, public.suspicious_transaction_type, text, date, text) to authenticated;
grant execute on function public.delete_suspicious_transaction(uuid) to authenticated;
grant execute on function public.check_suspicious_transaction(uuid) to authenticated;

insert into public.categories (name, is_fallback) values
('Perfumy', false), ('Makijaż', false), ('Pielęgnacja twarzy', false),
('Pielęgnacja ciała', false), ('Włosy', false), ('Higiena', false),
('Golenie', false), ('Zdrowie', false), ('Chemia domowa', false),
('Artykuły dziecięce', false), ('Inne', true);

-- Po utworzeniu pierwszego konta nadaj administratora:
-- update public.profiles set role = 'admin' where email = 'admin@example.com';
