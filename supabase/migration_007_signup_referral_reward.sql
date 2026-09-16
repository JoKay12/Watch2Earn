-- The referrer receives 10 points when a valid referral code is used.
-- The new user receives no referral signup points.

create or replace function public.handle_new_user()
returns trigger as $$
declare
  v_referrer_id uuid;
  v_referral_id uuid;
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
  for each row execute function public.handle_new_user();

-- Migrate referrals created by the previous signup flow. Each pending row
-- represents a valid referral signup that has not received its reward yet.
do $$
declare
  v_referral record;
begin
  for v_referral in
    select id, referrer_id
      from referrals
      where status = 'pending'
      for update
  loop
    update referrals set status = 'rewarded' where id = v_referral.id;
    insert into points_ledger (user_id, points, reason, reference_id)
      values (v_referral.referrer_id, 10, 'referral', v_referral.id);
    update profiles
      set points_balance = points_balance + 10
      where id = v_referral.referrer_id;
  end loop;
end;
$$;