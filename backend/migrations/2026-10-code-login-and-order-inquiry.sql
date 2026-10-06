-- Sign-in / sign-up with an e-mailed code, and a second (last) chance on an order inquiry.
-- Apply once to the Supabase project; safe to run again (every step checks first).

-- 1. The one-time-code table may now also hold sign-in and sign-up codes.
alter table public.email_otps drop constraint if exists email_otps_purpose_check;
alter table public.email_otps add constraint email_otps_purpose_check
  check (purpose in ('password_reset', 'claim_account', 'login', 'register'));

-- 2. An order can have up to two inquiries (a rejected one gets one more try). Each is its own row, numbered 1 and 2.
alter table public.return_requests add column if not exists attempt integer not null default 1;
alter table public.return_requests drop constraint if exists return_requests_order_id_key;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'return_requests_order_attempt_key') then
    alter table public.return_requests add constraint return_requests_order_attempt_key unique (order_id, attempt);
  end if;
end $$;

-- 3. The function that creates a request now takes the attempt number (defaults to 1, so older callers keep working).
drop function if exists public.create_return_request(text, text, text, text, text, text, text, integer, jsonb, jsonb);
create or replace function public.create_return_request(
  p_order_id text, p_user_id text, p_reason text, p_reason_category text, p_reason_detail text, p_refund_method text,
  p_refund_account_detail text, p_computed_refund_amount integer, p_items jsonb, p_photo_urls jsonb, p_attempt integer default 1
) returns integer
language plpgsql
as $function$
declare v_return_id integer; item jsonb; url text;
begin
  insert into return_requests (order_id, user_id, reason, reason_category, reason_detail, status, refund_method, refund_account_detail, computed_refund_amount, requested_at, attempt)
  values (p_order_id, p_user_id, p_reason, p_reason_category, p_reason_detail, 'Requested', p_refund_method, p_refund_account_detail, p_computed_refund_amount, now(), coalesce(p_attempt, 1))
  returning id into v_return_id;

  for item in select * from jsonb_array_elements(p_items) loop
    insert into return_request_items (return_id, order_item_id, qty)
    values (v_return_id, (item->>'orderItemId')::integer, (item->>'qty')::integer);
  end loop;

  if p_photo_urls is not null then
    for url in select * from jsonb_array_elements_text(p_photo_urls) loop
      insert into return_request_photos (return_id, url, uploaded_at) values (v_return_id, url, now());
    end loop;
  end if;

  return v_return_id;
end;
$function$;
