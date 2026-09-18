-- watch2earn — consolidated schema
--
-- Regenerated 2026-09-18 directly from the live production database
-- (project gcfmwdcjrlpajgjiaeig), because the previous version of this file
-- had drifted badly from what's actually running: it still had the old
-- 10-point signup referral bonus (fixed live by migration_014/015), the old
-- flat 5000-point redemption threshold (replaced by the tiered reward_tiers
-- system in migration_016), and was missing five tables entirely
-- (admin_roles, payouts, reward_tiers, quiz_answers, daily_video_access)
-- along with the functions that use them (complete_video_watch,
-- get_daily_videos, admin_stats).
--
-- This file is a snapshot for setting up a fresh database, or for reading
-- what's actually live — not a migration log. The supabase/migration_*.sql
-- files are the log; keep reading them for the "why" behind each change.
-- Whenever a migration changes the schema going forward, regenerate this
-- file again rather than hand-editing it — that's what let it drift last
-- time.

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
  created_at timestamptz not null default now(),
  display_name text,
  -- Vestigial: tracked the old 100-point referral milestone bonus, which
  -- migration_013 removed entirely. Still read and returned by routes/auth.js
  -- but no longer set to true by anything — safe to ignore, worth deleting
  -- in a future cleanup pass.
  referral_bonus_awarded boolean not null default false
);

create table if not exists videos (
  id uuid primary key default gen_random_uuid(),
  youtube_video_id text not null,
  title text not null,
  duration_seconds integer not null,
  -- Flat 100 points for every video since migration_016 (previously
  -- admin-configurable per video). The column stays editable in case a
  -- specific video ever needs to differ.
  points_reward integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  published_at timestamptz, -- the video's actual YouTube upload date, for sorting new/old
  quiz_bonus_points integer not null default 3,
  featured boolean not null default false
);

-- Only videos with a complete 3-question quiz and a spot in the "Let's
-- Discuss" playlist are eligible for the daily pool (see get_daily_videos
-- below) — this index just makes browsing the public catalog fast.
create index if not exists videos_public_featured_idx
  on videos (featured, published_at desc)
  where active = true;

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
  status text not null default 'in_progress' check (status in ('in_progress', 'quiz_pending', 'completed')),
  last_heartbeat_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  reward_date date, -- set once the video-watch reward is credited — see complete_video_watch()
  ip_address text,
  max_position_seconds integer not null default 0, -- server-verified furthest point reached; see heartbeat handler
  quiz_correct_count integer, -- set once the quiz is submitted
  quiz_total integer
);

-- One rewarded watch session per user per video per calendar day.
-- Uses a plain stored column (reward_date) rather than an expression like
-- started_at::date, because Postgres won't allow timestamptz::date inside
-- an index (the cast isn't marked IMMUTABLE).
create unique index if not exists one_completed_per_day
  on watch_sessions (user_id, video_id, reward_date)
  where status = 'completed';

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

-- The answer key never leaves the database — RLS is enabled with no select
-- policy, so only the service-role backend can read it (see migration_004).
alter table video_questions enable row level security;

-- Per-question answers a user submitted for a given watch session, recorded
-- by submit_quiz()/complete_video_watch() for later review/analytics.
create table if not exists quiz_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references watch_sessions(id),
  question_id uuid not null references video_questions(id),
  selected_index integer not null,
  is_correct boolean not null,
  created_at timestamptz not null default now()
);

-- Self-reported bonus tasks (subscribe/like/comment/share).
-- NOTE: rewarding these can violate YouTube's Terms of Service (treated as
-- incentivized/fake engagement). Keep points_reward at 0, or don't use this
-- table at all, unless you've reviewed that risk. See README. As of
-- routes/tasks.js, these engagement types are disabled outright (410
-- Gone) — the rows and this table remain for historical compatibility only.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('subscribe', 'like', 'comment', 'share')),
  video_id uuid references videos(id),
  points_reward integer not null default 0,
  active boolean not null default true,
  platform text check (platform in ('youtube', 'instagram', 'facebook', 'x', 'tiktok'))
);

