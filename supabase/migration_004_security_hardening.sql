-- Remove direct answer-key access. The backend uses the service-role client and
-- exposes only answer fields through its authenticated API route.
alter table video_questions enable row level security;
drop policy if exists "Anyone can view questions for active videos" on video_questions;

create or replace function create_redemption(
  p_user_id uuid,
  p_points integer,
  p_reward_type text,
  p_destination text
) returns uuid as $$
declare
  v_id uuid;
  v_balance integer;
begin
  if p_points < 5000 then
    raise exception 'Redemption must be at least 5000 whole points';
  end if;
  if p_reward_type not in ('cash', 'airtime', 'data_bundle') then
    raise exception 'Invalid reward type';
  end if;
  if p_destination is null or length(trim(p_destination)) = 0 or length(p_destination) > 200 then
    raise exception 'Invalid redemption destination';
  end if;

  select points_balance into v_balance from profiles where id = p_user_id for update;
  if v_balance is null then
    raise exception 'Profile not found';
  end if;
  if v_balance < p_points then
    raise exception 'Insufficient points';
  end if;

  insert into redemption_requests (user_id, points_spent, reward_type, destination)
    values (p_user_id, p_points, p_reward_type, trim(p_destination))
    returning id into v_id;

  update profiles set points_balance = points_balance - p_points where id = p_user_id;
  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, -p_points, 'redemption', v_id);
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function resolve_redemption(
  p_id uuid,
  p_status text
) returns void as $$
declare
  v_redemption record;
begin
  if p_status not in ('fulfilled', 'rejected') then
    raise exception 'status must be fulfilled or rejected';
  end if;

  select * into v_redemption
    from redemption_requests
    where id = p_id and status = 'pending'
    for update;
  if not found then
    raise exception 'Pending redemption not found';
  end if;

  update redemption_requests set status = p_status, resolved_at = now() where id = p_id;
  if p_status = 'rejected' then
    update profiles set points_balance = points_balance + v_redemption.points_spent
      where id = v_redemption.user_id;
    insert into points_ledger (user_id, points, reason, reference_id)
      values (v_redemption.user_id, v_redemption.points_spent, 'admin_adjustment', p_id);
  end if;
end;
$$ language plpgsql security definer set search_path = public;