-- Supabase's security check flagged three tables that were readable/writable through the public API key.
-- email_otps holds sign-in code hashes; upcoming_saree_notify_requests holds customers' e-mail addresses.
-- The store's own server uses the service_role key, which bypasses row level security, so nothing in the app changes;
-- with RLS on and no policies, the public (anon) key can no longer touch these tables.
alter table public.email_otps enable row level security;
alter table public.upcoming_sarees enable row level security;
alter table public.upcoming_saree_notify_requests enable row level security;
