-- Customer review photos (taken with the camera on the review form). A list of photo URLs per review.
-- Already applied to the live Supabase project; kept here so a fresh database can be rebuilt. Additive only.
alter table public.reviews add column if not exists photos jsonb not null default '[]'::jsonb;
