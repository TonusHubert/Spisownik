-- Cykliczny monitoring numerow aplikacji i paragonow ("Recydywa") oraz
-- atomowe dodawanie wielu podejrzanych transakcji.

alter table public.stores
add column if not exists recidivism_default_interval_days integer;

update public.stores
set recidivism_default_interval_days = least(7, retention_days)
where recidivism_default_interval_days is null;

alter table public.stores
alter column recidivism_default_interval_days set default 1,
alter column recidivism_default_interval_days set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'stores_recidivism_interval_valid' and conrelid = 'public.stores'::regclass
  ) then
    alter table public.stores add constraint stores_recidivism_interval_valid check (
      recidivism_default_interval_days between 1 and 365
      and recidivism_default_interval_days <= retention_days
    );
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'recidivism_entry_type') then
    create type public.recidivism_entry_type as enum ('receipt', 'application');
  end if;
end;
$$;

create table if not exists public.recidivism_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  entry_type public.recidivism_entry_type not null,
  reference_number text not null check (length(trim(reference_number)) between 1 and 80),
  receipt_date date,
  note text check (note is null or length(note) <= 500),
  interval_override_days integer check (interval_override_days is null or interval_override_days between 1 and 365),
  next_check_date date,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.profiles(id),
  created_by_name text not null,
  last_checked_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  closed_by_name text,
  check (
    (entry_type = 'receipt' and receipt_date is not null)
    or (entry_type = 'application' and receipt_date is null)
  ),
  check (
    (closed_at is null and closed_by is null and closed_by_name is null and next_check_date is not null)
    or (closed_at is not null and closed_by is not null and closed_by_name is not null and next_check_date is null)
  )
);

create unique index if not exists recidivism_entries_active_number
on public.recidivism_entries (store_id, entry_type, lower(trim(reference_number)))
where closed_at is null;

create index if not exists recidivism_entries_store_due
on public.recidivism_entries (store_id, next_check_date)
where closed_at is null;

create table if not exists public.recidivism_checks (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.recidivism_entries(id) on delete cascade,
  checked_at timestamptz not null default now(),
  checked_by uuid not null references public.profiles(id),
  checked_by_name text not null,
  period_from date not null,
  period_to date not null,
  interval_days integer not null check (interval_days between 1 and 365),
  gap_days integer not null default 0 check (gap_days >= 0),
  check (period_from <= period_to)
);

create index if not exists recidivism_checks_entry_checked
on public.recidivism_checks (entry_id, checked_at desc);

create table if not exists public.recidivism_reminder_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  reminder_date date not null,
  primary key (user_id, reminder_date)
);

alter table public.recidivism_entries enable row level security;
alter table public.recidivism_checks enable row level security;
alter table public.recidivism_reminder_views enable row level security;

drop policy if exists recidivism_entries_member_read on public.recidivism_entries;
create policy recidivism_entries_member_read on public.recidivism_entries
for select to authenticated using (is_approved_member(store_id));

drop policy if exists recidivism_checks_member_read on public.recidivism_checks;
create policy recidivism_checks_member_read on public.recidivism_checks
for select to authenticated using (
  exists (
    select 1 from public.recidivism_entries entry
    where entry.id = entry_id and is_approved_member(entry.store_id)
  )
);

drop policy if exists recidivism_reminders_self on public.recidivism_reminder_views;
create policy recidivism_reminders_self on public.recidivism_reminder_views
for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.validate_store_recidivism_settings()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.recidivism_default_interval_days is null
     or new.recidivism_default_interval_days not between 1 and 365
     or new.recidivism_default_interval_days > new.retention_days then
    raise exception 'Domyslny okres Recydywy musi miescic sie w retencji sklepu';
  end if;
  if tg_op = 'UPDATE' and new.retention_days < old.retention_days and exists (
    select 1 from recidivism_entries
    where store_id = new.id and closed_at is null
      and interval_override_days is not null
      and interval_override_days > new.retention_days
  ) then
    raise exception 'Najpierw skroc okres przypomnien w aktywnych wpisach Recydywy';
  end if;
  return new;
