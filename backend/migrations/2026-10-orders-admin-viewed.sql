-- Admin Orders list: an order is shown in bold until an admin has opened it. This remembers when that first happened.
-- Already applied to the live Supabase project; kept here so a fresh database can be rebuilt. Additive only.
-- Orders that existed when this was applied count as already seen.
alter table public.orders add column if not exists admin_viewed_at timestamptz;
update public.orders set admin_viewed_at = now() where admin_viewed_at is null;