create table if not exists task_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  task_id uuid not null references tasks(id),
  status text not null default 'self_reported' check (status in ('self_reported', 'pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  proof_url text, -- storage path in the 'task-proofs' bucket, for platform-follow tasks that require a screenshot
  reviewed_at timestamptz,
  unique (user_id, task_id)
);

-- One referral row per referred signup. `status` only ever tracks whether
-- the referrer's threshold count (see get_daily_videos) should count this
-- referral yet — no points are attached to referrals anymore as of
-- migration_014 (the per-signup bonus) and migration_013 (the old
-- milestone bonus).
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
  reason text not null, -- video_watch | quiz_bonus | task_bonus | redemption | admin_adjustment
  reference_id uuid,
  created_at timestamptz not null default now()
);

-- Which video(s) a user was assigned to their daily pool, and in what
-- order — written by get_daily_videos() below, read back on every page
-- load so the pool stays stable across a single day rather than reshuffling
-- on every request.
create table if not exists daily_video_access (
  user_id uuid not null references profiles(id),
  access_date date not null,
  video_id uuid not null references videos(id),
  access_position integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, access_date, video_id),
  unique (user_id, access_date, access_position)
);

create index if not exists daily_video_access_lookup
  on daily_video_access (user_id, access_date, access_position);

-- Flat GHS-equivalent reward tiers, uniform across cash/airtime/data as of
-- migration_016. Replaces the old "5000+ points, data priced by megabyte"
-- rules with a single points_required -> GHS-amount table an admin can edit
-- directly (no code change needed to adjust pricing).
create table if not exists reward_tiers (
  id uuid primary key default gen_random_uuid(),
  points_required integer not null unique,
  airtime_ghs numeric,
  data_ghs numeric,
  cash_ghs numeric,
  active boolean not null default true,
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
  resolved_at timestamptz,
  -- Added by migration_016 alongside the tiered reward system.
  reward_amount_label text, -- e.g. "150 GHS airtime", shown back to the user/admin
  points_required integer -- the tier this redemption was requested at (== points_spent today, kept separate for clarity)
);

