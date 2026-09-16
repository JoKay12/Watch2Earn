-- watch2earn — migration 016: reward system redesign
--
-- Per the updated reward system document:
--
-- 1. Every video now gives a flat 100 points for watching, replacing the
--    old per-video admin-configurable amount. (Existing videos updated;
--    the field stays admin-editable going forward in case a specific
--    video ever needs to differ, same pattern as the quiz-bonus default.)
--
-- 2. Reward tiers are now flat and uniform: 100 points = 5 GHS, applied
--    identically to Airtime, Data, AND Cash. This replaces the old
--    non-linear data-bundle-by-megabyte pricing — data bundles are now
--    also a GHS-equivalent value, matching the document's table (which
--    lists "100 GH", "150 GH" etc. for the Data column, not megabytes).
--    Tiers run 2000–10000 points / 100–500 GHS.
--
-- 3. The old cash-specific "5000+ points to unlock cash" rule is removed
--    — there's now a single uniform 2000-point minimum for all three
--    reward types, matching the tier table's own floor.
--
-- 4. One redemption request per calendar day, across any reward type —
--    a deliberate simplicity choice (confirmed with the product owner)
--    given points are still deducted immediately at request time, not at
--    admin approval, so this is what keeps a single day's requests bounded
--    rather than needing a more complex "reserved but uncommitted" balance
--    system.
--
-- Safe to re-run. The reward_tiers reseed (delete-then-insert) means
-- re-running this after an admin has customized the new tiers will
-- overwrite those customizations back to the values below — that's
-- intentional for this migration specifically, not a general pattern to
-- rely on.

update videos set points_reward = 100;
alter table videos alter column points_reward set default 100;

-- data_mb -> data_ghs: data bundles are now priced the same way as
-- airtime/cash (a GHS-equivalent value), not a specific megabyte amount.
-- Guarded so re-running this migration doesn't fail on the second pass,
-- once data_mb no longer exists to rename.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'reward_tiers' and column_name = 'data_mb') then
    alter table reward_tiers rename column data_mb to data_ghs;
  end if;
end $$;

delete from reward_tiers;
insert into reward_tiers (points_required, airtime_ghs, data_ghs, cash_ghs)
values
  (2000,  100.00, 100.00, 100.00),
  (3000,  150.00, 150.00, 150.00),
  (4000,  200.00, 200.00, 200.00),
  (5000,  250.00, 250.00, 250.00),
  (6000,  300.00, 300.00, 300.00),
  (7000,  350.00, 350.00, 350.00),
  (8000,  400.00, 400.00, 400.00),
  (9000,  450.00, 450.00, 450.00),
  (10000, 500.00, 500.00, 500.00);

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
  v_requested_today integer;
begin
  if p_reward_type not in ('cash', 'airtime', 'data_bundle') then
    raise exception 'Invalid reward type';
  end if;
  if p_destination is null or length(trim(p_destination)) = 0 or length(p_destination) > 200 then
    raise exception 'Invalid redemption destination';
  end if;

  select count(*) into v_requested_today from redemption_requests
    where user_id = p_user_id and created_at >= (now() - interval '24 hours');
  if v_requested_today > 0 then
    raise exception 'Only one redemption request is allowed per day';
  end if;

  select * into v_tier from reward_tiers where points_required = p_points_required and active = true;
  if not found then
    raise exception 'Not a valid reward tier';
  end if;

  v_amount := case p_reward_type
    when 'airtime' then v_tier.airtime_ghs
    when 'cash' then v_tier.cash_ghs
    when 'data_bundle' then v_tier.data_ghs
  end;
  if v_amount is null then
    raise exception 'This reward type is not available at this tier';
  end if;

  select points_balance into v_balance from profiles where profiles.id = p_user_id for update;
  if v_balance < p_points_required then
    raise exception 'Insufficient points';
  end if;

  v_label := v_amount::text || ' GHS ' || (case p_reward_type when 'data_bundle' then 'data' when 'airtime' then 'airtime' else 'cash' end);

  insert into redemption_requests (user_id, points_spent, points_required, reward_type, destination, reward_amount_label)
    values (p_user_id, p_points_required, p_points_required, p_reward_type, p_destination, v_label)
    returning id into v_id;

  update profiles set points_balance = points_balance - p_points_required where profiles.id = p_user_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, -p_points_required, 'redemption', v_id);

  return v_id;
end;
$$ language plpgsql security definer set search_path = public;
