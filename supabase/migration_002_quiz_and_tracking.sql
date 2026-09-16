-- watch2earn — migration 002: quiz system, real watch-position tracking,
-- and profile display name.
--
-- This is ADDITIVE to supabase/schema.sql — run it once in the SQL Editor
-- on top of your existing database. It does not touch existing data.

-- ============================================================
-- Real watch-position tracking (replaces "elapsed wall-clock time" as the
-- only signal). seconds_watched still exists and still drives the heartbeat
-- clamp; max_position_seconds tracks the furthest point in the video the
-- player has actually reported reaching, and is what "did they watch the
-- whole thing" is judged against — see routes/session.js.
-- ============================================================

alter table watch_sessions add column if not exists max_position_seconds numeric not null default 0;

-- Sessions now pass through a quiz step before being marked 'completed'.
alter table watch_sessions drop constraint if exists watch_sessions_status_check;
alter table watch_sessions add constraint watch_sessions_status_check
  check (status in ('in_progress', 'quiz_pending', 'completed'));

alter table watch_sessions add column if not exists quiz_correct_count integer;
alter table watch_sessions add column if not exists quiz_total integer;

-- ============================================================
-- Quiz questions (admin-authored, 3 per video) and submitted answers
-- ============================================================

create table if not exists video_questions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  position integer not null default 1,
  question text not null,
  options jsonb not null,       -- array of option strings, e.g. ["A", "B", "C", "D"]
  correct_index integer not null, -- index into options[] of the correct answer
  created_at timestamptz not null default now()
);

create table if not exists quiz_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references watch_sessions(id) on delete cascade,
  question_id uuid not null references video_questions(id),
  selected_index integer not null,
  is_correct boolean not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Profile display name (for the new Profile page)
-- ============================================================

alter table profiles add column if not exists display_name text;

-- ============================================================
-- RPC: grade a submitted quiz and, atomically, mark the session complete
-- and credit points (replaces credit_watch_reward for the new flow — that
-- function is left in place for backward compatibility but is no longer
-- called by the app).
-- ============================================================

create or replace function submit_quiz(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb -- [{ "question_id": uuid, "selected_index": int }, ...]
) returns json as $$
declare
  v_session record;
  v_video record;
  v_q record;
  v_ans jsonb;
  v_correct_count integer := 0;
  v_total integer := 0;
  v_referral record;
  v_completed_count integer;
begin
  select * into v_session from watch_sessions
    where id = p_session_id and user_id = p_user_id and status = 'quiz_pending';
  if not found then
    raise exception 'Session not eligible for quiz submission';
  end if;

  select * into v_video from videos where id = v_session.video_id;

  for v_ans in select * from jsonb_array_elements(p_answers)
  loop
    v_total := v_total + 1;
    select * into v_q from video_questions
      where id = (v_ans->>'question_id')::uuid and video_id = v_session.video_id;
    if found then
      insert into quiz_answers (session_id, question_id, selected_index, is_correct)
        values (
          p_session_id,
          v_q.id,
          (v_ans->>'selected_index')::integer,
          v_q.correct_index = (v_ans->>'selected_index')::integer
        );
      if v_q.correct_index = (v_ans->>'selected_index')::integer then
        v_correct_count := v_correct_count + 1;
      end if;
    end if;
  end loop;

  update watch_sessions
    set status = 'completed', completed_at = now(), reward_date = current_date,
        quiz_correct_count = v_correct_count, quiz_total = v_total
    where id = p_session_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, v_video.points_reward, 'video_watch', p_session_id);
  update profiles set points_balance = points_balance + v_video.points_reward where id = p_user_id;

  select * into v_referral from referrals where referee_id = p_user_id and status = 'pending' limit 1;
  if found then
    select count(*) into v_completed_count from watch_sessions
      where user_id = p_user_id and status = 'completed';
    if v_completed_count = 1 then
      update referrals set status = 'rewarded' where id = v_referral.id;
      insert into points_ledger (user_id, points, reason, reference_id)
        values (v_referral.referrer_id, 10, 'referral', v_referral.id);
      update profiles set points_balance = points_balance + 10 where id = v_referral.referrer_id;
    end if;
  end if;

  return json_build_object('correct', v_correct_count, 'total', v_total, 'pointsEarned', v_video.points_reward);
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================
-- RLS for the two new tables
-- ============================================================

alter table video_questions enable row level security;
drop policy if exists "Anyone can view questions for active videos" on video_questions;

alter table quiz_answers enable row level security;
drop policy if exists "Users can view their own quiz answers" on quiz_answers;
create policy "Users can view their own quiz answers" on quiz_answers
  for select using (exists (
    select 1 from watch_sessions ws where ws.id = session_id and ws.user_id = auth.uid()
  ));
