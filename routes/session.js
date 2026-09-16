import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireContentAdmin } from '../auth.js';
import { getUploadsPlaylistId, fetchAllChannelVideos, fetchChannelPlaylists, fetchPlaylistVideoIds } from '../lib/youtube.js';

const router = Router();

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters');
}

// A session is only offered the quiz once real watched position reaches this
// fraction of the video's duration. Not 1.0, to allow for the player firing
// its "ended" event a fraction of a second before the exact end.
const COMPLETION_THRESHOLD = 0.95;

// How far max_position_seconds is allowed to advance per heartbeat (heartbeats
// fire every 5s from the frontend). This is the actual anti-skip enforcement:
// no matter what position the client reports, verified progress can only
// creep forward at roughly real playback speed — seeking ahead doesn't
// advance it, because the server never trusts a jump bigger than this.
const MAX_POSITION_ADVANCE_PER_BEAT = 8;

// Public homepage content: only explicitly featured, active videos with a
// complete quiz are exposed, and only fields needed for the preview are returned.
router.get('/featured-videos', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('videos')
    .select('id, youtube_video_id, title, duration_seconds, points_reward, published_at')
    .eq('active', true)
    .eq('featured', true)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(6);
  if (error) {
    console.error('GET /featured-videos failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json(data || []);
});

// ---------- Daily Explore videos (authenticated) ----------

router.get('/videos', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc('get_daily_videos', {
    p_user_id: req.userId,
    p_access_date: new Date().toISOString().slice(0, 10),
  });
  if (error) {
    console.error('GET /videos failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json((data || []).map((video) => ({
    ...video,
    daily_limit: video.daily_limit,
    daily_watch_limit: video.daily_watch_limit,
    referral_count: video.referral_count,
  })));
});

// Questions for a video — correct_index is intentionally stripped out here.
// Grading happens server-side in the submit_quiz RPC so the answer key is
// never sent to the browser.
router.get('/videos/:id/questions', requireAuth, async (req, res) => {
  const accessDate = new Date().toISOString().slice(0, 10);
  const { data: access, error: accessErr } = await supabaseAdmin
    .from('daily_video_access')
    .select('video_id')
    .eq('user_id', req.userId)
    .eq('access_date', accessDate)
    .eq('video_id', req.params.id)
    .maybeSingle();
  if (accessErr) return res.status(500).json({ error: accessErr.message });
  if (!access) return res.status(403).json({ error: 'This video is not in your Explore selection for today' });

  const { data, error } = await supabaseAdmin
    .from('video_questions')
    .select('id, position, question, options')
    .eq('video_id', req.params.id)
    .order('position');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Watch history (completed AND in-progress, for "continue watching") ----------

router.get('/watch-history', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('watch_sessions')
    .select('id, status, completed_at, started_at, max_position_seconds, quiz_correct_count, quiz_total, videos(id, title, points_reward, quiz_bonus_points, duration_seconds, youtube_video_id)')
    .eq('user_id', req.userId)
    .in('status', ['completed', 'in_progress', 'quiz_pending'])
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data.map((row) => {
    // Base reward is earned as soon as the video is finished (status
    // reaches quiz_pending or completed) — no longer gated on the quiz.
    // The bonus is per correct answer, not all-or-nothing.
    const earnedBase = ['quiz_pending', 'completed'].includes(row.status);
    const bonus = (row.videos?.quiz_bonus_points || 0) * (row.quiz_correct_count || 0);
    return {
      id: row.id,
      status: row.status,
      completedAt: row.completed_at,
      startedAt: row.started_at,
      positionSeconds: row.max_position_seconds,
      quizCorrect: row.quiz_correct_count,
      quizTotal: row.quiz_total,
      videoId: row.videos?.id,
      title: row.videos?.title,
      pointsEarned: (earnedBase ? (row.videos?.points_reward || 0) : 0) + bonus,
      quizBonusPoints: bonus,
      durationSeconds: row.videos?.duration_seconds,
      youtubeVideoId: row.videos?.youtube_video_id,
    };
  }));
});

// ---------- Admin: manage videos ----------

