do $$
begin
  if not exists (select 1 from pg_type where typname = 'suspicious_transaction_type') then
    create type public.suspicious_transaction_type as enum ('receipt', 'application');
  end if;
end;
$$;

create table if not exists public.suspicious_transactions (
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
  check ((entry_type = 'receipt' and receipt_date is not null) or (entry_type = 'application' and receipt_date is null)),
  check (
    (checked_at is null and checked_by is null and checked_by_name is null)
    or (checked_at is not null and checked_by is not null and checked_by_name is not null)
  )
);

create unique index if not exists suspicious_transactions_pending_number
on public.suspicious_transactions (store_id, entry_type, lower(trim(reference_number)))
where checked_at is null;

create index if not exists suspicious_transactions_store_created
on public.suspicious_transactions (store_id, created_at desc);

create table if not exists public.transaction_reminder_views (
  user_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  reminder_date date not null,
  primary key (user_id, store_id, reminder_date)
);

alter table public.suspicious_transactions enable row level security;
alter table public.transaction_reminder_views enable row level security;

drop policy if exists suspicious_transactions_member_read on public.suspicious_transactions;
create policy suspicious_transactions_member_read on public.suspicious_transactions
for select to authenticated using (is_approved_member(store_id));
drop policy if exists transaction_reminders_self on public.transaction_reminder_views;
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
  update suspicious_transactions set checked_at = now(), checked_by = auth.uid(), checked_by_name = checker_name where id = target_id;
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
