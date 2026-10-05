-- "Please review your saree" e-mail: remembers that an order's reminder was already sent (so it is sent once).
-- Already applied to the live Supabase project; kept here so a fresh database can be rebuilt. Additive only.
alter table public.orders add column if not exists review_reminder_sent_at timestamptz;
