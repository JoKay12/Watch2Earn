-- Curated videos shown on the public landing page.
-- Run after migration_007_signup_referral_reward.sql.

alter table videos add column if not exists featured boolean not null default false;

create index if not exists videos_public_featured_idx
  on videos (featured, published_at desc)
  where active = true;