end;
$$;

drop trigger if exists stores_validate_recidivism_settings on public.stores;
create trigger stores_validate_recidivism_settings
before insert or update of retention_days, recidivism_default_interval_days on public.stores
for each row execute function public.validate_store_recidivism_settings();

create or replace function public.recalculate_store_recidivism_schedule()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.recidivism_default_interval_days is distinct from old.recidivism_default_interval_days then
    update recidivism_entries
    set next_check_date = (
      coalesce(
        timezone('Europe/Warsaw', last_checked_at)::date,
        timezone('Europe/Warsaw', created_at)::date
      ) + new.recidivism_default_interval_days
    )
    where store_id = new.id and closed_at is null and interval_override_days is null;
  end if;
  return new;
end;
$$;

drop trigger if exists stores_recalculate_recidivism_schedule on public.stores;
create trigger stores_recalculate_recidivism_schedule
after update of recidivism_default_interval_days on public.stores
for each row execute function public.recalculate_store_recidivism_schedule();

create or replace function public.add_suspicious_transactions(target_entries jsonb)
returns uuid[] language plpgsql security definer set search_path = public
as $$
declare
  item jsonb;
  inserted_ids uuid[] := '{}';
  inserted_id uuid;
begin
  if jsonb_typeof(target_entries) <> 'array' or jsonb_array_length(target_entries) not between 1 and 100 then
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

create or replace function public.add_recidivism_entries(target_entries jsonb)
returns uuid[] language plpgsql security definer set search_path = public
as $$
declare
  item jsonb;
  target_store uuid;
  target_type public.recidivism_entry_type;
  target_number text;
  target_receipt_date date;
  target_note text;
  target_override integer;
  retention integer;
  default_interval integer;
  effective_interval integer;
  author_name text;
  today_warsaw date := timezone('Europe/Warsaw', now())::date;
  inserted_ids uuid[] := '{}';
  inserted_id uuid;
begin
  if jsonb_typeof(target_entries) <> 'array' or jsonb_array_length(target_entries) not between 1 and 100 then
    raise exception 'Podaj od 1 do 100 wpisow Recydywy';
  end if;
  select coalesce(nullif(trim(display_name), ''), email) into author_name
  from profiles where id = auth.uid();
  if author_name is null then raise exception 'Nie znaleziono profilu'; end if;

  for item in select value from jsonb_array_elements(target_entries)
  loop
    target_store := (item->>'store_id')::uuid;
    target_type := (item->>'entry_type')::public.recidivism_entry_type;
    target_number := trim(coalesce(item->>'reference_number', ''));
    target_receipt_date := nullif(item->>'receipt_date', '')::date;
    target_note := nullif(trim(coalesce(item->>'note', '')), '');
    target_override := nullif(item->>'interval_override_days', '')::integer;

    if not is_approved_member(target_store) then raise exception 'Brak uprawnien do sklepu'; end if;
    select retention_days, recidivism_default_interval_days into retention, default_interval
    from stores where id = target_store;
    if retention is null then raise exception 'Nie znaleziono sklepu'; end if;
    effective_interval := coalesce(target_override, default_interval);
    if length(target_number) not between 1 and 80 then raise exception 'Podaj prawidlowy numer'; end if;
    if target_note is not null and length(target_note) > 500 then raise exception 'Notatka jest za dluga'; end if;
    if effective_interval not between 1 and retention then raise exception 'Okres przypomnien przekracza retencje sklepu'; end if;
    if target_type = 'receipt' and (target_receipt_date is null or target_receipt_date > today_warsaw) then
      raise exception 'Data paragonu nie moze byc przyszla';
    end if;
    if target_type = 'application' then target_receipt_date := null; end if;
    if exists (
      select 1 from recidivism_entries
      where store_id = target_store and entry_type = target_type and closed_at is null
        and lower(trim(reference_number)) = lower(target_number)
    ) then raise exception 'Taki aktywny numer juz istnieje'; end if;

    insert into recidivism_entries (
      store_id, entry_type, reference_number, receipt_date, note, interval_override_days,
      next_check_date, created_by, created_by_name
    ) values (
      target_store, target_type, target_number, target_receipt_date, target_note, target_override,
      today_warsaw + effective_interval, auth.uid(), author_name
    ) returning id into inserted_id;
    inserted_ids := array_append(inserted_ids, inserted_id);
  end loop;
  return inserted_ids;
