// Thin wrapper around the YouTube Data API v3 — used only by the admin
// "sync channel videos" action, never called on a per-user page load (to
// stay well within the API's free daily quota).

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const API_BASE = 'https://www.googleapis.com/youtube/v3';

// Converts an ISO 8601 duration like "PT4M13S" into whole seconds.
export function parseIsoDuration(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

async function ytFetch(path, params) {
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('key', YOUTUBE_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `YouTube API error (${res.status})`);
  return data;
}

// Resolves a channel handle (e.g. "DommyStudios") or raw channel ID into its
// "uploads" playlist ID — every channel has exactly one of these, and it
// contains every public video the channel has uploaded, in order.
export async function getUploadsPlaylistId({ channelId, handle }) {
  const params = channelId
    ? { part: 'contentDetails', id: channelId }
    : { part: 'contentDetails', forHandle: handle.replace(/^@/, '') };
  const data = await ytFetch('channels', params);
  const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error('Could not find that channel — check YOUTUBE_CHANNEL_ID or YOUTUBE_CHANNEL_HANDLE');
  return uploads;
}

// Fetches every video in a playlist (paginated), then a second call to fill
// in each video's duration and publish date (playlistItems doesn't include
// duration, and its own "published" field is when it was added to the
// playlist, not the video's actual upload date).
export async function fetchAllChannelVideos(uploadsPlaylistId) {
  const videos = [];
  let pageToken;

  do {
    const data = await ytFetch('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items || []) {
      videos.push({
        youtubeVideoId: item.contentDetails.videoId,
        title: item.snippet.title,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  // videos.list accepts up to 50 IDs per call
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const data = await ytFetch('videos', {
      part: 'contentDetails,snippet',
      id: batch.map((v) => v.youtubeVideoId).join(','),
    });
    for (const item of data.items || []) {
      const match = batch.find((v) => v.youtubeVideoId === item.id);
      if (match) {
        match.durationSeconds = parseIsoDuration(item.contentDetails.duration);
        match.publishedAt = item.snippet.publishedAt;
      }
    }
  }

  return videos.filter((v) => v.durationSeconds > 0);
}

// Fetches every playlist on the channel (paginated). Excludes the "uploads"
// playlist itself since every video is already in that one by definition —
// only the channel's own custom playlists (series, categories, etc.) are
// useful to mirror here.
export async function fetchChannelPlaylists({ channelId, handle }) {
  const params = channelId
    ? { part: 'snippet', channelId, maxResults: 50 }
    : { part: 'snippet', channelId: await resolveChannelId({ channelId, handle }), maxResults: 50 };

  const playlists = [];
  let pageToken;
  do {
    const data = await ytFetch('playlists', { ...params, ...(pageToken ? { pageToken } : {}) });
    for (const item of data.items || []) {
      playlists.push({ youtubePlaylistId: item.id, title: item.snippet.title });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return playlists;
}

// Fetches just the video IDs in a given playlist (paginated) — used to build
// the video<->playlist membership mapping after playlists are known.
export async function fetchPlaylistVideoIds(youtubePlaylistId) {
  const ids = [];
  let pageToken;
  do {
    const data = await ytFetch('playlistItems', {
      part: 'contentDetails',
      playlistId: youtubePlaylistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const item of data.items || []) ids.push(item.contentDetails.videoId);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function resolveChannelId({ channelId, handle }) {
  if (channelId) return channelId;
  const data = await ytFetch('channels', { part: 'id', forHandle: handle.replace(/^@/, '') });
  const id = data.items?.[0]?.id;
  if (!id) throw new Error('Could not resolve channel handle to an ID');
  return id;
}