router.get('/admin/videos', requireContentAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('videos')
    .select('*, video_playlists(playlists(id, title))')
    .order('published_at', { ascending: false, nullsFirst: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data.map((v) => ({
    ...v,
    playlists: (v.video_playlists || []).map((vp) => vp.playlists).filter(Boolean),
    video_playlists: undefined,
  })));
});

router.get('/admin/playlists', requireContentAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('playlists').select('id, title').order('title');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/admin/videos', requireContentAdmin, async (req, res) => {
  const { youtubeVideoId, title, durationSeconds, pointsReward, quizBonusPoints } = req.body;
  // Real YouTube video IDs are always exactly 11 characters of this
  // charset. Rejecting anything else here matters beyond data hygiene —
  // this value later renders unescaped in the admin panel's thumbnail
  // markup, so an unvalidated value here is a stored-XSS vector.
  if (typeof youtubeVideoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(youtubeVideoId)) {
    return res.status(400).json({ error: 'Invalid YouTube video ID' });
  }
  const { data, error } = await supabaseAdmin
    .from('videos')
    .insert({
      youtube_video_id: youtubeVideoId,
      title,
      duration_seconds: durationSeconds,
      points_reward: pointsReward ?? 10,
      quiz_bonus_points: quizBonusPoints ?? 5,
      active: false,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/admin/videos/:id', requireContentAdmin, async (req, res) => {
  const { title, durationSeconds, pointsReward, quizBonusPoints, active, featured } = req.body;
  const update = {};
  if (title !== undefined) update.title = title;
  if (durationSeconds !== undefined) update.duration_seconds = durationSeconds;
  if (pointsReward !== undefined) update.points_reward = pointsReward;
  if (quizBonusPoints !== undefined) update.quiz_bonus_points = quizBonusPoints;
  if (active === true) {
    const { count, error: questionErr } = await supabaseAdmin
      .from('video_questions')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', req.params.id);
    if (questionErr) return res.status(500).json({ error: questionErr.message });
    if (count !== 3) return res.status(400).json({ error: 'Add exactly 3 quiz questions before activating this video' });
    update.active = true;
  } else if (active !== undefined) {
    update.active = active;
  }
  if (featured === true) {
    const { data: video, error: videoErr } = await supabaseAdmin
      .from('videos')
      .select('active')
      .eq('id', req.params.id)
      .single();
    if (videoErr) return res.status(404).json({ error: 'Video not found' });
    const { count, error: questionErr } = await supabaseAdmin
      .from('video_questions')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', req.params.id);
    if (questionErr) return res.status(500).json({ error: questionErr.message });
    if (!video.active || count !== 3) {
      return res.status(400).json({ error: 'Activate the video and add exactly 3 quiz questions before featuring it' });
    }
    update.featured = true;
  } else if (featured !== undefined) {
    update.featured = false;
  }

  const { data, error } = await supabaseAdmin
    .from('videos')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// Pulls the channel's full upload list from the YouTube Data API and
// upserts it into our `videos` table. New videos get a default points value
// and start inactive (so an admin reviews + writes quiz questions before
// they go live); existing videos only get their title/duration refreshed —
// points_reward and active are never overwritten by a sync.
router.post('/admin/videos/sync-youtube', requireContentAdmin, async (req, res) => {
  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(400).json({ error: 'YOUTUBE_API_KEY is not set in .env' });
  }
  const defaultPointsReward = Number.isFinite(Number(req.body?.defaultPointsReward))
    ? Number(req.body.defaultPointsReward)
    : 15;
  if (!process.env.YOUTUBE_CHANNEL_ID && !process.env.YOUTUBE_CHANNEL_HANDLE) {
    return res.status(400).json({ error: 'Set YOUTUBE_CHANNEL_ID or YOUTUBE_CHANNEL_HANDLE in .env' });
  }

  const channelRef = {
    channelId: process.env.YOUTUBE_CHANNEL_ID,
    handle: process.env.YOUTUBE_CHANNEL_HANDLE,
  };

  try {
    const uploadsPlaylistId = await getUploadsPlaylistId(channelRef);
    const channelVideos = await fetchAllChannelVideos(uploadsPlaylistId);

    const { data: existing } = await supabaseAdmin.from('videos').select('id, youtube_video_id');
    const existingByYtId = new Map((existing || []).map((v) => [v.youtube_video_id, v.id]));

    let added = 0;
    let updated = 0;
    for (const v of channelVideos) {
      if (existingByYtId.has(v.youtubeVideoId)) {
        await supabaseAdmin
          .from('videos')
          .update({ title: v.title, duration_seconds: v.durationSeconds, published_at: v.publishedAt })
          .eq('youtube_video_id', v.youtubeVideoId);
        updated++;
      } else {
        const { data: inserted } = await supabaseAdmin.from('videos').insert({
          youtube_video_id: v.youtubeVideoId,
          title: v.title,
          duration_seconds: v.durationSeconds,
          published_at: v.publishedAt,
          points_reward: defaultPointsReward,
          active: false, // reviewed + activated manually once questions are added
        }).select('id').single();
        if (inserted) existingByYtId.set(v.youtubeVideoId, inserted.id);
        added++;
      }
    }

    // Mirror the channel's actual playlists, and which videos belong to each
    // one — lets the admin panel filter/group videos the same way the real
    // YouTube channel is organized, instead of one flat list.
    let playlistsSynced = 0;
    try {
      const channelPlaylists = await fetchChannelPlaylists(channelRef);
      for (const pl of channelPlaylists) {
        const { data: playlistRow } = await supabaseAdmin
          .from('playlists')
          .upsert({ youtube_playlist_id: pl.youtubePlaylistId, title: pl.title }, { onConflict: 'youtube_playlist_id' })
          .select('id')
          .single();
        if (!playlistRow) continue;

        const videoIds = await fetchPlaylistVideoIds(pl.youtubePlaylistId);
        const memberships = videoIds
          .map((ytId) => existingByYtId.get(ytId))
          .filter(Boolean)
          .map((videoId) => ({ video_id: videoId, playlist_id: playlistRow.id }));

        if (memberships.length) {
          await supabaseAdmin.from('video_playlists').upsert(memberships, { onConflict: 'video_id,playlist_id' });
        }
        playlistsSynced++;
      }
    } catch (playlistErr) {
      // Playlist sync failing shouldn't fail the whole video sync — videos
      // are the important part, playlists are an organizational bonus.
      console.error('Playlist sync failed (videos still synced fine):', playlistErr.message);
    }

    res.json({ added, updated, total: channelVideos.length, playlistsSynced });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replace all quiz questions for a video. Every rewarded video requires exactly
// three valid questions before it can be published for users.
router.put('/admin/videos/:id/questions', requireContentAdmin, async (req, res) => {
  const { questions } = req.body; // [{ question, options: [4 strings], correctIndex }, ...]
  if (!Array.isArray(questions) || questions.length !== 3) {
    return res.status(400).json({ error: 'Exactly 3 questions are required' });
  }
  if (questions.some((q) => (
    typeof q.question !== 'string' || !q.question.trim()
    || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4
    || q.options.some((option) => typeof option !== 'string' || !option.trim())
    || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length
  ))) {
    return res.status(400).json({ error: 'Each question needs 2-4 options and a valid correct answer' });
  }

  await supabaseAdmin.from('video_questions').delete().eq('video_id', req.params.id);

  const rows = questions.map((q, i) => ({
    video_id: req.params.id,
    position: i + 1,
    question: q.question,
    options: q.options,
    correct_index: q.correctIndex,
  }));
  const { data, error } = await supabaseAdmin.from('video_questions').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/admin/videos/:id/questions', requireContentAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('video_questions')
    .select('*')
    .eq('video_id', req.params.id)
    .order('position');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ---------- Watch sessions ----------

// Start (or resume) a watch session for a given video.
router.post('/session/start', requireAuth, async (req, res) => {
  const { videoId } = req.body;
  if (typeof videoId !== 'string' || videoId.length > 64) {
    return res.status(400).json({ error: 'Valid video id required' });
  }

  const accessDate = new Date().toISOString().slice(0, 10);
  const { data: access, error: accessErr } = await supabaseAdmin
    .from('daily_video_access')
    .select('video_id')
    .eq('user_id', req.userId)
    .eq('access_date', accessDate)
    .eq('video_id', videoId)
    .maybeSingle();
  if (accessErr) return res.status(500).json({ error: accessErr.message });
  if (!access) return res.status(403).json({ error: 'This video is not in your Explore selection for today' });

  const { data: video, error: videoErr } = await supabaseAdmin
    .from('videos').select('*').eq('id', videoId).eq('active', true).single();
  if (videoErr || !video) return res.status(404).json({ error: 'Video not found' });

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data: alreadyCompleted } = await supabaseAdmin
    .from('watch_sessions')
    .select('id')
    .eq('user_id', req.userId)
    .eq('video_id', videoId)
    .eq('status', 'completed')
    .gte('started_at', todayStart.toISOString())
    .maybeSingle();
  if (alreadyCompleted) return res.status(429).json({ error: 'Reward for this video already earned today' });

  // Resume an existing unfinished session for this video instead of starting over.
  const { data: existing } = await supabaseAdmin
    .from('watch_sessions')
    .select('*')
    .eq('user_id', req.userId)
    .eq('video_id', videoId)
    .in('status', ['in_progress', 'quiz_pending'])
    .maybeSingle();

  // The pool (5, or 8 with 5+ referrals) is how many videos show up to
  // choose from; the watch limit (3, or 5 with 5+ referrals) is how many
  // of those can actually be watched-and-earned-from per day. Resuming a
  // video already started today is never blocked here — only starting a
  // NEW one once today's watch limit is used up.
  if (!existing) {
    const { count: rewardedReferrals } = await supabaseAdmin
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('referrer_id', req.userId)
      .eq('status', 'rewarded');
    const watchLimit = (rewardedReferrals || 0) >= 5 ? 5 : 3;

    const { data: rewardedToday } = await supabaseAdmin
      .from('watch_sessions')
      .select('video_id')
      .eq('user_id', req.userId)
      .in('status', ['quiz_pending', 'completed'])
      .gte('started_at', todayStart.toISOString());
    const distinctRewardedCount = new Set((rewardedToday || []).map((r) => r.video_id)).size;

    if (distinctRewardedCount >= watchLimit) {
      const referralCount = rewardedReferrals || 0;
      const referralsNeeded = Math.max(0, 5 - referralCount);
      return res.status(429).json({
        error: watchLimit >= 5
          ? `You've reached today's watch limit of ${watchLimit} videos — come back tomorrow for more.`
          : `You've reached today's watch limit of ${watchLimit} videos. Refer ${referralsNeeded} more friend${referralsNeeded === 1 ? '' : 's'} to raise your daily limit to 5, or come back tomorrow.`,
        code: 'WATCH_LIMIT_REACHED',
        watchLimit,
        referralCount,
        referralsNeeded,
      });
    }
  }

  if (existing) {
    const sessionToken = jwt.sign(
      { userId: req.userId, videoId, sessionId: existing.id },
      SESSION_SECRET,
      { expiresIn: '2h' }
    );
    await supabaseAdmin.from('watch_sessions').update({ session_token: sessionToken }).eq('id', existing.id);
    return res.json({
      sessionId: existing.id,
      sessionToken,
      status: existing.status,
      resumeFromSeconds: existing.max_position_seconds,
    });
  }

  const sessionToken = jwt.sign({ userId: req.userId, videoId }, SESSION_SECRET, { expiresIn: '2h' });
  const { data: session, error: insertErr } = await supabaseAdmin
    .from('watch_sessions')
    .insert({ user_id: req.userId, video_id: videoId, session_token: sessionToken, ip_address: req.ip })
    .select('id')
    .single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  res.json({ sessionId: session.id, sessionToken, status: 'in_progress', resumeFromSeconds: 0 });
});

// Heartbeat: called every few seconds while the video is playing and the tab
// is visible. Two independent signals decide progress, both server-trusted:
//   1. Elapsed wall-clock time since the last heartbeat (clamped) — same as
//      before, mostly a sanity bound on how fast heartbeats can arrive.
//   2. The player's reported current position — but the server only ever
//      lets its OWN tracked max_position_seconds creep forward by a small,
//      fixed amount per heartbeat, regardless of what position is reported.
//      This is what actually prevents seeking ahead from working: dragging
//      the seek bar to the end doesn't move max_position_seconds there, so
//      the completion threshold can't be reached without real playback time.
router.post('/session/heartbeat', requireAuth, async (req, res) => {
  const { sessionToken, positionSeconds } = req.body;
  if (typeof sessionToken !== 'string' || sessionToken.length > 4096
    || !Number.isFinite(Number(positionSeconds)) || Number(positionSeconds) < 0) {
    return res.status(400).json({ error: 'Valid session token and position required' });
  }

  let payload;
  try {
    payload = jwt.verify(sessionToken, SESSION_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }
  if (payload.userId !== req.userId) return res.status(403).json({ error: 'Session does not belong to user' });

  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('watch_sessions')
    .select('*')
    .eq('session_token', sessionToken)
    .single();
  if (sessionErr || !session) return res.status(404).json({ error: 'Session not found' });

  if (session.status === 'quiz_pending' || session.status === 'completed') {
    return res.json({ status: session.status, positionSeconds: session.max_position_seconds });
  }

  const now = Date.now();
  const lastBeat = session.last_heartbeat_at
    ? new Date(session.last_heartbeat_at).getTime()
    : new Date(session.started_at).getTime();
  const deltaSec = Math.min(10, Math.max(0, Math.round((now - lastBeat) / 1000)));
  const newSecondsWatched = session.seconds_watched + deltaSec;

  const reportedPosition = Math.max(0, Number(positionSeconds) || 0);
  const allowedMax = session.max_position_seconds + MAX_POSITION_ADVANCE_PER_BEAT;
  const newMaxPosition = Math.max(session.max_position_seconds, Math.min(reportedPosition, allowedMax));

  const { data: video, error: videoErr } = await supabaseAdmin
    .from('videos').select('duration_seconds').eq('id', session.video_id).single();
  if (videoErr) return res.status(500).json({ error: videoErr.message });

  const reachedEnd = newMaxPosition >= video.duration_seconds * COMPLETION_THRESHOLD;

  if (reachedEnd) {
    await supabaseAdmin
      .from('watch_sessions')
      .update({
        seconds_watched: newSecondsWatched,
        max_position_seconds: newMaxPosition,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq('id', session.id);

    // Credits the base video reward right now — watching to the end is all
    // that's required for it. See complete_video_watch() in
    // supabase/migration_012_quiz_bonus_rework.sql; the quiz that follows
    // is a bonus layer on top, not a gate on this reward.
    const { data: creditResult, error: creditErr } = await supabaseAdmin.rpc('complete_video_watch', {
      p_session_id: session.id,
      p_user_id: req.userId,
    });
    if (creditErr) return res.status(500).json({ error: creditErr.message });

    return res.json({
      status: 'quiz_pending',
      positionSeconds: newMaxPosition,
      pointsEarned: creditResult?.pointsEarned || 0,
    });
  }

  await supabaseAdmin
    .from('watch_sessions')
    .update({
      seconds_watched: newSecondsWatched,
      max_position_seconds: newMaxPosition,
      last_heartbeat_at: new Date().toISOString(),
    })
    .eq('id', session.id);

  // Tell the frontend if the client's reported position is running away from
  // what we'll actually credit — it uses this to snap the player back.
  res.json({
    status: 'in_progress',
    positionSeconds: newMaxPosition,
    verifiedPositionSeconds: newMaxPosition,
  });
});

// Submit quiz answers for a session sitting in 'quiz_pending'. Grading and
// point-crediting happen atomically in the submit_quiz RPC — see
// supabase/migration_002_quiz_and_tracking.sql.
router.post('/session/:id/quiz', requireAuth, async (req, res) => {
  const { answers } = req.body; // [{ questionId, selectedIndex }, ...]
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 10
    || answers.some((answer) => typeof answer?.questionId !== 'string'
      || !Number.isInteger(answer.selectedIndex) || answer.selectedIndex < 0 || answer.selectedIndex > 3)) {
    return res.status(400).json({ error: 'answers array required' });
  }

  const { data, error } = await supabaseAdmin.rpc('submit_quiz', {
    p_session_id: req.params.id,
    p_user_id: req.userId,
    p_answers: answers.map((a) => ({ question_id: a.questionId, selected_index: a.selectedIndex })),
  });
  if (error) return res.status(400).json({ error: error.message });

  res.json(data);
});

export default router;
