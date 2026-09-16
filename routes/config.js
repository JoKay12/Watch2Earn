import { Router } from 'express';

const router = Router();

// The anon key is meant to be public — it's the same key Supabase's own
// client-side SDKs ship with. The frontend needs it (plus the project URL)
// to talk to Supabase directly for things our backend can't proxy: the
// Google OAuth redirect flow, and picking up the recovery session from a
// password-reset email link.
router.get('/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

export default router;
