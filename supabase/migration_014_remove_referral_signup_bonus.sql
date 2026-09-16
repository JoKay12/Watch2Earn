-- watch2earn — migration 014: remove per-signup referral point bonus
--
-- Referrals no longer earn the referrer any points at all — not the old
-- 100-point milestone bonus (already removed in migration_013) and now
-- not this 10-point per-signup bonus either. Referring still matters: it's
-- what counts toward the 5-referral threshold that expands the daily
-- video pool and watch limit (see migration_013's get_daily_videos and
-- routes/session.js's /session/start). So this keeps the part that marks
-- a referral 'rewarded' once the referee earns their first reward — that
-- status change is what the threshold count reads — and only removes the
-- actual point-crediting that used to go with it.
--
-- Safe to re-run.

create or replace function complete_video_watch(
  p_session_id uuid,
  p_user_id uuid
) returns json as $$
declare
  v_session record;
  v_video record;
  v_referral record;
  v_rewarded_count integer := 0;
begin
  select * into v_session from watch_sessions
    where id = p_session_id and user_id = p_user_id and status = 'in_progress'
    for update;
  if not found then
    -- Already credited (a duplicate heartbeat near the threshold, or the
    -- quiz was already reached) — not an error, just nothing new to do.
    return json_build_object('alreadyCredited', true, 'pointsEarned', 0);
  end if;

  select * into v_video from videos where id = v_session.video_id;

  update watch_sessions
    set status = 'quiz_pending', reward_date = current_date
    where id = p_session_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, v_video.points_reward, 'video_watch', p_session_id);
  update profiles set points_balance = points_balance + v_video.points_reward where id = p_user_id;

  -- Marks the referral 'rewarded' the first time the referee earns any
  -- reward — no points change hands for this anymore, it purely feeds the
  -- referrer's threshold count for the expanded daily pool/watch limit.
  select count(*) into v_rewarded_count
    from watch_sessions where user_id = p_user_id and status in ('quiz_pending', 'completed');
  if v_rewarded_count = 1 then
    select * into v_referral from referrals
      where referee_id = p_user_id and status = 'pending'
      order by created_at limit 1 for update;
    if found then
      update referrals set status = 'rewarded' where id = v_referral.id and status = 'pending';
    end if;
  end if;

  return json_build_object(
    'alreadyCredited', false,
    'pointsEarned', v_video.points_reward
  );
end;
$$ language plpgsql security definer set search_path = public;
