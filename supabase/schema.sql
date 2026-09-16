
-- TABLES
-- ============================================================

-- One row per authenticated user (auth.users is managed by Supabase Auth;
-- this table holds everything app-specific).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  points_balance integer not null default 0,
  referral_code text unique not null,
  referred_by uuid references profiles(id),
  display_name text,
  created_at timestamptz not null default now()
);

-- Safe to re-run: adds display_name to a profiles table that was created
-- before this column existed (i.e. any already-live install). CREATE TABLE
-- IF NOT EXISTS above is a no-op on an existing table, so it alone would
-- never add this column to a database you'd already set up.
alter table profiles add column if not exists display_name text;

create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null,
  title text not null,
  duration_seconds integer not null,
  points_reward integer not null default 10,
  active boolean not null default true,
  featured boolean not null default false,
  published_at timestamptz, -- the video's actual YouTube upload date, for sorting new/old
  created_at timestamptz not null default now()
);

-- Safe to re-run on an already-live database (see the display_name migration
-- above for why CREATE TABLE IF NOT EXISTS alone wouldn't add this column).
alter table videos add column if not exists published_at timestamptz;
alter table videos add column if not exists featured boolean not null default false;

-- Mirrors your channel's actual YouTube playlists, synced by the same admin
-- "Sync now" action that pulls in videos.
create table if not exists playlists (
  id uuid primary key default gen_random_uuid(),
  youtube_playlist_id text unique not null,
  title text not null,
  created_at timestamptz not null default now()
);

-- Many-to-many: a video can appear in more than one playlist on YouTube.
create table if not exists video_playlists (
  video_id uuid not null references videos(id) on delete cascade,
  playlist_id uuid not null references playlists(id) on delete cascade,
  primary key (video_id, playlist_id)
);

alter table playlists enable row level security;
alter table video_playlists enable row level security;
-- No public select policies — these two tables are only ever queried by the
-- admin panel via the service-role client, same trust model as the rest of
-- the admin-only endpoints in this schema.

create table if not exists watch_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  video_id uuid not null references videos(id),
  session_token text unique not null,
  seconds_watched integer not null default 0,
  max_position_seconds integer not null default 0, -- server-verified furthest point reached; see heartbeat handler
  status text not null default 'in_progress' check (status in ('in_progress', 'quiz_pending', 'completed')),
  quiz_correct_count integer, -- set once quiz is submitted
  quiz_total integer,
  last_heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  reward_date date, -- set only when status becomes 'completed' — see submit_quiz()
  ip_address text
);

-- One rewarded watch session per user per video per calendar day.
-- Uses a plain stored column (reward_date) rather than an expression like
-- started_at::date, because Postgres won't allow timestamptz::date inside
-- an index (the cast isn't marked IMMUTABLE).
create unique index if not exists one_completed_per_day
  on watch_sessions (user_id, video_id, reward_date)
  where status = 'completed';

-- Safe to re-run against a database that already has watch_sessions from an
-- earlier version of this schema — CREATE TABLE IF NOT EXISTS above won't add
-- new columns to an existing table, so these do it explicitly.
alter table watch_sessions add column if not exists max_position_seconds integer not null default 0;
alter table watch_sessions add column if not exists quiz_correct_count integer;
alter table watch_sessions add column if not exists quiz_total integer;

alter table watch_sessions drop constraint if exists watch_sessions_status_check;
alter table watch_sessions add constraint watch_sessions_status_check
  check (status in ('in_progress', 'quiz_pending', 'completed'));

-- Three (by convention — not enforced here) multiple-choice questions per
-- video, required before the reward for that video can be claimed. Written
-- by an admin — there's no reliable way to auto-generate accurate questions
-- from a video's actual content without transcript access.
create table if not exists video_questions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete cascade,
  position integer not null default 1,
  question text not null,
  options jsonb not null, -- array of option strings, e.g. ["A", "B", "C", "D"]
  correct_index integer not null, -- index into options
  created_at timestamptz not null default now()
);

