-- Trzecia opcja weryfikacji archiwalnego spisu: zweryfikowany okres czasu (od–do),
-- żeby następna zmiana / kolejna osoba wiedziała, w jakim przedziale produkt był już sprawdzony.

alter table public.inventory_items add column if not exists verified_from text;
alter table public.inventory_items add column if not exists verified_to text;

create or replace function public.set_inventory_item_verified_period(target_item uuid, from_value text, to_value text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from inventory_items ii join inventories i on i.id = ii.inventory_id
    where ii.id = target_item and ii.deleted_at is null and i.status = 'archived' and is_approved_member(i.store_id)
  ) then raise exception 'Brak uprawnien lub spis nie jest w archiwum'; end if;
  perform set_config('app.allow_inventory_flag', 'true', true);
  update inventory_items set verified_from = nullif(from_value, ''), verified_to = nullif(to_value, ''), updated_at = now() where id = target_item;
end;
$$;

revoke all on function public.set_inventory_item_verified_period(uuid, text, text) from public, anon;
grant execute on function public.set_inventory_item_verified_period(uuid, text, text) to authenticated;