end;
$$;

create or replace function public.update_recidivism_entry(
  target_id uuid,
  target_type public.recidivism_entry_type,
  target_number text,
  target_receipt_date date,
  target_note text,
  target_interval_override_days integer
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  entry_row recidivism_entries%rowtype;
  retention integer;
  default_interval integer;
  effective_interval integer;
  baseline_date date;
  today_warsaw date := timezone('Europe/Warsaw', now())::date;
begin
  select * into entry_row from recidivism_entries where id = target_id and closed_at is null for update;
  if entry_row.id is null or not is_approved_member(entry_row.store_id) then
    raise exception 'Brak uprawnien lub monitoring zostal zakonczony';
  end if;
  select retention_days, recidivism_default_interval_days into retention, default_interval
  from stores where id = entry_row.store_id;
  effective_interval := coalesce(target_interval_override_days, default_interval);
  if length(trim(coalesce(target_number, ''))) not between 1 and 80 then raise exception 'Podaj prawidlowy numer'; end if;
  if target_note is not null and length(target_note) > 500 then raise exception 'Notatka jest za dluga'; end if;
  if effective_interval not between 1 and retention then raise exception 'Okres przypomnien przekracza retencje sklepu'; end if;
  if target_type = 'receipt' and (target_receipt_date is null or target_receipt_date > today_warsaw) then
    raise exception 'Data paragonu nie moze byc przyszla';
  end if;
  if target_type = 'application' then target_receipt_date := null; end if;
  if exists (
    select 1 from recidivism_entries
    where id <> target_id and store_id = entry_row.store_id and entry_type = target_type and closed_at is null
      and lower(trim(reference_number)) = lower(trim(target_number))
  ) then raise exception 'Taki aktywny numer juz istnieje'; end if;
  baseline_date := coalesce(
    timezone('Europe/Warsaw', entry_row.last_checked_at)::date,
    timezone('Europe/Warsaw', entry_row.created_at)::date
  );
  update recidivism_entries
  set entry_type = target_type,
      reference_number = trim(target_number),
      receipt_date = target_receipt_date,
      note = nullif(trim(coalesce(target_note, '')), ''),
      interval_override_days = target_interval_override_days,
      next_check_date = baseline_date + effective_interval
  where id = target_id;
end;
$$;

create or replace function public.check_recidivism_entry(target_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  entry_row recidivism_entries%rowtype;
  retention integer;
  default_interval integer;
  effective_interval integer;
  checker_name text;
  today_warsaw date := timezone('Europe/Warsaw', now())::date;
  intended_from date;
  available_from date;
  verified_from date;
  missed integer;
  next_due date;
begin
  select * into entry_row from recidivism_entries where id = target_id and closed_at is null for update;
  if entry_row.id is null or not is_approved_member(entry_row.store_id) then
    raise exception 'Brak uprawnien lub monitoring zostal zakonczony';
  end if;
  if entry_row.next_check_date > today_warsaw then raise exception 'Termin kontroli jeszcze nie nadszedl'; end if;
  select retention_days, recidivism_default_interval_days into retention, default_interval
  from stores where id = entry_row.store_id;
  effective_interval := coalesce(entry_row.interval_override_days, default_interval);
  intended_from := coalesce(
    timezone('Europe/Warsaw', entry_row.last_checked_at)::date,
    timezone('Europe/Warsaw', entry_row.created_at)::date
  ) + 1;
  available_from := today_warsaw - retention + 1;
  verified_from := greatest(intended_from, available_from);
  missed := greatest(0, available_from - intended_from);
  next_due := today_warsaw + effective_interval;
  select coalesce(nullif(trim(display_name), ''), email) into checker_name from profiles where id = auth.uid();

  insert into recidivism_checks (
    entry_id, checked_by, checked_by_name, period_from, period_to, interval_days, gap_days
  ) values (
    target_id, auth.uid(), checker_name, verified_from, today_warsaw, effective_interval, missed
  );
  update recidivism_entries
  set last_checked_at = now(), next_check_date = next_due
  where id = target_id;
  return jsonb_build_object(
    'period_from', verified_from,
    'period_to', today_warsaw,
    'gap_days', missed,
    'next_check_date', next_due
  );
end;
$$;

create or replace function public.close_recidivism_entry(target_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  target_store uuid;
  closer_name text;
begin
  select store_id into target_store from recidivism_entries where id = target_id and closed_at is null for update;
  if target_store is null or not is_approved_member(target_store) then
    raise exception 'Brak uprawnien lub monitoring zostal zakonczony';
  end if;
  select coalesce(nullif(trim(display_name), ''), email) into closer_name from profiles where id = auth.uid();
  update recidivism_entries
  set closed_at = now(), closed_by = auth.uid(), closed_by_name = closer_name, next_check_date = null
  where id = target_id;
end;
$$;

create or replace function public.delete_recidivism_entry(target_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Tylko administrator moze trwale usuwac wpisy Recydywy'; end if;
  if not exists (select 1 from recidivism_entries where id = target_id) then raise exception 'Nie znaleziono wpisu'; end if;
  delete from recidivism_entries where id = target_id;
end;
$$;

create or replace function public.update_store_settings(
  target_store uuid,
  target_name text,
  target_retention_days integer,
  target_recidivism_default_interval_days integer
)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Brak uprawnien'; end if;
  if length(trim(coalesce(target_name, ''))) not between 1 and 80 then raise exception 'Podaj prawidlowa nazwe sklepu'; end if;
  if target_retention_days not between 1 and 365 then raise exception 'Retencja musi wynosic od 1 do 365 dni'; end if;
  if target_recidivism_default_interval_days not between 1 and target_retention_days then
    raise exception 'Domyslny okres Recydywy musi miescic sie w retencji sklepu';
  end if;
  update stores
  set name = trim(target_name),
      retention_days = target_retention_days,
      recidivism_default_interval_days = target_recidivism_default_interval_days
  where id = target_store;
  if not found then raise exception 'Nie znaleziono sklepu'; end if;
end;
$$;

revoke all on function public.add_suspicious_transactions(jsonb) from public, anon;
revoke all on function public.add_recidivism_entries(jsonb) from public, anon;
revoke all on function public.update_recidivism_entry(uuid, public.recidivism_entry_type, text, date, text, integer) from public, anon;
revoke all on function public.check_recidivism_entry(uuid) from public, anon;
revoke all on function public.close_recidivism_entry(uuid) from public, anon;
revoke all on function public.delete_recidivism_entry(uuid) from public, anon;
revoke all on function public.update_store_settings(uuid, text, integer, integer) from public, anon;

grant execute on function public.add_suspicious_transactions(jsonb) to authenticated;
grant execute on function public.add_recidivism_entries(jsonb) to authenticated;
grant execute on function public.update_recidivism_entry(uuid, public.recidivism_entry_type, text, date, text, integer) to authenticated;
grant execute on function public.check_recidivism_entry(uuid) to authenticated;
grant execute on function public.close_recidivism_entry(uuid) to authenticated;
grant execute on function public.delete_recidivism_entry(uuid) to authenticated;
grant execute on function public.update_store_settings(uuid, text, integer, integer) to authenticated;
