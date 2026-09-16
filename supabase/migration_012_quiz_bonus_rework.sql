-- watch2earn — migration 012: quiz bonus rework
--
-- Old model: the video's base reward AND quiz bonus were both withheld
-- until the user answered all 3 quiz questions correctly. Get one wrong,
-- get nothing, must retry.
--
-- New model (per product decision): finishing the video always earns its
-- base reward, credited the moment the watch-completion threshold is
-- reached — the quiz no longer gates it at all. The quiz becomes a pure
-- bonus layer on top: each correct answer earns quiz_bonus_points, so
-- 1/3 correct = base reward + 1x bonus, 3/3 = base reward + 3x bonus,
-- 0/3 = base reward + 0 bonus (never negative, never withheld).
--
-- Safe to re-run.

-- New: credits the base video reward at watch-completion time (called from
-- the heartbeat route the moment it detects the video is finished), instead
-- of deferring it to quiz submission. Guarded to run at most once per
-- session via the `status = 'in_progress'` condition in the UPDATE.
create or replace function complete_video_watch(
  p_session_id uuid,
  p_user_id uuid
) returns json as $$
declare
  v_session record;
  v_video record;
  v_referral record;
  v_rewarded_count integer := 0;
  v_referral_bonus integer := 0;
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

  -- Legacy fallback: a referral earns its referrer 10 points the first time
  -- the referee earns a reward at all — this used to check for the user's
  -- first *completed* (quiz-passed) session; now it checks their first
  -- *rewarded* session, matching the new earlier reward-eligibility moment.
  select count(*) into v_rewarded_count
    from watch_sessions where user_id = p_user_id and status in ('quiz_pending', 'completed');
  if v_rewarded_count = 1 then
    select * into v_referral from referrals
      where referee_id = p_user_id and status = 'pending'
      order by created_at limit 1 for update;
    if found then
      update referrals set status = 'rewarded' where id = v_referral.id and status = 'pending';
      if found then
        v_referral_bonus := 10;
        insert into points_ledger (user_id, points, reason, reference_id)
          values (v_referral.referrer_id, 10, 'referral', v_referral.id);
        update profiles set points_balance = points_balance + 10 where id = v_referral.referrer_id;
      end if;
    end if;
  end if;

  return json_build_object(
    'alreadyCredited', false,
    'pointsEarned', v_video.points_reward
  );
end;
$$ language plpgsql security definer set search_path = public;

-- Replaces submit_quiz: no longer grants or withholds the base video
-- reward (already credited by complete_video_watch above) and no longer
-- requires a perfect score — it just grades whatever was answered and
-- credits quiz_bonus_points once per correct answer.
create or replace function submit_quiz(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb
) returns json as $$
declare
  v_session record;
  v_video record;
  v_question record;
  v_total integer := 0;
  v_correct integer := 0;
  v_bonus integer := 0;
  v_selected integer;
begin
  select * into v_session from watch_sessions
    where id = p_session_id and user_id = p_user_id and status = 'quiz_pending'
    for update;
  if not found then raise exception 'Session not eligible for quiz submission'; end if;

  select * into v_video from videos where id = v_session.video_id;
  select count(*)::integer into v_total from video_questions where video_id = v_session.video_id;
  if v_total <> 3 then raise exception 'This video does not have a complete quiz configured'; end if;

  for v_question in select * from video_questions where video_id = v_session.video_id order by position loop
    select (item->>'selected_index')::integer into v_selected
      from jsonb_array_elements(p_answers) item
      where (item->>'question_id')::uuid = v_question.id
      limit 1;
    if v_selected is not null and v_selected >= 0 and v_selected < jsonb_array_length(v_question.options)
      and v_selected = v_question.correct_index then
      v_correct := v_correct + 1;
    end if;
  end loop;

  v_bonus := coalesce(v_video.quiz_bonus_points, 5) * v_correct;

  update watch_sessions
    set status = 'completed', completed_at = now(),
        quiz_correct_count = v_correct, quiz_total = v_total
    where id = p_session_id;

  if v_bonus > 0 then
    insert into points_ledger (user_id, points, reason, reference_id)
      values (p_user_id, v_bonus, 'quiz_bonus', p_session_id);
    update profiles set points_balance = points_balance + v_bonus where id = p_user_id;
  end if;

  return json_build_object(
    'correct', v_correct,
    'total', v_total,
    'pointsEarned', v_bonus,
    'quizBonusPoints', v_bonus
  );
end;
$$ language plpgsql security definer set search_path = public;
