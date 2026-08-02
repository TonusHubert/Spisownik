-- R3: logiczne usuwanie, audyt operacji i odzyskiwanie.
-- Uruchom po schema.sql oraz dotychczasowych migracjach.

alter table public.stores add column if not exists deleted_at timestamptz;
alter table public.stores add column if not exists deleted_by uuid references public.profiles(id) on delete set null;
alter table public.stores add column if not exists deletion_reason text;

alter table public.inventories add column if not exists deleted_at timestamptz;
alter table public.inventories add column if not exists deleted_by uuid references public.profiles(id) on delete set null;
alter table public.inventories add column if not exists deletion_reason text;

alter table public.inventory_items add column if not exists deleted_by uuid references public.profiles(id) on delete set null;
alter table public.inventory_items add column if not exists deletion_reason text;

create index if not exists stores_deleted_at_idx on public.stores (deleted_at);
create index if not exists inventories_deleted_at_idx on public.inventories (deleted_at);
create index if not exists inventory_items_deleted_at_idx on public.inventory_items (deleted_at);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null check (length(trim(action)) between 1 and 80),
  entity_type text not null check (entity_type in ('store', 'inventory', 'item')),
  entity_id uuid not null,
  actor_id uuid references public.profiles(id) on delete set null,
  actor_name text not null,
  occurred_at timestamptz not null default now(),
  reason text not null check (length(trim(reason)) between 1 and 500),
  metadata jsonb not null default '{}'::jsonb,
  recovery_until timestamptz,
  dedupe_key text unique
);

-- Historia audytu jest append-only. Nie wiążemy operatora kluczem FK,
-- aby usunięcie profilu nie mogło zmienić historycznego wpisu.
alter table public.audit_log drop constraint if exists audit_log_actor_id_fkey;
create or replace function public.protect_audit_log_immutable()
returns trigger language plpgsql
as $$
begin
  raise exception 'audit_log jest niezmienny';
end;
$$;
drop trigger if exists audit_log_immutable on public.audit_log;
create trigger audit_log_immutable
before update or delete on public.audit_log
for each row execute function public.protect_audit_log_immutable();

create index if not exists audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id, occurred_at desc);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
drop policy if exists audit_log_admin_read on public.audit_log;
create policy audit_log_admin_read on public.audit_log
for select to authenticated using (public.is_admin());

create or replace function public.is_approved_member(target_store uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from store_memberships m
    join stores s on s.id = m.store_id
    where m.store_id = target_store
      and m.user_id = auth.uid()
      and m.status = 'approved'
      and s.deleted_at is null
  ) or public.is_admin()
$$;

create or replace function public.record_audit_event(
  target_action text,
  target_entity_type text,
  target_entity_id uuid,
  target_reason text,
  target_metadata jsonb default '{}'::jsonb,
  target_recovery_until timestamptz default null,
  target_dedupe_key text default null
)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  event_id uuid;
  author_name text;
begin
  if target_action is null or length(trim(target_action)) not between 1 and 80 then
    raise exception 'Nieprawidlowa operacja audytu';
  end if;
  if target_entity_type not in ('store', 'inventory', 'item') then
    raise exception 'Nieprawidlowy typ rekordu audytu';
  end if;
  if length(trim(coalesce(target_reason, ''))) not between 1 and 500 then
    raise exception 'Powod operacji jest wymagany';
  end if;

  select coalesce(nullif(trim(display_name), ''), email, 'Automat')
    into author_name
  from profiles
  where id = auth.uid();
  author_name := coalesce(author_name, 'Automat systemowy');

  insert into audit_log (
    action, entity_type, entity_id, actor_id, actor_name, reason,
    metadata, recovery_until, dedupe_key
  )
  values (
    trim(target_action), target_entity_type, target_entity_id, auth.uid(),
    author_name, trim(target_reason), coalesce(target_metadata, '{}'::jsonb),
    target_recovery_until, target_dedupe_key
  )
  on conflict (dedupe_key) do nothing
  returning id into event_id;

  return event_id;
end;
$$;

