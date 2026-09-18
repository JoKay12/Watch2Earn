import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireContentAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/tasks', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .eq('active', true)
    .not('type', 'in', '(subscribe,like,comment,share)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// --- Admin: manage tasks ---

router.get('/admin/tasks', requireContentAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select('*')
    .not('type', 'in', '(subscribe,like,comment,share)');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/tasks', requireContentAdmin, async (req, res) => {
  res.status(410).json({ error: 'Engagement reward tasks are no longer available.' });
});

router.patch('/admin/tasks/:id', requireContentAdmin, async (req, res) => {
  const { pointsReward, active } = req.body;
  const update = {};
  if (pointsReward !== undefined) update.points_reward = pointsReward;
  if (active !== undefined) update.active = active;

  const { data, error } = await supabaseAdmin
    .from('tasks')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// Engagement rewards are intentionally disabled. The database rows remain for
// historical compatibility, but they are not listed, created, or completed.
router.post('/tasks/:taskId/complete', requireAuth, async (req, res) => {
  const { data: task, error: taskErr } = await supabaseAdmin
    .from('tasks').select('*').eq('id', req.params.taskId).eq('active', true).single();
  if (taskErr || !task) return res.status(404).json({ error: 'Task not found' });

  if (['subscribe', 'like', 'comment', 'share'].includes(task.type)) {
    return res.status(410).json({ error: 'Engagement reward tasks are no longer available.' });
  }

  const { data: already } = await supabaseAdmin
    .from('task_completions')
    .select('id')
    .eq('user_id', req.userId)
    .eq('task_id', task.id)
    .maybeSingle();
  if (already) return res.status(409).json({ error: 'Task already completed' });

  const { error: rpcErr } = await supabaseAdmin.rpc('complete_task_bonus', {
    p_user_id: req.userId,
    p_task_id: task.id,
    p_points: task.points_reward,
  });
  if (rpcErr) return res.status(500).json({ error: rpcErr.message });

  res.json({ status: 'self_reported', pointsEarned: task.points_reward });
});

export default router;
