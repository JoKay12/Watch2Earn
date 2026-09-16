-- watch2earn — migration 011: tiered reward system (airtime, data bundle, cash)
--
-- Replaces the old flat "5000 points minimum, redeem any amount" model with
-- fixed reward tiers matching real payout amounts. Airtime and cash convert
-- at a straight 100 points = 1 GHS, but data bundles follow real telecom
-- bundle pricing, which is NOT linear (larger bundles give proportionally
-- more data per cedi) — so all three are stored as an explicit lookup table
-- rather than computed from a formula.
--
-- Safe to re-run.

create table if not exists reward_tiers (
  id uuid primary key default gen_random_uuid(),
  points_required integer not null unique,
  airtime_ghs numeric(10,2),
  data_mb numeric(10,2),
  cash_ghs numeric(10,2),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table reward_tiers enable row level security;
drop policy if exists "Anyone can view active reward tiers" on reward_tiers;
create policy "Anyone can view active reward tiers" on reward_tiers
  for select using (active = true);

-- Seed the tiers from the reward system document (idempotent — only inserts
-- rows that don't already exist, so re-running this after an admin has
-- edited values won't clobber their changes).
insert into reward_tiers (points_required, airtime_ghs, data_mb, cash_ghs)
values
  (500,   5.00,  521.03, null),
  (1000,  10.00, 837.55, 10.00),
  (2000,  20.00, 1390,   20.00),
  (3000,  30.00, 2080,   30.00),
  (4000,  40.00, 2780,   40.00),
  (5000,  50.00, 3470,   50.00),
  (6000,  60.00, 4170,   60.00),
  (7000,  70.00, 4860,   70.00),
  (8000,  80.00, 5560,   80.00),
  (9000,  90.00, 6250,   90.00),
  (10000, 100.00, 9170,  100.00)
on conflict (points_required) do nothing;

-- Cash specifically requires the user's overall balance to be at least 5000
-- points, even if they're redeeming a smaller cash tier (e.g. the 1000-point
-- cash tier is only usable once their balance has crossed 5000 — it isn't
-- usable standalone at 1000 points the way airtime/data are).
alter table redemption_requests add column if not exists reward_amount_label text;
alter table redemption_requests add column if not exists points_required integer;

-- Replaces create_redemption from the original schema.sql — same function
-- name, new signature (adds p_points_required to validate against a real
-- tier instead of a flat 5000-point minimum), so this needs a drop first.
drop function if exists create_redemption(uuid, integer, text, text);

create function create_redemption(
  p_user_id uuid,
  p_points_required integer,
  p_reward_type text,
  p_destination text
) returns uuid as $$
declare
  v_id uuid;
  v_balance integer;
  v_tier record;
  v_amount numeric;
  v_label text;
begin
  if p_reward_type not in ('cash', 'airtime', 'data_bundle') then
    raise exception 'Invalid reward type';
  end if;
  if p_destination is null or length(trim(p_destination)) = 0 or length(p_destination) > 200 then
    raise exception 'Invalid redemption destination';
  end if;

  select * into v_tier from reward_tiers where points_required = p_points_required and active = true;
  if not found then
    raise exception 'Not a valid reward tier';
  end if;

  v_amount := case p_reward_type
    when 'airtime' then v_tier.airtime_ghs
    when 'cash' then v_tier.cash_ghs
    when 'data_bundle' then v_tier.data_mb
  end;
  if v_amount is null then
    raise exception 'This reward type is not available at this tier';
  end if;

  select points_balance into v_balance from profiles where profiles.id = p_user_id for update;
  if v_balance < p_points_required then
    raise exception 'Insufficient points';
  end if;
  -- Cash has its own unlock threshold independent of which cash tier is
  -- chosen — the user's overall balance must be 5000+, not just the tier cost.
  if p_reward_type = 'cash' and v_balance < 5000 then
    raise exception 'Cash redemption unlocks at 5000 points';
  end if;

  v_label := case p_reward_type
    when 'airtime' then v_amount::text || ' GHS airtime'
    when 'cash' then v_amount::text || ' GHS cash'
    when 'data_bundle' then (case when v_amount >= 1000 then round(v_amount / 1000, 2)::text || ' GB data' else v_amount::text || ' MB data' end)
  end;

  insert into redemption_requests (user_id, points_spent, points_required, reward_type, destination, reward_amount_label)
    values (p_user_id, p_points_required, p_points_required, p_reward_type, p_destination, v_label)
    returning id into v_id;

  update profiles set points_balance = points_balance - p_points_required where profiles.id = p_user_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, -p_points_required, 'redemption', v_id);

  return v_id;
end;
$$ language plpgsql security definer set search_path = public;
