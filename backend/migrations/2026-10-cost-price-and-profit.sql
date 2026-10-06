-- Cost price, final cost and profit tracking.
--
-- product_variants: the buying price the admin typed (cost_price), the Final CP worked out from it with the shipping and GST
-- in Admin -> Settings (final_cp = (buying price + shipping) + GST), and the margin % that was applied. All three are empty
-- for the colours that were priced by hand before this existed - those keep working exactly as before.
-- order_items.unit_cost: a snapshot of the Final CP of the saree at the moment it was ordered, so changing a cost price or
-- the settings later never rewrites the profit of orders that already happened. A trigger fills it for every new order item
-- that is linked to a colour, so the checkout code does not change.
-- Additive only.

alter table product_variants add column if not exists cost_price numeric(12,2);
alter table product_variants add column if not exists final_cp numeric(12,2);
alter table product_variants add column if not exists margin_pct numeric(6,2);
alter table order_items add column if not exists unit_cost numeric(12,2);

create or replace function set_order_item_unit_cost()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.unit_cost is null and new.variant_id is not null then
    select final_cp into new.unit_cost from product_variants where id = new.variant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_unit_cost on order_items;
create trigger order_items_unit_cost before insert on order_items
  for each row execute function set_order_item_unit_cost();
