import { supabaseAuth } from '../lib/supabase.js';
import { supabaseAdmin } from '../lib/supabase.js';

// Asks Supabase's Auth server to validate the token, rather than checking its
// signature locally. Slightly slower (one network round trip per request),
// but it works regardless of whether your Supabase project uses the legacy
// shared JWT secret or newer asymmetric signing keys — avoids an entire
// class of "valid token gets silently rejected" bugs.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) {
    console.error('Auth check failed:', error?.message);
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.userId = data.user.id;
  req.userEmail = data.user.email;
  next();
}

export function requireAdminRole(roles = ['admin']) {
  return async (req, res, next) => {
    await requireAuth(req, res, async () => {
      const { data, error } = await supabaseAdmin
        .from('admin_roles')
        .select('role')
        .eq('user_id', req.userId)
        .in('role', roles)
        .maybeSingle();
      if (error) {
        console.error('Admin role lookup failed:', error.message);
        return res.status(503).json({ error: 'Admin authorization unavailable' });
      }
      if (!data) return res.status(403).json({ error: 'Admin role required' });
      req.adminRole = data.role;
      next();
    });
  };
}

export const requireAdmin = requireAdminRole(['admin']);
export const requireContentAdmin = requireAdminRole(['admin', 'content_editor']);
export const requirePayoutAdmin = requireAdminRole(['admin', 'payout_operator']);