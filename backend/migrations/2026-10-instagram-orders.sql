-- Instagram orders: orders taken over Instagram DMs / the Instagram store for sarees that are not in the product
-- catalogue. The admin uploads a sheet; each row becomes a normal order (so tracking, Order Inquiry, packing slips,
-- bulk status and shipping all work) tagged source = 'instagram' with an id like INS0001, INS0002...
--
-- Additive only: every existing order keeps source = 'website'.

alter table orders add column if not exists source text not null default 'website';
alter table orders add column if not exists import_key text;       -- fingerprint of the sheet row, so uploading the same file twice cannot duplicate orders
alter table orders add column if not exists imported_at timestamptz;
alter table orders add column if not exists imported_by text;
alter table order_items add column if not exists product_code text; -- the code typed in the sheet (these sarees have no catalogue SKU)

create unique index if not exists orders_import_key_key on orders (import_key) where import_key is not null;
create index if not exists orders_source_idx on orders (source);

-- Creates every order of one upload in a single transaction. The advisory lock makes two uploads at the same moment
-- take turns, and the next number is read inside it, so ids are always INS0001, INS0002... with no repeats.
-- p_rows: [{ idx, user_id, name, phone, address, city, state, pincode, payment, price, placed_at, product_name, product_code, import_key }]
create or replace function import_instagram_orders(p_rows jsonb, p_imported_by text)
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
  v_next integer;
  v_id text;
  v_price integer;
  v_out jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(7461001);
  select coalesce(max(substring(id from 4)::integer), 0) into v_next from orders where id ~ '^INS[0-9]{1,8}$';

  for r in select * from jsonb_array_elements(p_rows) loop
    v_next := v_next + 1;
    v_id := 'INS' || lpad(v_next::text, 4, '0');
    v_price := (r->>'price')::integer;

    insert into orders (id, user_id, subtotal, discount, total, coupon_code, address_name, address_line1, address_city, address_state,
                        address_pincode, address_phone, payment, status, placed_at, shipping_fee, tax_amount, source, import_key, imported_at, imported_by)
    values (v_id, r->>'user_id', v_price, 0, v_price, null, r->>'name', r->>'address', coalesce(r->>'city', ''), coalesce(r->>'state', ''),
            coalesce(r->>'pincode', ''), r->>'phone', r->>'payment', 'Confirmed', (r->>'placed_at')::timestamptz, 0, 0, 'instagram', r->>'import_key', now(), p_imported_by);

    insert into order_items (order_id, product_id, name, color, qty, price, variant_id, product_code)
    values (v_id, null, r->>'product_name', null, 1, v_price, null, r->>'product_code');

    v_out := v_out || jsonb_build_object('id', v_id, 'idx', (r->>'idx')::integer);
  end loop;

  return v_out;
end;
$$;