create or replace function public.preview_store_deletion(target_store uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  store_row public.stores%rowtype;
  inventory_count bigint;
  active_inventory_count bigint;
  archived_inventory_count bigint;
  item_count bigint;
  active_item_count bigint;
  quantity_total bigint;
  value_total numeric;
  membership_count bigint;
  price_count bigint;
  sensitive_check_count bigint;
  transaction_count bigint;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into store_row from stores where id = target_store and deleted_at is null;
  if not found then raise exception 'Nie znaleziono aktywnego sklepu'; end if;

  select count(*), count(*) filter (where status = 'active'), count(*) filter (where status = 'archived')
    into inventory_count, active_inventory_count, archived_inventory_count
  from inventories where store_id = target_store and deleted_at is null;

  select count(*), count(*) filter (where ii.deleted_at is null),
         coalesce(sum(ii.quantity) filter (where ii.deleted_at is null), 0),
         coalesce(sum(ii.quantity * ii.price) filter (where ii.deleted_at is null), 0)
    into item_count, active_item_count, quantity_total, value_total
  from inventory_items ii
  join inventories i on i.id = ii.inventory_id
  where i.store_id = target_store and i.deleted_at is null;

  select count(*) into membership_count from store_memberships where store_id = target_store;
  select count(*) into price_count from store_prices where store_id = target_store;
  select count(*) into sensitive_check_count from sensitive_product_checks where store_id = target_store;
  select count(*) into transaction_count from suspicious_transactions where store_id = target_store;

  return jsonb_build_object(
    'store_id', store_row.id,
    'store_name', store_row.name,
    'inventory_count', inventory_count,
    'active_inventory_count', active_inventory_count,
    'archived_inventory_count', archived_inventory_count,
    'item_count', item_count,
    'active_item_count', active_item_count,
    'quantity_total', quantity_total,
    'value_total', value_total,
    'membership_count', membership_count,
    'price_count', price_count,
    'sensitive_check_count', sensitive_check_count,
    'transaction_count', transaction_count,
    'recovery_days', 14
  );
end;
$$;

create or replace function public.preview_inventory_deletion(target_inventory uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  inventory_row public.inventories%rowtype;
  store_row public.stores%rowtype;
  item_count bigint;
  active_item_count bigint;
  quantity_total bigint;
  value_total numeric;
begin
  select i.* into inventory_row
  from inventories i
  join stores s on s.id = i.store_id
  where i.id = target_inventory and i.deleted_at is null and s.deleted_at is null;
  if not found then
    raise exception 'Nie znaleziono spisu lub brak uprawnien';
  end if;
  select * into store_row from stores where id = inventory_row.store_id and deleted_at is null;
  if not public.is_admin() and not public.is_approved_member(store_row.id) then
    raise exception 'Nie znaleziono spisu lub brak uprawnien';
  end if;

  select count(*), count(*) filter (where deleted_at is null),
         coalesce(sum(quantity) filter (where deleted_at is null), 0),
         coalesce(sum(quantity * price) filter (where deleted_at is null), 0)
    into item_count, active_item_count, quantity_total, value_total
  from inventory_items where inventory_id = target_inventory;

  return jsonb_build_object(
    'inventory_id', inventory_row.id,
    'inventory_name', inventory_row.name,
    'store_id', store_row.id,
    'store_name', store_row.name,
    'status', inventory_row.status,
    'item_count', item_count,
    'active_item_count', active_item_count,
    'quantity_total', quantity_total,
    'value_total', value_total,
    'recovery_days', 14
  );
end;
$$;

create or replace function public.archive_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare target_store uuid;
begin
  select i.store_id into target_store
  from inventories i
  join stores s on s.id = i.store_id
  where i.id = target_inventory and i.status = 'active' and i.deleted_at is null and s.deleted_at is null;
  if target_store is null or not public.is_approved_member(target_store) then raise exception 'Brak uprawnien'; end if;
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories set status = 'archived', archived_at = now(), updated_at = now()
  where id = target_inventory and deleted_at is null;
end;
$$;

create or replace function public.restore_archived_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare inventory_row public.inventories%rowtype;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into inventory_row
  from inventories
  where id = target_inventory and status = 'archived' and deleted_at is null
  for update;
  if not found then raise exception 'Nie znaleziono aktywnego archiwalnego spisu'; end if;
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories set status = 'active', archived_at = null, updated_at = now()
  where id = target_inventory;
  perform public.record_audit_event(
    'archive_restore', 'inventory', target_inventory, 'Przywrocenie archiwalnego spisu',
    jsonb_build_object('inventory_name', inventory_row.name, 'store_id', inventory_row.store_id)
  );
end;
$$;

create or replace function public.soft_delete_store(
  target_store uuid,
  expected_name text,
  target_reason text
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  store_row public.stores%rowtype;
  summary jsonb;
  deleted_at_value timestamptz := now();
  recovery_until_value timestamptz := now() + interval '14 days';
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  if length(trim(coalesce(target_reason, ''))) not between 1 and 500 then
    raise exception 'Powod usuniecia jest wymagany';
  end if;

  select * into store_row from stores where id = target_store and deleted_at is null for update;
  if not found then raise exception 'Sklep nie istnieje albo jest juz usuniety'; end if;
  if trim(coalesce(expected_name, '')) <> store_row.name then
    raise exception 'Nazwa sklepu nie pasuje. Odswiez dane i sprobuj ponownie';
  end if;

  summary := public.preview_store_deletion(target_store);
  perform set_config('app.allow_destructive_operation', 'true', true);
  update stores
  set deleted_at = deleted_at_value, deleted_by = auth.uid(), deletion_reason = trim(target_reason)
  where id = target_store;

  perform public.record_audit_event(
    'soft_delete', 'store', target_store, target_reason,
    summary || jsonb_build_object('deleted_at', deleted_at_value),
    recovery_until_value
  );
  return summary || jsonb_build_object('deleted_at', deleted_at_value, 'recovery_until', recovery_until_value);
end;
$$;

create or replace function public.soft_delete_inventory(
  target_inventory uuid,
  target_reason text
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  inventory_row public.inventories%rowtype;
  store_id_value uuid;
  summary jsonb;
  deleted_at_value timestamptz := now();
  recovery_until_value timestamptz := now() + interval '14 days';
begin
  if length(trim(coalesce(target_reason, ''))) not between 1 and 500 then
    raise exception 'Powod usuniecia jest wymagany';
  end if;

  select i.* into inventory_row
  from inventories i
  join stores s on s.id = i.store_id
  where i.id = target_inventory and i.deleted_at is null and s.deleted_at is null
  for update;
  store_id_value := inventory_row.store_id;
  if not found or not public.is_approved_member(store_id_value) then
    raise exception 'Nie znaleziono spisu lub brak uprawnien';
  end if;
  if inventory_row.status = 'archived' and not public.is_admin() then
    raise exception 'Archiwalny spis moze usunac tylko administrator';
  end if;

  summary := public.preview_inventory_deletion(target_inventory);
  perform set_config('app.allow_destructive_operation', 'true', true);
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories
  set deleted_at = deleted_at_value, deleted_by = auth.uid(), deletion_reason = trim(target_reason),
      updated_at = deleted_at_value
  where id = target_inventory;

  perform public.record_audit_event(
    case when inventory_row.status = 'active' then 'cancel' else 'soft_delete' end,
    'inventory', target_inventory, target_reason,
    summary || jsonb_build_object('deleted_at', deleted_at_value),
    recovery_until_value
  );
  return summary || jsonb_build_object('deleted_at', deleted_at_value, 'recovery_until', recovery_until_value);
end;
$$;

drop function if exists public.cancel_inventory(uuid);
create or replace function public.cancel_inventory(target_inventory uuid, target_reason text)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  return public.soft_delete_inventory(target_inventory, target_reason);
end;
$$;

drop function if exists public.delete_empty_active_inventory(uuid);
create or replace function public.delete_empty_active_inventory(target_inventory uuid, target_reason text)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  if exists (select 1 from inventory_items where inventory_id = target_inventory) then
    raise exception 'Spis nie jest pusty';
  end if;
  return public.soft_delete_inventory(target_inventory, target_reason);
end;
$$;

drop function if exists public.delete_archived_inventory(uuid);
create or replace function public.delete_archived_inventory(target_inventory uuid, target_reason text)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  if not exists (select 1 from inventories where id = target_inventory and status = 'archived' and deleted_at is null) then
    raise exception 'Nie znaleziono aktywnego archiwalnego spisu';
  end if;
  return public.soft_delete_inventory(target_inventory, target_reason);
end;
$$;

create or replace function public.restore_deleted_store(target_store uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  store_row public.stores%rowtype;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into store_row from stores where id = target_store and deleted_at is not null for update;
  if not found then raise exception 'Nie znaleziono usunietego sklepu'; end if;
  if store_row.deleted_at + interval '14 days' <= now() then raise exception 'Okres odzyskiwania minal'; end if;

  perform set_config('app.allow_destructive_operation', 'true', true);
  update stores set deleted_at = null, deleted_by = null, deletion_reason = null where id = target_store;
  perform public.record_audit_event(
    'restore', 'store', target_store, 'Przywrocenie sklepu',
    jsonb_build_object('store_name', store_row.name)
  );
end;
$$;

create or replace function public.restore_deleted_inventory(target_inventory uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare inventory_row public.inventories%rowtype;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into inventory_row from inventories where id = target_inventory and deleted_at is not null for update;
  if not found then raise exception 'Nie znaleziono usunietego spisu'; end if;
  if inventory_row.deleted_at + interval '14 days' <= now() then raise exception 'Okres odzyskiwania minal'; end if;

  perform set_config('app.allow_destructive_operation', 'true', true);
  perform set_config('app.allow_inventory_status', 'true', true);
  update inventories set deleted_at = null, deleted_by = null, deletion_reason = null, updated_at = now()
  where id = target_inventory;
  perform public.record_audit_event(
    'restore', 'inventory', target_inventory, 'Przywrocenie spisu',
    jsonb_build_object('inventory_name', inventory_row.name, 'store_id', inventory_row.store_id)
  );
end;
$$;

create or replace function public.restore_deleted_item(target_item uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare item_row public.inventory_items%rowtype;
begin
  if not public.is_admin() then raise exception 'Brak uprawnien'; end if;
  select * into item_row from inventory_items where id = target_item and deleted_at is not null for update;
  if not found then raise exception 'Nie znaleziono usunietej pozycji'; end if;
  if item_row.deleted_at + interval '14 days' <= now() then raise exception 'Okres odzyskiwania minal'; end if;

  perform set_config('app.allow_destructive_operation', 'true', true);
  perform set_config('app.allow_inventory_flag', 'true', true);
  update inventory_items set deleted_at = null, deleted_by = null, deletion_reason = null, updated_at = now()
  where id = target_item;
  perform public.record_audit_event(
    'restore', 'item', target_item, 'Przywrocenie pozycji',
    jsonb_build_object('inventory_id', item_row.inventory_id, 'ean', item_row.ean, 'name', item_row.name)
  );
end;
$$;

create or replace function public.list_deleted_data()
returns table (
  entity_type text,
  entity_id uuid,
  name text,
  store_name text,
  status text,
  deleted_at timestamptz,
  recovery_until timestamptz,
  deleted_by text,
  reason text,
  item_count bigint,
  quantity_total bigint,
  value_total numeric,
  can_restore boolean
)
language sql security definer set search_path = public
as $$
  select 'store', s.id, s.name, null::text, null::text, s.deleted_at,
    s.deleted_at + interval '14 days',
    coalesce(nullif(trim(p.display_name), ''), p.email, 'Nieznany uzytkownik'),
    s.deletion_reason,
    coalesce((select count(*) from inventories i where i.store_id = s.id), 0),
    coalesce((select sum(ii.quantity) from inventory_items ii join inventories i on i.id = ii.inventory_id where i.store_id = s.id and ii.deleted_at is null), 0),
    coalesce((select sum(ii.quantity * ii.price) from inventory_items ii join inventories i on i.id = ii.inventory_id where i.store_id = s.id and ii.deleted_at is null), 0),
    s.deleted_at + interval '14 days' > now()
  from stores s
  left join profiles p on p.id = s.deleted_by
  where s.deleted_at is not null
  union all
  select 'inventory', i.id, i.name, s.name, i.status::text, i.deleted_at,
    i.deleted_at + interval '14 days',
    coalesce(nullif(trim(p.display_name), ''), p.email, 'Nieznany uzytkownik'),
    i.deletion_reason,
    (select count(*) from inventory_items ii where ii.inventory_id = i.id),
    coalesce((select sum(ii.quantity) from inventory_items ii where ii.inventory_id = i.id and ii.deleted_at is null), 0),
    coalesce((select sum(ii.quantity * ii.price) from inventory_items ii where ii.inventory_id = i.id and ii.deleted_at is null), 0),
    i.deleted_at + interval '14 days' > now()
  from inventories i
  join stores s on s.id = i.store_id
  left join profiles p on p.id = i.deleted_by
  where i.deleted_at is not null and s.deleted_at is null
  union all
  select 'item', ii.id, ii.name, s.name, null::text, ii.deleted_at,
    ii.deleted_at + interval '14 days',
    coalesce(nullif(trim(p.display_name), ''), p.email, 'Nieznany uzytkownik'),
    ii.deletion_reason,
    1::bigint, ii.quantity::bigint, (ii.quantity * ii.price)::numeric,
    ii.deleted_at + interval '14 days' > now()
  from inventory_items ii
  join inventories i on i.id = ii.inventory_id
  join stores s on s.id = i.store_id
  left join profiles p on p.id = ii.deleted_by
  where ii.deleted_at is not null and i.deleted_at is null and s.deleted_at is null
  order by deleted_at desc;
$$;

create or replace function public.purge_expired_inventories()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  marked integer := 0;
  inventory_row record;
  summary jsonb;
  deleted_at_value timestamptz;
begin
  for inventory_row in
    select i.id, i.store_id, i.name, i.status, i.archived_at
    from inventories i
    join stores s on s.id = i.store_id
    where i.status = 'archived' and i.deleted_at is null
      and i.archived_at + make_interval(days => s.retention_days + 14) <= now()
    for update skip locked
  loop
    deleted_at_value := now();
    summary := jsonb_build_object(
      'inventory_id', inventory_row.id,
      'inventory_name', inventory_row.name,
      'store_id', inventory_row.store_id,
      'item_count', (select count(*) from inventory_items where inventory_id = inventory_row.id)
    );
    perform set_config('app.allow_destructive_operation', 'true', true);
    perform set_config('app.allow_inventory_status', 'true', true);
    update inventories
    set deleted_at = deleted_at_value, deletion_reason = 'Automatyczne przekroczenie retencji archiwum',
        updated_at = deleted_at_value
    where id = inventory_row.id;
    perform public.record_audit_event(
      'retention_delete', 'inventory', inventory_row.id,
      'Automatyczne przekroczenie retencji archiwum', summary,
      deleted_at_value + interval '14 days'
    );
    marked := marked + 1;
  end loop;
  return marked;
end;
$$;

create or replace function public.purge_expired_deleted_data()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  removed integer := 0;
  target_id uuid;
begin
  perform set_config('app.allow_destructive_operation', 'true', true);
  perform set_config('app.allow_inventory_status', 'true', true);
  perform set_config('app.allow_inventory_flag', 'true', true);

  for target_id in
    select id from inventory_items
    where deleted_at is not null and deleted_at + interval '14 days' <= now()
    for update skip locked
  loop
    delete from inventory_items where id = target_id;
    removed := removed + 1;
  end loop;

  for target_id in
    select id from inventories
    where deleted_at is not null and deleted_at + interval '14 days' <= now()
    for update skip locked
  loop
    delete from inventories where id = target_id;
    removed := removed + 1;
  end loop;

  for target_id in
    select id from stores
    where deleted_at is not null and deleted_at + interval '14 days' <= now()
    for update skip locked
  loop
    delete from stores where id = target_id;
    removed := removed + 1;
  end loop;

  return removed;
end;
$$;

create or replace function public.protect_r3_destructive_fields()
returns trigger language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('app.allow_destructive_operation', true), '') <> 'true' then
    raise exception 'Fizyczne usuwanie jest zablokowane. Uzyj operacji odzyskiwalnej';
  end if;
  if tg_op = 'UPDATE'
     and (
       new.deleted_at is distinct from old.deleted_at
       or new.deleted_by is distinct from old.deleted_by
       or new.deletion_reason is distinct from old.deletion_reason
     )
     and coalesce(current_setting('app.allow_destructive_operation', true), '') <> 'true' then
    raise exception 'Zmiana statusu usuniecia wymaga operacji audytowanej';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists stores_protect_r3_destructive_fields on public.stores;
create trigger stores_protect_r3_destructive_fields
before update or delete on public.stores
for each row execute function public.protect_r3_destructive_fields();

drop trigger if exists inventories_protect_r3_destructive_fields on public.inventories;
create trigger inventories_protect_r3_destructive_fields
before update or delete on public.inventories
for each row execute function public.protect_r3_destructive_fields();

drop trigger if exists inventory_items_protect_r3_destructive_fields on public.inventory_items;
create trigger inventory_items_protect_r3_destructive_fields
before update or delete on public.inventory_items
for each row execute function public.protect_r3_destructive_fields();

drop policy if exists stores_authenticated_read on public.stores;
create policy stores_authenticated_read on public.stores
for select to authenticated using (deleted_at is null);
drop policy if exists stores_admin_write on public.stores;
drop policy if exists stores_admin_insert on public.stores;
create policy stores_admin_insert on public.stores
for insert to authenticated with check (public.is_admin() and deleted_at is null);
drop policy if exists stores_admin_update on public.stores;
create policy stores_admin_update on public.stores
for update to authenticated using (public.is_admin() and deleted_at is null)
with check (public.is_admin() and deleted_at is null);

drop policy if exists memberships_self_or_admin_read on public.store_memberships;
create policy memberships_self_or_admin_read on public.store_memberships
for select to authenticated using (
  (user_id = auth.uid() or public.is_admin())
  and (public.is_admin() or exists (select 1 from stores s where s.id = store_id and s.deleted_at is null))
);

drop policy if exists prices_member_read on public.store_prices;
create policy prices_member_read on public.store_prices
for select using (
  public.is_approved_member(store_id)
  and exists (select 1 from stores s where s.id = store_id and s.deleted_at is null)
);
drop policy if exists prices_member_write on public.store_prices;
create policy prices_member_write on public.store_prices
for all using (
  public.is_approved_member(store_id)
  and exists (select 1 from stores s where s.id = store_id and s.deleted_at is null)
) with check (
  public.is_approved_member(store_id)
  and exists (select 1 from stores s where s.id = store_id and s.deleted_at is null)
);

drop policy if exists inventories_member_read on public.inventories;
create policy inventories_member_read on public.inventories
for select using (deleted_at is null and public.is_approved_member(store_id));
drop policy if exists inventories_member_insert on public.inventories;
create policy inventories_member_insert on public.inventories
for insert with check (deleted_at is null and public.is_approved_member(store_id) and created_by = auth.uid());
drop policy if exists inventories_member_update on public.inventories;
create policy inventories_member_update on public.inventories
for update using (deleted_at is null and public.is_approved_member(store_id))
with check (deleted_at is null and public.is_approved_member(store_id));

drop policy if exists items_member_read on public.inventory_items;
create policy items_member_read on public.inventory_items
for select using (
  deleted_at is null and exists (
    select 1 from inventories i
    join stores s on s.id = i.store_id
    where i.id = inventory_id and i.deleted_at is null and s.deleted_at is null
      and public.is_approved_member(i.store_id)
  )
);
drop policy if exists items_member_write on public.inventory_items;
drop policy if exists items_member_insert on public.inventory_items;
create policy items_member_insert on public.inventory_items
for insert with check (
  deleted_at is null and exists (
    select 1 from inventories i
    join stores s on s.id = i.store_id
    where i.id = inventory_id and i.deleted_at is null and s.deleted_at is null
      and public.is_approved_member(i.store_id)
  )
);

revoke delete on table public.stores, public.inventories, public.inventory_items from public, anon, authenticated;

create or replace function public.sync_inventory(payload jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_store uuid := (payload->>'store_id')::uuid;
  target_inventory uuid := (payload->>'id')::uuid;
  existing_status public.inventory_status;
  existing_deleted_at timestamptz;
begin
  if not public.is_approved_member(target_store)
     or exists (select 1 from stores where id = target_store and deleted_at is not null) then
    raise exception 'Brak uprawnien';
  end if;
  select status, deleted_at into existing_status, existing_deleted_at from inventories where id = target_inventory;
  if existing_deleted_at is not null then raise exception 'Spis jest usuniety'; end if;
  if existing_status = 'archived' and not public.is_admin() then raise exception 'Archiwalny spis jest tylko do odczytu'; end if;
  if existing_status = 'archived' then perform set_config('app.allow_inventory_status', 'true', true); end if;

  insert into inventories (id, store_id, name, status, created_at, created_by, updated_at)
  values (
    target_inventory, target_store, trim(payload->>'name'), 'active',
    (payload->>'created_at')::timestamptz, auth.uid(), (payload->>'updated_at')::timestamptz
  )
  on conflict (id) do update set name = excluded.name, updated_at = excluded.updated_at
  where inventories.store_id = excluded.store_id
    and inventories.deleted_at is null
    and (inventories.status = 'active' or (inventories.status = 'archived' and public.is_admin()))
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
  target_inventory_deleted_at timestamptz;
  existing_item public.inventory_items%rowtype;
  changed_at timestamptz := (payload->>'updated_at')::timestamptz;
  deleted_at_value timestamptz := nullif(payload->>'deleted_at', '')::timestamptz;
  reason_value text := nullif(trim(payload->>'deletion_reason'), '');
begin
  select i.store_id, i.status, i.deleted_at
    into target_store, target_status, target_inventory_deleted_at
  from inventories i
  join stores s on s.id = i.store_id
  where i.id = target_inventory and s.deleted_at is null;
  if target_store is null or target_inventory_deleted_at is not null or not public.is_approved_member(target_store) then
    raise exception 'Brak uprawnien';
  end if;
  if target_status = 'archived' and not public.is_admin() then raise exception 'Archiwalny spis jest tylko do odczytu'; end if;
  if target_status = 'archived' then perform set_config('app.allow_inventory_flag', 'true', true); end if;

  select * into existing_item from inventory_items where id = (payload->>'id')::uuid and inventory_id = target_inventory for update;
  if deleted_at_value is not null then
    reason_value := coalesce(reason_value, 'Usuniecie pozycji z poprzedniej wersji aplikacji');
    if not found then raise exception 'Nie znaleziono pozycji'; end if;
    if existing_item.deleted_at is not null then
      if existing_item.deleted_at = deleted_at_value then return; end if;
      if changed_at < existing_item.updated_at then return; end if;
    end if;
    perform set_config('app.allow_destructive_operation', 'true', true);
    update inventory_items
    set deleted_at = deleted_at_value, deleted_by = auth.uid(), deletion_reason = reason_value, updated_at = changed_at
    where id = existing_item.id and changed_at >= updated_at;
    if found then
      perform public.record_audit_event(
        'soft_delete', 'item', existing_item.id, reason_value,
        jsonb_build_object('inventory_id', target_inventory, 'store_id', target_store, 'ean', existing_item.ean, 'name', existing_item.name, 'quantity', existing_item.quantity, 'price', existing_item.price),
        deleted_at_value + interval '14 days',
        'item-delete:' || existing_item.id::text || ':' || deleted_at_value::text
      );
    end if;
    return;
  end if;

  if found and existing_item.deleted_at is not null then raise exception 'Pozycja jest usunieta'; end if;
  insert into catalog_products (ean, name, category_id, updated_at, updated_by)
  values (payload->>'ean', trim(payload->>'name'), (payload->>'category_id')::uuid, changed_at, auth.uid())
  on conflict (ean) do update set name = excluded.name, category_id = excluded.category_id, updated_at = excluded.updated_at, updated_by = auth.uid()
  where excluded.updated_at >= catalog_products.updated_at;

  insert into store_prices (store_id, ean, price, updated_at, updated_by)
  values (target_store, payload->>'ean', (payload->>'price')::numeric, changed_at, auth.uid())
  on conflict (store_id, ean) do update set price = excluded.price, updated_at = excluded.updated_at, updated_by = auth.uid()
  where excluded.updated_at >= store_prices.updated_at;

  insert into inventory_items (id, inventory_id, ean, name, category_id, quantity, price, created_at, updated_at, deleted_at, deleted_by, deletion_reason)
  values (
    (payload->>'id')::uuid, target_inventory, payload->>'ean', trim(payload->>'name'),
    (payload->>'category_id')::uuid, (payload->>'quantity')::integer, (payload->>'price')::numeric,
    (payload->>'created_at')::timestamptz, changed_at, null, null, null
  )
  on conflict (id) do update set
    ean = excluded.ean, name = excluded.name, category_id = excluded.category_id, quantity = excluded.quantity,
    price = excluded.price, updated_at = excluded.updated_at, deleted_at = null, deleted_by = null, deletion_reason = null
  where excluded.updated_at >= inventory_items.updated_at and inventory_items.deleted_at is null;
end;
$$;

revoke all on function public.record_audit_event(text, text, uuid, text, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.soft_delete_store(uuid, text, text) from public, anon;
revoke all on function public.soft_delete_inventory(uuid, text) from public, anon;
revoke all on function public.preview_store_deletion(uuid) from public, anon;
revoke all on function public.preview_inventory_deletion(uuid) from public, anon;
revoke all on function public.restore_deleted_store(uuid) from public, anon;
revoke all on function public.restore_deleted_inventory(uuid) from public, anon;
revoke all on function public.restore_deleted_item(uuid) from public, anon;
revoke all on function public.list_deleted_data() from public, anon;
revoke all on function public.cancel_inventory(uuid, text) from public, anon;
revoke all on function public.delete_empty_active_inventory(uuid, text) from public, anon;
revoke all on function public.delete_archived_inventory(uuid, text) from public, anon;
revoke all on function public.purge_expired_inventories() from public, anon, authenticated;
revoke all on function public.purge_expired_deleted_data() from public, anon, authenticated;

grant execute on function public.preview_store_deletion(uuid) to authenticated;
grant execute on function public.preview_inventory_deletion(uuid) to authenticated;
grant execute on function public.soft_delete_store(uuid, text, text) to authenticated;
grant execute on function public.soft_delete_inventory(uuid, text) to authenticated;
grant execute on function public.restore_deleted_store(uuid) to authenticated;
grant execute on function public.restore_deleted_inventory(uuid) to authenticated;
grant execute on function public.restore_deleted_item(uuid) to authenticated;
grant execute on function public.list_deleted_data() to authenticated;
grant execute on function public.cancel_inventory(uuid, text) to authenticated;
grant execute on function public.delete_empty_active_inventory(uuid, text) to authenticated;
grant execute on function public.delete_archived_inventory(uuid, text) to authenticated;
grant execute on function public.sync_inventory(jsonb) to authenticated;
grant execute on function public.sync_inventory_item(jsonb) to authenticated;

-- Supabase pg_cron: uruchom po instalacji:
-- select cron.schedule('spisownik-r3-retention', '15 3 * * *', $$select public.purge_expired_inventories(); select public.purge_expired_deleted_data();$$);
