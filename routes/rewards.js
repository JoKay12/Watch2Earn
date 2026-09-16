import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireAdmin, requirePayoutAdmin } from '../auth.js';
import { processQueuedPayouts } from '../lib/payouts.js';

const router = Router();

// Public — the reward menu isn't sensitive, and showing it to visitors
// before they sign up is good marketing. Used by both the logged-in
// Rewards page and the public landing page's "how rewards work" section.
router.get('/reward-tiers', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('reward_tiers')
    .select('id, points_required, airtime_ghs, data_ghs, cash_ghs')
    .eq('active', true)
    .order('points_required');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/ledger', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('points_ledger')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// User requests a payout at a fixed reward tier (see reward_tiers table).
// This does NOT move real money -- it just records the request. Fulfillment
// happens by an admin, ideally by integrating a real payout API (e.g.
// Reloadly for airtime/data, Paystack/Flutterwave/PayPal Payouts for cash)
// rather than sending money manually at scale.
router.post('/redeem', requireAuth, async (req, res) => {
  const { pointsRequired, rewardType, destination } = req.body;
  if (!Number.isInteger(pointsRequired) || pointsRequired <= 0) {
    return res.status(400).json({ error: 'A valid reward tier is required' });
  }
  if (!['cash', 'airtime', 'data_bundle'].includes(rewardType)) {
    return res.status(400).json({ error: 'Invalid reward type' });
  }
  if (typeof destination !== 'string' || destination.trim().length === 0 || destination.length > 200) {
    return res.status(400).json({ error: 'Destination (phone number / payout account) required' });
  }

  // Atomic: validates the tier, checks balance, inserts the request, debits
  // points — see create_redemption() in supabase/migration_011_tiered_rewards.sql.
  const { data: id, error } = await supabaseAdmin.rpc('create_redemption', {
    p_user_id: req.userId,
    p_points_required: pointsRequired,
    p_reward_type: rewardType,
    p_destination: destination,
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  res.json({ id, status: 'pending' });
});

router.get('/redemptions', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('redemption_requests')
    .select('*, payouts(status, provider, provider_payout_id, failure_code, failure_message, completed_at)')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Admin endpoints (protect with x-admin-key header in this starter) ---

router.get('/admin/stats', requirePayoutAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc('admin_stats').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({
    role: req.adminRole,
    userCount: data.user_count,
    totalPointsIssued: data.total_points_issued,
    pendingRedemptions: data.pending_redemptions,
    completedWatches: data.completed_watches,
    pendingTaskProofs: data.pending_task_proofs,
  });
});

router.get('/admin/redemptions', requirePayoutAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  let query = supabaseAdmin
    .from('redemption_requests')
    .select('*, profiles(email), payouts(status, provider, provider_payout_id, attempt_count, failure_code, failure_message)')
    .order('created_at', { ascending: status !== 'all' });
  if (status !== 'all') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Flatten profiles(email) join to match the shape the frontend expects
  res.json(data.map((r) => ({ ...r, email: r.profiles?.email, profiles: undefined })));
});

router.get('/admin/audit-log', requirePayoutAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('admin_audit_log')
    .select('id, admin_user_id, action, entity_type, entity_id, details, created_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/admin/payouts/process', requirePayoutAdmin, async (req, res) => {
  if (process.env.PAYOUT_AUTOMATION_ENABLED !== 'true') {
    return res.status(409).json({ error: 'Payout automation is disabled' });
  }
  try {
    res.json(await processQueuedPayouts());
  } catch (error) {
    console.error('Manual payout processing failed:', error.message);
    res.status(500).json({ error: 'Payout processing failed' });
  }
});

router.get('/admin/roles', requireAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('admin_roles').select('user_id, role, created_at').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/roles', requireAdmin, async (req, res) => {
  const { userId, role } = req.body;
  if (!['admin', 'content_editor', 'payout_operator'].includes(role)
    || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Valid userId and role required' });
  }
  const { data, error } = await supabaseAdmin
    .from('admin_roles').upsert({ user_id: userId, role }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  await supabaseAdmin.from('admin_audit_log').insert({
    admin_user_id: req.userId,
    action: 'role_granted',
    entity_type: 'admin_role',
    entity_id: userId,
    details: { role },
  });
  res.json(data);
});

router.delete('/admin/roles/:userId', requireAdmin, async (req, res) => {
  if (req.userId === req.params.userId) return res.status(400).json({ error: 'You cannot remove your own admin role' });
  const { error } = await supabaseAdmin.from('admin_roles').delete().eq('user_id', req.params.userId);
  if (error) return res.status(400).json({ error: error.message });
  await supabaseAdmin.from('admin_audit_log').insert({
    admin_user_id: req.userId,
    action: 'role_removed',
    entity_type: 'admin_role',
    entity_id: req.params.userId,
  });
  res.json({ ok: true });
});

router.post('/admin/redemptions/:id/resolve', requirePayoutAdmin, async (req, res) => {
  const { status } = req.body; // 'fulfilled' | 'rejected'
  if (!['fulfilled', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be fulfilled or rejected' });
  }

  // Atomic: updates status, refunds points on rejection — see
  // resolve_redemption() in supabase/schema.sql
  const { error } = await supabaseAdmin.rpc('resolve_redemption', {
    p_id: req.params.id,
    p_status: status,
  });
  if (error) return res.status(404).json({ error: error.message });

  await supabaseAdmin.from('payouts').update({
    status: status === 'fulfilled' ? 'succeeded' : 'cancelled',
    provider: 'manual',
    completed_at: new Date().toISOString(),
  }).eq('redemption_id', req.params.id).in('status', ['queued', 'processing', 'failed']);

  await supabaseAdmin.from('admin_audit_log').insert({
    admin_user_id: req.userId,
    action: `redemption_${status}`,
    entity_type: 'redemption_request',
    entity_id: req.params.id,
    details: { status },
  });

  res.json({ id: req.params.id, status });
});

router.get('/admin/reward-tiers', requireAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('reward_tiers')
    .select('*')
    .order('points_required');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/admin/reward-tiers/:id', requireAdmin, async (req, res) => {
  const { airtimeGhs, dataGhs, cashGhs, active } = req.body;
  const updates = {};
  if (airtimeGhs !== undefined) updates.airtime_ghs = airtimeGhs === null ? null : Number(airtimeGhs);
  if (dataGhs !== undefined) updates.data_ghs = dataGhs === null ? null : Number(dataGhs);
  if (cashGhs !== undefined) updates.cash_ghs = cashGhs === null ? null : Number(cashGhs);
  if (active !== undefined) updates.active = Boolean(active);

  const { data, error } = await supabaseAdmin
    .from('reward_tiers')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  await supabaseAdmin.from('admin_audit_log').insert({
    admin_user_id: req.userId,
    action: 'reward_tier_updated',
    entity_type: 'reward_tier',
    entity_id: req.params.id,
    details: updates,
  });

  res.json(data);
});

export default router;
