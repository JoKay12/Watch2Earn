import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireContentAdmin } from '../middleware/authMiddleware.js';
import { getUploadsPlaylistId, fetchAllChannelVideos, fetchChannelPlaylists, fetchPlaylistVideoIds } from '../lib/youtube.js';

const router = Router();

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

export default router;
