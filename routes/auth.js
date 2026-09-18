import { Router } from 'express';
import crypto from 'crypto';
import { supabaseAuth, supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();

async function attachPhoneNumber(profile) {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(profile.id);
  if (error) throw error;
  return { ...profile, phone_number: data.user?.user_metadata?.phone_number || null };
}

async function addReferralProgress(profile) {
  const { count, error } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_id', profile.id);
  if (error) throw error;
  const referralCount = count || 0;
  return {
    ...profile,
    referral_count: referralCount,
    daily_video_limit: referralCount >= 3 ? 8 : 5,
    referral_bonus_awarded: Boolean(profile.referral_bonus_awarded),
  };
}

router.post('/register', async (req, res) => {
  const { email, password, referralCode } = req.body;
  if (typeof email !== 'string' || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)
    || typeof password !== 'string' || password.length < 8 || password.length > 128
    || (referralCode !== undefined && (typeof referralCode !== 'string' || referralCode.length > 32))) {
    return res.status(400).json({ error: 'Valid email and password (8+ chars) required' });
  }

  const { data, error } = await supabaseAuth.auth.signUp({
    email,
    password,
    options: referralCode ? { data: { referral_code: referralCode } } : undefined,
  });

  if (error) return res.status(400).json({ error: error.message });

  // If your Supabase project has "Confirm email" enabled (the default),
  // data.session will be null here until the user clicks the confirmation
  // link in their inbox. For local testing, you can turn that off under
  // Authentication → Providers → Email → "Confirm email".
  if (!data.session) {
    return res.json({ message: 'Check your email to confirm your account, then log in.' });
  }

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: { id: data.user.id, email: data.user.email },
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || email.length > 254 || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'Valid email and password required' });
  }
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) {
    // Logged server-side only — the client still gets a generic message so we
    // don't leak account-enumeration info, but you can see the real reason
    // in this terminal while debugging.
    console.error('Login failed:', error.status, error.message);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    user: { id: data.user.id, email: data.user.email },
  });
});

// Stateless bearer tokens — logging out is really just the frontend
// discarding its stored token. This endpoint exists for symmetry / so the
// frontend has something to call.
router.post('/logout', requireAuth, (req, res) => {
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  let { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, points_balance, referral_code, display_name, referral_bonus_awarded')
    .eq('id', req.userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = "no rows found", which is the one case worth self-healing
    // below. Anything else (bad column, connection issue, etc.) is a real
    // problem — log it with the real reason instead of hiding it behind a
    // generic "not found", which would send whoever's debugging this down
    // the wrong path entirely.
    console.error('GET /me failed:', error.code, error.message);
    return res.status(500).json({ error: error.message });
  }

  if (!data) {
    // The Supabase Auth account exists (requireAuth already confirmed that)
    // but its profiles row doesn't — this can happen for accounts created
    // before the auto-provisioning trigger was working correctly. Self-heal
    // instead of permanently locking the account out.
    const referralCode = crypto.randomBytes(4).toString('hex');
    const { data: created, error: createErr } = await supabaseAdmin
      .from('profiles')
      .insert({ id: req.userId, email: req.userEmail, referral_code: referralCode })
      .select('id, email, points_balance, referral_code, display_name, referral_bonus_awarded')
      .single();

    if (createErr || !created) {
      console.error('Failed to self-heal missing profile:', createErr?.message);
      return res.status(404).json({ error: 'Profile not found' });
    }
    data = created;
  }

  try {
    res.json(await addReferralProgress(await attachPhoneNumber(data)));
  } catch (progressError) {
    console.error('GET /me referral progress failed:', progressError.message);
    res.status(500).json({ error: 'Could not load referral progress' });
  }
});

router.patch('/me', requireAuth, async (req, res) => {
  const { displayName, phoneNumber } = req.body;
  if (displayName !== undefined && displayName !== null
    && (typeof displayName !== 'string' || displayName.length > 80)) {
    return res.status(400).json({ error: 'Display name must be 80 characters or fewer' });
  }
  if (phoneNumber !== undefined && phoneNumber !== null
    && (typeof phoneNumber !== 'string' || phoneNumber.length > 30)) {
    return res.status(400).json({ error: 'Phone number must be 30 characters or fewer' });
  }
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ display_name: displayName ?? null })
    .eq('id', req.userId)
    .select('id, email, points_balance, referral_code, display_name, referral_bonus_awarded')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  try {
    const { data: authUser, error: authUserError } = await supabaseAdmin.auth.admin.getUserById(req.userId);
    if (authUserError) return res.status(500).json({ error: authUserError.message });
    const { error: phoneError } = await supabaseAdmin.auth.admin.updateUserById(req.userId, {
      user_metadata: { ...(authUser.user?.user_metadata || {}), phone_number: phoneNumber?.trim() || null },
    });
    if (phoneError) return res.status(500).json({ error: phoneError.message });
    res.json(await addReferralProgress(await attachPhoneNumber(data)));
  } catch (progressError) {
    console.error('PATCH /me referral progress failed:', progressError.message);
    res.status(500).json({ error: 'Could not load referral progress' });
  }
});

// Sends a password-reset email via Supabase. Always responds with the same
// success message regardless of whether the email is registered, so this
// endpoint can't be used to check which emails have accounts.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const redirectTo = `${req.protocol}://${req.get('host')}/reset-password.html`;
  const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) console.error('Password reset request failed:', error.message);

  res.json({ message: 'If an account exists for that email, a reset link is on its way.' });
});

export default router;