-- Self-reported bonus tasks (subscribe/like/comment/share).
-- NOTE: rewarding these can violate YouTube's Terms of Service (treated as
-- incentivized/fake engagement). Keep points_reward at 0, or don't use this
-- table at all, unless you've reviewed that risk. See README.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('subscribe', 'like', 'comment', 'share')),
  video_id uuid references videos(id),
  platform text check (platform in ('youtube', 'instagram', 'facebook', 'x', 'tiktok')),
  points_reward integer not null default 0,
  active boolean not null default true
);

-- Safe to re-run against an already-live database.
alter table tasks add column if not exists platform text;
alter table tasks drop constraint if exists tasks_platform_check;
alter table tasks add constraint tasks_platform_check
  check (platform in ('youtube', 'instagram', 'facebook', 'x', 'tiktok'));

create table if not exists task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  task_id uuid not null references tasks(id),
  status text not null default 'self_reported',
  proof_url text, -- storage path in the 'task-proofs' bucket, for platform-follow tasks that require a screenshot
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, task_id)
);

-- Safe to re-run: widen the status check to include the proof-review states,
-- and add the two columns above to an already-live database.
alter table task_completions add column if not exists proof_url text;
alter table task_completions add column if not exists reviewed_at timestamptz;
alter table task_completions drop constraint if exists task_completions_status_check;
alter table task_completions add constraint task_completions_status_check
  check (status in ('self_reported', 'pending', 'approved', 'rejected'));

create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references profiles(id),
  referee_id uuid not null references profiles(id),
  status text not null default 'pending' check (status in ('pending', 'rewarded')),
  created_at timestamptz not null default now()
);

create table if not exists points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  points integer not null,
  reason text not null, -- video_watch | task_bonus | referral | redemption | admin_adjustment
  reference_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists redemption_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  points_spent integer not null,
  reward_type text not null check (reward_type in ('cash', 'airtime', 'data_bundle')),
  destination text not null,
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx on admin_audit_log (created_at desc);
alter table admin_audit_log enable row level security;

-- ============================================================
-- NEW-USER TRIGGER
-- Runs automatically whenever Supabase Auth creates a row in auth.users
-- (i.e. on signup). Creates the matching profile, generates a referral
-- code, and links up the referral if a valid code was passed at signup.
-- ============================================================

create or replace function handle_new_user()
returns trigger as $$
declare
  v_referrer_id uuid;
  v_referral_id uuid;
  v_code text := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
begin
  if new.raw_user_meta_data ? 'referral_code' then
    select id into v_referrer_id from profiles
      where referral_code = new.raw_user_meta_data->>'referral_code';
  end if;

  insert into profiles (id, email, referral_code, referred_by)
  values (new.id, new.email, v_code, v_referrer_id);

  if v_referrer_id is not null then
    insert into referrals (referrer_id, referee_id, status)
      values (v_referrer_id, new.id, 'rewarded')
      returning id into v_referral_id;
    insert into points_ledger (user_id, points, reason, reference_id)
      values (v_referrer_id, 10, 'referral', v_referral_id);
    update profiles set points_balance = points_balance + 10 where id = v_referrer_id;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- RPC FUNCTIONS
-- Each of these wraps a multi-step write in one atomic Postgres call
-- (the Supabase/Postgres equivalent of a hand-rolled BEGIN/COMMIT
-- transaction) so the backend can call them with a single .rpc() request.
-- ============================================================

-- Replaced by submit_quiz() below, which now owns reward-crediting (it has
-- to, since a quiz can gate whether the reward is granted at all). Dropped
-- here so re-running this file cleans up the old function on a database
-- that already has it from an earlier version of this schema.
drop function if exists credit_watch_reward(uuid, integer, uuid, integer);

-- Called when a user submits answers to a video's quiz. Videos with zero
-- configured questions pass automatically (keeps older videos, added before
-- this feature existed, working without needing questions retrofitted).
-- Grades server-side and, only on a pass, credits the reward + referral
-- bonus atomically — the answer key never has to leave the database.
create or replace function submit_quiz(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb -- [{ "question_id": uuid, "selected_index": int }, ...]
) returns json as $$
declare
  v_session record;
  v_video record;
  v_total integer;
  v_correct integer := 0;
  v_answer jsonb;
  v_correct_index integer;
  v_referral record;
  v_completed_count integer;
