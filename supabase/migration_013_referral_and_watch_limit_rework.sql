-- watch2earn — migration 013: referral/watch-limit rework
--
-- Four related changes, per product decision:
--
-- 1. Referral threshold: 3 -> 5 referrals. Reaching it no longer grants a
--    one-time point bonus — instead it expands the daily video POOL from
--    5 to 8 and raises the daily WATCH limit from 3 to 5.
--
-- 2. Pool vs. watch limit are now two different numbers, not one. The pool
--    (5, or 8 after 5 referrals) is how many videos show up in Explore
--    Videos to choose from. The watch limit (3, or 5 after 5 referrals) is
--    how many of those the user can actually watch-and-earn-from per day
--    — giving real choice within the pool without raising the daily cap.
--
-- 3. Video selection now excludes anything ever assigned to this user on
--    ANY previous day, not just today, so someone who doesn't finish their
--    daily videos sees a genuinely different set tomorrow instead of the
--    same ones (or an overlapping set) reappearing.
--
-- 4. Quiz bonus default drops from 5 to 3 points per correct answer,
--    applied to existing videos too, not just new ones.
--
-- Safe to re-run.

update videos set quiz_bonus_points = 3;
alter table videos alter column quiz_bonus_points set default 3;

drop function if exists get_daily_videos(uuid, date);

create function get_daily_videos(p_user_id uuid, p_access_date date default current_date)
returns table (
  id uuid,
  youtube_video_id text,
  title text,
  duration_seconds integer,
  points_reward integer,
  quiz_bonus_points integer,
  active boolean,
  published_at timestamptz,
  created_at timestamptz,
  access_position integer,
  daily_limit integer,
  daily_watch_limit integer,
  referral_count integer
) as $$
declare
  v_pool_limit integer := 5;
  v_watch_limit integer := 3;
  v_referral_count integer := 0;
  v_playlist_id uuid;
  v_existing_count integer := 0;
begin
  select count(*)::integer into v_referral_count
    from referrals where referrer_id = p_user_id and status = 'rewarded';

  if v_referral_count >= 5 then
    v_pool_limit := 8;
    v_watch_limit := 5;
  end if;

  select playlists.id into v_playlist_id from playlists
    where lower(trim(playlists.title)) like 'let''s discuss%'
    limit 1;
  if v_playlist_id is null then raise exception 'Lets Discuss playlist is not configured'; end if;

  select count(*)::integer into v_existing_count
    from daily_video_access
    where user_id = p_user_id and access_date = p_access_date;

  -- Prefer videos this user has never been assigned before (real variety
  -- day to day). Only if that runs short — a small catalog, or someone
  -- who's been at this a long time — fall back to their least-recently-seen
  -- videos, so the pool degrades gracefully to "oldest first" instead of
  -- ever silently dropping to zero available videos.
  insert into daily_video_access (user_id, access_date, video_id, access_position)
  select p_user_id, p_access_date, selected.id,
      (v_existing_count + row_number() over (order by selected.never_seen desc, selected.sort_key))::integer
  from (
    select
      v.id,
      (not exists (
        select 1 from daily_video_access existing
        where existing.user_id = p_user_id and existing.video_id = v.id
      )) as never_seen,
      coalesce(
        (select max(existing.access_date) from daily_video_access existing
         where existing.user_id = p_user_id and existing.video_id = v.id),
        '0001-01-01'::date
      ) as last_seen,
      md5(v.id::text || ':' || p_user_id::text || ':' || p_access_date::text) as sort_key
    from videos v
    join video_playlists vp on vp.video_id = v.id
    where vp.playlist_id = v_playlist_id
      and v.active = true
      and (select count(*) from video_questions q where q.video_id = v.id) = 3
      and not exists (
        select 1 from daily_video_access existing
        where existing.user_id = p_user_id
          and existing.access_date = p_access_date
          and existing.video_id = v.id
      )
    order by never_seen desc, last_seen asc, sort_key
    limit greatest(v_pool_limit - v_existing_count, 0)
  ) selected
  on conflict (user_id, access_date, video_id) do nothing;

  return query
  select v.id, v.youtube_video_id, v.title, v.duration_seconds,
         v.points_reward, v.quiz_bonus_points, v.active, v.published_at,
         v.created_at, access.access_position, v_pool_limit, v_watch_limit, v_referral_count
  from daily_video_access access
  join videos v on v.id = access.video_id
  where access.user_id = p_user_id and access.access_date = p_access_date
  order by access.access_position;
end;
$$ language plpgsql security definer set search_path = public;

-- Same body as migration_012's submit_quiz, just with the quiz-bonus
-- fallback updated to match the new 3-points-per-correct-answer default.
-- No DROP needed — return type (json) is unchanged.
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

  v_bonus := coalesce(v_video.quiz_bonus_points, 3) * v_correct;

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