-- Server-side admin roles. Seed the first admin with a trusted auth.users
-- UUID: insert into admin_roles (user_id, role) values ('...', 'admin');
create table if not exists admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'content_editor', 'payout_operator')),
  created_at timestamptz not null default now()
);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  redemption_id uuid not null unique references redemption_requests(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  provider text not null default 'manual',
  provider_payout_id text,
  idempotency_key text not null unique,
  amount numeric(12, 2) not null,
  currency text not null default 'USD',
  attempt_count integer not null default 0,
  failure_code text,
  failure_message text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
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

-- ============================================================
-- NEW-USER TRIGGER
-- Runs automatically whenever Supabase Auth creates a row in auth.users
-- (i.e. on signup). Creates the matching profile, generates a referral
-- code, and links up the referral (as 'pending', no points) if a valid
-- code was passed at signup.
--
-- IMPORTANT: as of migration_015, this does NOT credit the referrer any
-- points at signup time. An earlier version did (a 10-point bonus), which
-- migration_014 tried and failed to remove because it edited the wrong
-- function — see migration_015's own comment for the full story. The
-- referral is only ever marked 'rewarded' (still no points) later, by
-- complete_video_watch(), the first time the referee earns a reward.
-- ============================================================

create or replace function handle_new_user()
returns trigger as $$
declare
  v_referrer_id uuid;
  v_code text := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
begin
  if new.raw_user_meta_data ? 'referral_code' then
    select id into v_referrer_id
      from profiles
      where referral_code = trim(new.raw_user_meta_data->>'referral_code');
  end if;

  insert into profiles (id, email, referral_code, referred_by)
    values (new.id, new.email, v_code, v_referrer_id);

  if v_referrer_id is not null then
    insert into referrals (referrer_id, referee_id, status)
      values (v_referrer_id, new.id, 'pending');
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

-- Builds (and caches, in daily_video_access) today's video pool for a user.
-- Referring 5+ people who've gone on to earn a reward ('rewarded' status)
-- unlocks a bigger pool (8 videos instead of 5) and a higher daily watch
-- limit (5 instead of 3) — see routes/session.js's /session/start, which
-- enforces v_watch_limit.
create or replace function get_daily_videos(
  p_user_id uuid,
  p_access_date date default current_date
) returns table (
  id uuid, youtube_video_id text, title text, duration_seconds integer,
  points_reward integer, quiz_bonus_points integer, active boolean,
  published_at timestamptz, created_at timestamptz,
  access_position integer, daily_limit integer, daily_watch_limit integer,
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

-- Called once a user's watched position reaches the video's required
-- threshold (server-verified via the heartbeat handler, not client-reported
-- time). Idempotent: a session already past 'in_progress' returns
-- alreadyCredited instead of erroring, since duplicate heartbeats near the
-- threshold are expected. Also marks the referrer's referral 'rewarded'
-- (no points — see handle_new_user above) the first time this user earns
-- any reward at all, which is what feeds the 5-referral pool/limit boost.
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
    return json_build_object('alreadyCredited', true, 'pointsEarned', 0);
  end if;

  select * into v_video from videos where id = v_session.video_id;

  update watch_sessions
    set status = 'quiz_pending', reward_date = current_date
    where id = p_session_id;

  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, v_video.points_reward, 'video_watch', p_session_id);
  update profiles set points_balance = points_balance + v_video.points_reward where id = p_user_id;

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

-- Grades a submitted quiz server-side (the answer key never leaves the
-- database) and credits the per-question quiz bonus for each correct
-- answer, on top of whatever complete_video_watch() already credited for
-- watching. Requires the session to be 'quiz_pending' (i.e. the watch
-- portion was already credited).
create or replace function submit_quiz(
  p_session_id uuid,
  p_user_id uuid,
  p_answers jsonb -- [{ "question_id": uuid, "selected_index": int }, ...]
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

-- Called when a user marks a self-reported bonus task done. Dead in
-- practice today — routes/tasks.js returns 410 Gone for every engagement
-- task type before this can be reached — kept for any non-engagement task
-- type that might use it.
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
-- As of migration_016: tiered pricing (reward_tiers), one request per
-- rolling 24 hours across any reward type, uniform 2000-point floor set by
-- the lowest active tier rather than a hardcoded minimum.
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
alter table tasks enable row level security;
alter table task_completions enable row level security;
alter table referrals enable row level security;
alter table points_ledger enable row level security;
alter table redemption_requests enable row level security;
alter table admin_audit_log enable row level security;
alter table quiz_answers enable row level security;
alter table daily_video_access enable row level security;
alter table admin_roles enable row level security;
alter table payouts enable row level security;
alter table reward_tiers enable row level security;

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

drop policy if exists "Users can view their daily video access" on daily_video_access;
create policy "Users can view their daily video access" on daily_video_access
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view their own quiz answers" on quiz_answers;
create policy "Users can view their own quiz answers" on quiz_answers
  for select using (exists (
    select 1 from watch_sessions ws
    where ws.id = quiz_answers.session_id and ws.user_id = auth.uid()
  ));

drop policy if exists "Admins can view admin roles" on admin_roles;
create policy "Admins can view admin roles" on admin_roles
  for select using (auth.uid() = user_id);

drop policy if exists "Users can view their own payouts" on payouts;
create policy "Users can view their own payouts" on payouts
  for select using (exists (
    select 1 from redemption_requests r
    where r.id = payouts.redemption_id and r.user_id = auth.uid()
  ));

drop policy if exists "Anyone can view active reward tiers" on reward_tiers;
create policy "Anyone can view active reward tiers" on reward_tiers
  for select using (active = true);

-- video_questions, playlists, video_playlists and admin_audit_log are
-- intentionally left with RLS enabled and NO select policy — they're only
-- ever read by the service-role backend (see migration_004's comment on
-- why the answer key in video_questions must never be directly readable).

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