begin
  select * into v_session from watch_sessions where id = p_session_id and user_id = p_user_id;
  if not found then
    raise exception 'Session not found';
  end if;
  if v_session.status = 'completed' then
    raise exception 'Reward already claimed for this session';
  end if;
  if v_session.status <> 'quiz_pending' then
    raise exception 'Finish watching the video first';
  end if;

  select count(*) into v_total from video_questions where video_id = v_session.video_id;

  if v_total > 0 then
    for v_answer in select * from jsonb_array_elements(p_answers) loop
      select correct_index into v_correct_index from video_questions
        where id = (v_answer->>'question_id')::uuid;
      if v_correct_index is not null and v_correct_index = (v_answer->>'selected_index')::integer then
        v_correct := v_correct + 1;
      end if;
    end loop;
  end if;

  -- Require a perfect score when there are questions; nothing to answer
  -- (v_total = 0) counts as an automatic pass.
  if v_total > 0 and v_correct < v_total then
    update watch_sessions set quiz_correct_count = v_correct, quiz_total = v_total where id = p_session_id;
    return json_build_object('passed', false, 'correct', v_correct, 'total', v_total, 'pointsEarned', 0);
  end if;

  select * into v_video from videos where id = v_session.video_id;

  update watch_sessions
    set status = 'completed', completed_at = now(), reward_date = current_date,
        quiz_correct_count = v_correct, quiz_total = v_total
    where id = p_session_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, v_video.points_reward, 'video_watch', p_session_id);
  update profiles set points_balance = points_balance + v_video.points_reward where id = p_user_id;

  -- Reward the referrer, but only the FIRST time this user ever completes a video
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

  return json_build_object('passed', true, 'correct', v_correct, 'total', v_total, 'pointsEarned', v_video.points_reward);
end;
$$ language plpgsql security definer set search_path = public;

-- Called when a user marks a self-reported bonus task done.
create or replace function complete_task_bonus(
  p_user_id uuid,
  p_task_id uuid,
  p_points integer
) returns void as $$
begin
  insert into task_completions (user_id, task_id) values (p_user_id, p_task_id);

  if p_points > 0 then
    insert into points_ledger (user_id, points, reason, reference_id)
      values (p_user_id, p_points, 'task_bonus', p_task_id);
    update profiles set points_balance = points_balance + p_points where id = p_user_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- Records a screenshot proof submission WITHOUT crediting points yet — an
-- admin must approve it first. See review_task_proof() below.
create or replace function submit_task_proof(
  p_user_id uuid,
  p_task_id uuid,
  p_proof_url text
) returns void as $$
begin
  insert into task_completions (user_id, task_id, status, proof_url)
    values (p_user_id, p_task_id, 'pending', p_proof_url);
end;
$$ language plpgsql security definer set search_path = public;

-- Admin approves or rejects a pending proof submission. Approving credits
-- the task's points at that moment; rejecting deletes the row entirely so
-- the user can submit a fresh screenshot (the unique(user_id, task_id)
-- constraint would otherwise block a resubmission).
create or replace function review_task_proof(
  p_completion_id uuid,
  p_new_status text
) returns void as $$
declare
  v_completion record;
  v_points integer;
