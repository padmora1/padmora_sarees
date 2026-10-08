-- Per-item returns. A return request can now be acted on for only some of its sarees: the chosen sarees are split off into their own
-- request ("part" 2, 3, ...) that carries on through Approved -> Received -> Refunded by itself, while the rest stay in the original
-- request, untouched and still visible. Every request is therefore always one uniform status, so revenue, profit, locks, counts and the
-- refund idempotency key keep working exactly as before.
alter table public.return_requests add column if not exists part integer not null default 1;

alter table public.return_requests drop constraint if exists return_requests_order_attempt_key;
alter table public.return_requests add constraint return_requests_order_attempt_part_key unique (order_id, attempt, part);

-- Moves the given order items out of a request into a new part of the same order + attempt. Returns the new request's id.
-- p_part_refund / p_rest_refund are the suggested refund amounts for the new part and for what is left behind. p_expected_status makes
-- sure the request is still in the state the admin saw (another admin may have acted on it a moment ago).
create or replace function public.split_return_request(p_return_id integer, p_order_item_ids integer[], p_part_refund integer, p_rest_refund integer, p_expected_status text)
returns integer
language plpgsql
as $$
declare
  src public.return_requests%rowtype;
  v_new integer;
  v_part integer;
  v_moving integer;
  v_total integer;
begin
  select * into src from public.return_requests where id = p_return_id for update;
  if not found then raise exception 'Return not found'; end if;
  if p_expected_status is not null and src.status <> p_expected_status then raise exception 'This request has already been updated'; end if;

  select count(*) into v_total from public.return_request_items where return_id = p_return_id;
  select count(*) into v_moving from public.return_request_items where return_id = p_return_id and order_item_id = any(p_order_item_ids);
  if v_moving = 0 then raise exception 'None of those items are in this return'; end if;
  if v_moving >= v_total then return p_return_id; end if;   -- everything is chosen: nothing to split

  select coalesce(max(part), 0) + 1 into v_part from public.return_requests where order_id = src.order_id and attempt = src.attempt;

  insert into public.return_requests (order_id, user_id, reason, reason_category, reason_detail, status, refund_method, refund_account_detail,
    computed_refund_amount, restock, admin_note, coupon_code, requested_at, decided_at, received_at, attempt, part)
  values (src.order_id, src.user_id, src.reason, src.reason_category, src.reason_detail, src.status, src.refund_method, src.refund_account_detail,
    p_part_refund, src.restock, src.admin_note, src.coupon_code, src.requested_at, src.decided_at, src.received_at, src.attempt, v_part)
  returning id into v_new;

  update public.return_request_items set return_id = v_new where return_id = p_return_id and order_item_id = any(p_order_item_ids);
  insert into public.return_request_photos (return_id, url, uploaded_at) select v_new, url, uploaded_at from public.return_request_photos where return_id = p_return_id;
  update public.return_requests set computed_refund_amount = p_rest_refund where id = p_return_id;
  return v_new;
end;
$$;
