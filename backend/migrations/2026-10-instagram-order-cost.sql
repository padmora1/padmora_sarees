-- Instagram orders can carry the saree's cost: the sheet's optional "Buying Price" becomes the Final CP (buying + shipping + GST from
-- Settings) saved on the order line, so those orders count in Net Profit. Same function as before plus one optional key (unit_cost).

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

    insert into order_items (order_id, product_id, name, color, qty, price, variant_id, product_code, unit_cost)
    values (v_id, null, r->>'product_name', null, 1, v_price, null, r->>'product_code', nullif(r->>'unit_cost', '')::numeric);

    v_out := v_out || jsonb_build_object('id', v_id, 'idx', (r->>'idx')::integer);
  end loop;

  return v_out;
end;
$$;
