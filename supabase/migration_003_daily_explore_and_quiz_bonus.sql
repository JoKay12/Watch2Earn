-- watch2earn - migration 003: daily randomized Explore access,
-- referral milestone unlock, and quiz completion bonus.
-- Run after schema.sql and migration_002_quiz_and_tracking.sql.

alter table profiles add column if not exists referral_bonus_awarded boolean not null default false;
alter table videos add column if not exists quiz_bonus_points integer not null default 5;

create table if not exists daily_video_access (
  user_id uuid not null references profiles(id) on delete cascade,
  access_date date not null,
  video_id uuid not null references videos(id) on delete cascade,
  access_position integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, access_date, video_id),
  unique (user_id, access_date, access_position)
);

create index if not exists daily_video_access_lookup
  on daily_video_access (user_id, access_date, access_position);

alter table daily_video_access enable row level security;
drop policy if exists "Users can view their daily video access" on daily_video_access;
create policy "Users can view their daily video access" on daily_video_access
  for select using (auth.uid() = user_id);

create or replace function get_daily_videos(p_user_id uuid, p_access_date date default current_date)
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
  referral_count integer,
  referral_bonus_awarded boolean
) as $$
declare
  v_limit integer := 5;
  v_referral_count integer := 0;
  v_bonus_awarded boolean := false;
  v_playlist_id uuid;
  v_existing_count integer := 0;
begin
  select count(*)::integer into v_referral_count
    from referrals where referrer_id = p_user_id;

  select referral_bonus_awarded into v_bonus_awarded
    from profiles where id = p_user_id for update;

  if v_referral_count >= 3 then
    v_limit := 8;
    if not coalesce(v_bonus_awarded, false) then
      insert into points_ledger (user_id, points, reason, reference_id)
        values (p_user_id, 100, 'referral_milestone', p_user_id);
      update profiles
        set points_balance = points_balance + 100,
            referral_bonus_awarded = true
        where id = p_user_id;
      v_bonus_awarded := true;
    end if;
  end if;

  select id into v_playlist_id from playlists
    where lower(trim(title)) = 'let''s discuss'
    limit 1;

  if v_playlist_id is null then
    raise exception 'Lets Discuss playlist is not configured';
  end if;

  select count(*)::integer into v_existing_count
    from daily_video_access
    where user_id = p_user_id and access_date = p_access_date;

  insert into daily_video_access (user_id, access_date, video_id, access_position)
  select p_user_id, p_access_date, selected.id,
      (v_existing_count + row_number() over (order by selected.sort_key))::integer
  from (
    select v.id,
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
    order by sort_key
    limit greatest(v_limit - v_existing_count, 0)
  ) selected
  on conflict (user_id, access_date, video_id) do nothing;

  return query
  select v.id, v.youtube_video_id, v.title, v.duration_seconds,
         v.points_reward, v.quiz_bonus_points, v.active, v.published_at,
         v.created_at, access.access_position, v_limit, v_referral_count, v_bonus_awarded
  from daily_video_access access
  join videos v on v.id = access.video_id
  where access.user_id = p_user_id
    and access.access_date = p_access_date
  order by access.access_position;
end;
$$ language plpgsql security definer set search_path = public;

-- Replace the earlier quiz implementations with the canonical version. A
-- correct quiz pays the normal video reward plus the video's quiz bonus.
create or replace function submit_quiz(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb
) returns json as $$
declare
  v_session record;
  v_video record;
  v_question record;
  v_answer jsonb;
  v_total integer := 0;
  v_correct integer := 0;
  v_bonus integer := 0;
  v_seen uuid[] := '{}';
  v_selected integer;
begin
  select * into v_session from watch_sessions
    where id = p_session_id and user_id = p_user_id and status = 'quiz_pending';
  if not found then raise exception 'Session not eligible for quiz submission'; end if;

  select * into v_video from videos where id = v_session.video_id;
  select count(*)::integer into v_total from video_questions where video_id = v_session.video_id;
  if v_total <> 3 then
    raise exception 'This video does not have a complete quiz configured';
  end if;

  for v_question in select * from video_questions where video_id = v_session.video_id order by position loop
    v_seen := array_append(v_seen, v_question.id);
    select (item->>'selected_index')::integer into v_selected
      from jsonb_array_elements(p_answers) item
      where (item->>'question_id')::uuid = v_question.id
      limit 1;
    if v_selected is not null and v_selected >= 0 and v_selected < jsonb_array_length(v_question.options) then
      if v_selected = v_question.correct_index then v_correct := v_correct + 1; end if;
    end if;
  end loop;

  if v_total > 0 and v_correct < v_total then
    update watch_sessions set quiz_correct_count = v_correct, quiz_total = v_total where id = p_session_id;
    return json_build_object('passed', false, 'correct', v_correct, 'total', v_total, 'pointsEarned', 0, 'quizBonusPoints', 0);
  end if;

  v_bonus := coalesce(v_video.quiz_bonus_points, 5);
  update watch_sessions
    set status = 'completed', completed_at = now(), reward_date = current_date,
        quiz_correct_count = v_correct, quiz_total = v_total
    where id = p_session_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, v_video.points_reward, 'video_watch', p_session_id);
  update profiles set points_balance = points_balance + v_video.points_reward where id = p_user_id;

  if v_total > 0 and v_bonus > 0 then
    insert into points_ledger (user_id, points, reason, reference_id)
      values (p_user_id, v_bonus, 'quiz_bonus', p_session_id);
    update profiles set points_balance = points_balance + v_bonus where id = p_user_id;
  else
    v_bonus := 0;
  end if;

  return json_build_object(
    'passed', true,
    'correct', v_correct,
    'total', v_total,
    'pointsEarned', v_video.points_reward + v_bonus,
    'videoPoints', v_video.points_reward,
    'quizBonusPoints', v_bonus
  );
end;
$$ language plpgsql security definer set search_path = public;
