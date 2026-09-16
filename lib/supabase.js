import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    '\n✖ Missing Supabase config.\n' +
    '  Make sure .env has real values (not the placeholders) for:\n' +
    '    SUPABASE_URL\n' +
    '    SUPABASE_ANON_KEY\n' +
    '    SUPABASE_SERVICE_ROLE_KEY\n' +
    '  Find these in your Supabase project: Settings → API.\n' +
    '  See README.md for the full setup steps.\n'
  );
  process.exit(1);
}

// Used only for signUp / signInWithPassword (auth endpoints) — the anon key
// is the correct key for these, matching how Supabase's own client SDKs work.
export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Used for all table/RPC access. The service-role key bypasses Row Level
// Security, which is what a trusted backend is supposed to do — RLS in
// schema.sql exists for defense-in-depth, not to restrict this client.
// NEVER send this key to the frontend.
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
