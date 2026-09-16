-- Server-side admin roles. Seed the first admin with a trusted auth.users UUID:
-- insert into public.admin_roles (user_id, role) values ('...', 'admin');
create table if not exists admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'content_editor', 'payout_operator')),
  created_at timestamptz not null default now()
);

alter table admin_roles enable row level security;
drop policy if exists "Admins can view admin roles" on admin_roles;
create policy "Admins can view admin roles" on admin_roles
  for select using (auth.uid() = user_id);

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

alter table payouts enable row level security;
drop policy if exists "Users can view their own payouts" on payouts;
create policy "Users can view their own payouts" on payouts
  for select using (exists (
    select 1 from redemption_requests r
    where r.id = redemption_id and r.user_id = auth.uid()
  ));

-- Migration 004 already defines this function, but migration 005 must replace
-- its body so each redemption also creates the queued payout row. Dropping by
-- the complete signature avoids PostgreSQL return-type replacement conflicts.
drop function if exists public.create_redemption(uuid, integer, text, text);

create function create_redemption(
  p_user_id uuid,
  p_points integer,
  p_reward_type text,
  p_destination text
) returns uuid as $$
declare
  v_id uuid;
  v_balance integer;
begin
  if p_points < 5000 then raise exception 'Redemption must be at least 5000 whole points'; end if;
  if p_reward_type not in ('cash', 'airtime', 'data_bundle') then raise exception 'Invalid reward type'; end if;
  if p_destination is null or length(trim(p_destination)) = 0 or length(p_destination) > 200 then
    raise exception 'Invalid redemption destination';
  end if;

  select points_balance into v_balance from profiles where id = p_user_id for update;
  if v_balance is null then raise exception 'Profile not found'; end if;
  if v_balance < p_points then raise exception 'Insufficient points'; end if;

  insert into redemption_requests (user_id, points_spent, reward_type, destination)
    values (p_user_id, p_points, p_reward_type, trim(p_destination)) returning id into v_id;
  update profiles set points_balance = points_balance - p_points where id = p_user_id;
  insert into points_ledger (user_id, points, reason, reference_id)
    values (p_user_id, -p_points, 'redemption', v_id);
  insert into payouts (redemption_id, provider, idempotency_key, amount)
    values (v_id, 'manual', 'payout-' || v_id::text, p_points / 1000.0);
  return v_id;
end;
$$ language plpgsql security definer set search_path = public;

-- Recreate this function explicitly because older installs may have a
-- different OUT-column signature. CREATE OR REPLACE cannot change that
-- signature, so the old zero-argument function must be dropped first.
drop function if exists public.admin_stats();
create function public.admin_stats()
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