begin
  if p_new_status not in ('approved', 'rejected') then
    raise exception 'status must be approved or rejected';
  end if;

  select * into v_completion from task_completions where id = p_completion_id and status = 'pending';
  if not found then
    raise exception 'Pending submission not found';
  end if;

  if p_new_status = 'rejected' then
    delete from task_completions where id = p_completion_id;
    return;
  end if;

  select points_reward into v_points from tasks where id = v_completion.task_id;

  update task_completions set status = 'approved', reviewed_at = now() where id = p_completion_id;

  if v_points > 0 then
    insert into points_ledger (user_id, points, reason, reference_id)
      values (v_completion.user_id, v_points, 'task_bonus', v_completion.task_id);
    update profiles set points_balance = points_balance + v_points where id = v_completion.user_id;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- Called when a user requests a redemption (cash/airtime/data bundle).
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
  if p_points < 5000 or p_points % 1 <> 0 then
    raise exception 'Redemption must be at least 5000 whole points';
  end if;
  if p_reward_type not in ('cash', 'airtime', 'data_bundle') then
    raise exception 'Invalid reward type';
  end if;
  if p_destination is null or length(trim(p_destination)) = 0 or length(p_destination) > 200 then
    raise exception 'Invalid redemption destination';
  end if;

  select points_balance into v_balance from profiles where id = p_user_id for update;
  if v_balance < p_points then
    raise exception 'Insufficient points';
  end if;

  insert into redemption_requests (user_id, points_spent, reward_type, destination)
    values (p_user_id, p_points, p_reward_type, p_destination)
    returning id into v_id;

  update profiles set points_balance = points_balance - p_points where id = p_user_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, -p_points, 'redemption', v_id);

  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

-- Called by an admin to fulfill or reject a pending redemption.
-- Rejecting automatically refunds the user's points.
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

  select * into v_redemption from redemption_requests where id = p_id and status = 'pending' for update;
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

-- Admin dashboard summary in one round trip.
-- DROP + CREATE (not just CREATE OR REPLACE) because this function's return
-- columns have changed across versions of this file (e.g. pending_task_proofs
-- was added later) — Postgres refuses to REPLACE a function when its OUT
-- signature changes, only when the body changes with the same signature.
drop function if exists admin_stats();
create function admin_stats()
returns table (
  user_count bigint,
  total_points_issued bigint,
  pending_redemptions bigint,
  completed_watches bigint,
  pending_task_proofs bigint
) as $$
  select
    (select count(*) from profiles),
    (select coalesce(sum(points), 0) from points_ledger where points > 0),
    (select count(*) from redemption_requests where status = 'pending'),
    (select count(*) from watch_sessions where status = 'completed'),
    (select count(*) from task_completions where status = 'pending');
$$ language sql security definer set search_path = public;

-- ============================================================
-- ROW LEVEL SECURITY
-- The backend talks to Supabase with the service-role key, which bypasses
-- RLS entirely — these policies are defense-in-depth in case anything ever
-- queries Supabase directly with a user's own token instead of going
-- through the backend.
-- ============================================================

alter table profiles enable row level security;
alter table videos enable row level security;
alter table watch_sessions enable row level security;
alter table video_questions enable row level security;
alter table tasks enable row level security;
alter table task_completions enable row level security;
alter table referrals enable row level security;
alter table points_ledger enable row level security;
alter table redemption_requests enable row level security;

-- drop-then-create makes this section safe to re-run (CREATE POLICY has no
-- "IF NOT EXISTS" option in Postgres, unlike the tables/functions above)
drop policy if exists "Users can view their own profile" on profiles;
create policy "Users can view their own profile" on profiles
  for select using (auth.uid() = id);

drop policy if exists "Anyone can view active videos" on videos;
create policy "Anyone can view active videos" on videos
  for select using (active = true);

drop policy if exists "Users can view their own watch sessions" on watch_sessions;
create policy "Users can view their own watch sessions" on watch_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "Anyone can view active tasks" on tasks;
create policy "Anyone can view active tasks" on tasks
  for select using (active = true);

drop policy if exists "Users can view their own task completions" on task_completions;
create policy "Users can view their own task completions" on task_completions
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view their own points ledger" on points_ledger;
create policy "Users can view their own points ledger" on points_ledger
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view their own redemption requests" on redemption_requests;
create policy "Users can view their own redemption requests" on redemption_requests
  for select using (auth.uid() = user_id);

-- ============================================================
-- STORAGE: task-proofs bucket
-- Holds screenshots users submit as proof of following/subscribing to a
-- social platform. Private (public = false) — the backend uploads and reads
-- it exclusively with the service-role key, which bypasses storage RLS just
-- like it bypasses table RLS elsewhere in this file. Admins view screenshots
-- via short-lived signed URLs generated on demand, not direct public links.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('task-proofs', 'task-proofs', false)
on conflict (id) do nothing;
