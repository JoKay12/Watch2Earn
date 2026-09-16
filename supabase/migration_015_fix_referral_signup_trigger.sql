-- watch2earn — migration 015: actually remove the referral signup bonus
--
-- QA finding: migration_014 removed the 10-point referral bonus from
-- complete_video_watch, believing that was where it was credited. It
-- wasn't. migration_007's on_auth_user_created trigger (handle_new_user)
-- credits 10 points to the referrer AND marks the referral 'rewarded'
-- immediately at signup — before migration_014's code ever runs. Because
-- the referral was already 'rewarded' by the time complete_video_watch
-- looked for a 'pending' one, that code path was silently unreachable.
-- The bonus migration_014 was supposed to remove has been active the
-- whole time.
--
-- This fixes it at the actual source: signup now creates the referral as
-- 'pending' with no points credited, exactly like any other new referral.
-- complete_video_watch (migration_014) already correctly marks it
-- 'rewarded' with no points once the referee earns their first reward —
-- that logic was always correct, it just never got a turn to run.
--
-- Safe to re-run.

create or replace function public.handle_new_user()
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

-- Any referral still sitting at 'pending' from before this fix continues
-- working correctly as-is — complete_video_watch will mark it 'rewarded'
-- (no points) the first time that referee earns a reward, same as any
-- new signup going forward. Nothing to backfill here.
