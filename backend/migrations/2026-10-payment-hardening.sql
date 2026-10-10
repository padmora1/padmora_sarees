-- Payment hardening (before go-live):
--  * pending_checkouts remembers the exact discount and shipping that were priced when the customer paid, who is finalising it (claimed_at),
--    which store order id was reserved for it (order_id) and why it failed (failure_note), so a late confirmation (the customer's browser
--    or Razorpay's webhook) always produces an order for exactly the amount paid - once.
--  * one Razorpay payment / Razorpay order can belong to at most one store order (database-level guarantee).
alter table public.pending_checkouts add column if not exists discount real;
alter table public.pending_checkouts add column if not exists shipping_fee real;
alter table public.pending_checkouts add column if not exists claimed_at timestamptz;
alter table public.pending_checkouts add column if not exists order_id text;
alter table public.pending_checkouts add column if not exists failure_note text;

create unique index if not exists orders_razorpay_payment_id_key on public.orders (razorpay_payment_id) where razorpay_payment_id is not null;
create unique index if not exists orders_razorpay_order_id_key on public.orders (razorpay_order_id) where razorpay_order_id is not null;
