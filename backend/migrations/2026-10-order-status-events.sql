-- Real timestamps for manual order tracking (bulk "Packed"/"Shipped" uploads and the
-- Orders-list dropdown). Already applied to the live Supabase project; kept here so a
-- fresh database can be rebuilt. Additive only - no existing table is changed.
create table if not exists public.order_status_events (
  id bigserial primary key,
  order_id text not null references public.orders(id) on delete cascade,
  status text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);
create index if not exists order_status_events_order_idx on public.order_status_events (order_id, created_at);
alter table public.order_status_events enable row level security;
