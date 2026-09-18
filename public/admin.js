const state = { accessToken: null, role: null, videos: [], tasks: [], redemptionStatus: 'pending', playlists: [], sortNewestFirst: true, playlistFilter: '', videoStatusFilter: '', proofStatus: 'pending', videoQuery: '', videoPage: 0 };

const $ = (id) => document.getElementById(id);
let confirmResolver = null;

function requestAdminConfirmation(message) {
  const dialog = $('admin-confirm');
  $('admin-confirm-message').textContent = message;
  dialog.classList.remove('hidden');
  dialog.focus();
  return new Promise((resolve) => { confirmResolver = resolve; });
}

function closeAdminConfirmation(result) {
  $('admin-confirm').classList.add('hidden');
  if (confirmResolver) confirmResolver(result);
  confirmResolver = null;
}

$('admin-confirm-cancel').onclick = () => closeAdminConfirmation(false);
$('admin-confirm-accept').onclick = () => closeAdminConfirmation(true);
$('admin-confirm').onclick = (event) => { if (event.target === $('admin-confirm')) closeAdminConfirmation(false); };

// Keeps keyboard behavior correct for whichever dialog is open (the confirm
// prompt or the quiz editor) — Escape closes it via its own close button,
// and Tab is trapped inside it so a keyboard user can't tab through to page
// content hidden behind the overlay.
document.addEventListener('keydown', (event) => {
  const openDialog = [...document.querySelectorAll('[role="dialog"]')].find((el) => !el.classList.contains('hidden'));
  if (!openDialog) return;

  if (event.key === 'Escape') {
    openDialog.querySelector('.dialog-close-btn')?.click();
    return;
  }

  if (event.key === 'Tab') {
    const focusable = [...openDialog.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!openDialog.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }
});

async function adminApi(path, options = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error('The server is unavailable. Start the app and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showAdminToast(message, type = 'info') {
  const toast = $('admin-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `admin-toast ${type}`;
  clearTimeout(showAdminToast.timer);
  showAdminToast.timer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

// ---------- Admin sign-in ----------

$('key-form').onsubmit = async (e) => {
  e.preventDefault();
  $('key-error').textContent = '';
  const email = $('admin-email-input').value.trim();
  const password = $('admin-password-input').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Sign-in failed');
    state.accessToken = data.accessToken;
    unlockConsole();
  } catch (err) {
    $('key-error').textContent = err.message;
  }
};

async function unlockConsole() {
  $('key-gate').classList.add('hidden');
  $('console').classList.remove('hidden');
  try {
    await loadStats();
    await loadRoles();
    await loadVideos();
    await loadRedemptions();
    await loadAuditLog();
    await loadRewardTiers();
    startStatsPolling();
    updateNotifyButton();
  } catch (err) {
    $('key-gate').classList.remove('hidden');
    $('console').classList.add('hidden');
    $('key-error').textContent = err.message;
  }
}

// ---------- Nav ----------

document.querySelectorAll('.admin-nav-btn[data-panel]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.admin-nav-btn[data-panel]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-panel').forEach((p) => p.classList.add('hidden'));
    $(`panel-${btn.dataset.panel}`).classList.remove('hidden');
  };
});

document.querySelectorAll('.admin-nav-btn[data-status]').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.admin-nav-btn[data-status]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.redemptionStatus = btn.dataset.status;
    loadRedemptions();
  };
});

document.querySelectorAll('[data-open-panel]').forEach((btn) => {
  btn.onclick = () => document.querySelector(`.admin-nav-btn[data-panel="${btn.dataset.openPanel}"]`)?.click();
});

// ---------- Stats ----------

let statsPollTimer = null;

const DEFAULT_TITLE = document.title;
let lastKnownPendingRedemptions = null;

async function loadStats() {
  const stats = await adminApi('/admin/stats');
  state.role = stats.role;
  $('roles-nav-btn').classList.toggle('hidden', state.role !== 'admin');
  const tiles = [
    { label: 'Users', value: stats.userCount },
    { label: 'Points issued', value: stats.totalPointsIssued },
    { label: 'Videos completed', value: stats.completedWatches },
    { label: 'Pending redemptions', value: stats.pendingRedemptions, warn: stats.pendingRedemptions > 0 },
  ];
  $('stat-grid').innerHTML = tiles.map((t) => `
    <div class="stat-tile ${t.warn ? 'warn-tile' : ''}">
      <span class="value">${t.value}</span>
      <span class="label">${t.label}</span>
    </div>
  `).join('');

  $('dashboard-payout-alert').textContent = stats.pendingRedemptions
    ? `${stats.pendingRedemptions} payout request${stats.pendingRedemptions === 1 ? '' : 's'} need review`
    : 'No payout backlog';

  updateRedemptionNotifications(stats.pendingRedemptions || 0);
}

// Badge on the Payouts tab + browser tab title counter, so a new redemption
// request (someone waiting on real cash/airtime/data) is noticeable even if
// the admin panel is just sitting open in a background tab, not just on the
// Dashboard's alert card. Also fires a desktop notification the moment the
// pending count goes UP.
function updateRedemptionNotifications(pendingCount) {
  const badge = $('payouts-badge');
  badge.textContent = pendingCount;
  badge.classList.toggle('hidden', pendingCount === 0);
  document.title = pendingCount > 0 ? `(${pendingCount}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;

  if (lastKnownPendingRedemptions !== null && pendingCount > lastKnownPendingRedemptions) {
    notifyNewRedemption(pendingCount - lastKnownPendingRedemptions);
  }
  lastKnownPendingRedemptions = pendingCount;
}

function notifyNewRedemption(newCount) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('Watch & Earn — Admin', {
    body: `${newCount} new redemption request${newCount > 1 ? 's' : ''} (cash/airtime/data) waiting for review.`,
  });
}

function updateNotifyButton() {
  const btn = $('notify-btn');
  if (!('Notification' in window) || Notification.permission !== 'default') {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
}

$('notify-btn').onclick = async () => {
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    new Notification('Watch & Earn — Admin', { body: "You'll get notified here when new redemption requests come in." });
  }
  updateNotifyButton();
};

let visibilityListenerAttached = false;

function startStatsPolling() {
  clearInterval(statsPollTimer);
  statsPollTimer = setInterval(loadStats, 30000); // 30s — frequent enough to feel live, cheap enough to leave running

  // Pausing while the tab is hidden/backgrounded saves battery and mobile
  // data for no real loss — nothing changes while nobody's looking, and a
  // fresh loadStats() fires immediately on return anyway. Registered once
  // (not per-call) so logging out and back in doesn't stack duplicates.
  if (visibilityListenerAttached) return;
  visibilityListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearInterval(statsPollTimer);
    } else {
      loadStats();
      clearInterval(statsPollTimer);
      statsPollTimer = setInterval(loadStats, 30000);
    }
  });
}

// ---------- Videos ----------

$('video-form').onsubmit = async (e) => {
  e.preventDefault();
  $('video-message').textContent = '';
  try {
    await adminApi('/admin/videos', {
      method: 'POST',
      body: JSON.stringify({
        youtubeVideoId: $('v-yt-id').value.trim(),
        title: $('v-title').value.trim(),
        durationSeconds: Number($('v-duration').value),
        pointsReward: Number($('v-points').value),
        quizBonusPoints: Number($('v-quiz-bonus').value),
      }),
    });
    e.target.reset();
    $('v-points').value = 100;
    $('v-quiz-bonus').value = 3;
    $('video-message').textContent = 'Video added.';
    await loadVideos();
    await loadStats();
  } catch (err) {
    $('video-message').textContent = err.message;
  }
};

async function loadVideos() {
  $('video-table').innerHTML = '<p class="note">Loading…</p>';
  const [videos, playlists] = await Promise.all([
    adminApi('/admin/videos'),
    adminApi('/admin/playlists'),
  ]);
  state.videos = videos;
  state.playlists = playlists;
  const activeCount = videos.filter((video) => video.active).length;
  $('dashboard-content-alert').textContent = `${activeCount} published video${activeCount === 1 ? '' : 's'} in rotation`;
  populatePlaylistFilter();
  renderVideoTable();
}

function populatePlaylistFilter() {
  const select = $('playlist-filter');
  const currentValue = select.value;
  select.innerHTML = '<option value="">All videos</option>' +
    state.playlists.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join('');
  select.value = state.playlists.some((p) => p.id === currentValue) ? currentValue : '';
  state.playlistFilter = select.value;
}

function renderVideoTable() {
  const table = $('video-table');
  const PAGE_SIZE = 20;

  const activeCount = state.videos.filter((v) => v.active).length;
  const featuredCount = state.videos.filter((v) => v.featured).length;
  $('video-count-summary').textContent =
    `${state.videos.length} video${state.videos.length === 1 ? '' : 's'} total — ${activeCount} active (visible to users), ${featuredCount} featured on the landing page.`;

  let rows = state.videos;
  if (state.playlistFilter) {
    rows = rows.filter((v) => (v.playlists || []).some((p) => p.id === state.playlistFilter));
  }
  if (state.videoStatusFilter === 'active') rows = rows.filter((v) => v.active);
  if (state.videoStatusFilter === 'inactive') rows = rows.filter((v) => !v.active);
  if (state.videoStatusFilter === 'featured') rows = rows.filter((v) => v.featured);
  const query = state.videoQuery.trim().toLowerCase();
  rows = rows.filter((video) => !query || `${video.title} ${video.youtube_video_id}`.toLowerCase().includes(query));
  rows = [...rows].sort((a, b) => {
    const aTime = a.published_at ? new Date(a.published_at).getTime() : 0;
    const bTime = b.published_at ? new Date(b.published_at).getTime() : 0;
    return state.sortNewestFirst ? bTime - aTime : aTime - bTime;
  });

  if (!rows.length) {
    table.innerHTML = `<p class="note">${state.videos.length ? 'No videos match this filter.' : 'No videos yet — add one above.'}</p>`;
    return;
  }

  // Rendering all 100+ synced videos into the DOM at once gets sluggish,
  // especially on lower-end phones — page through them instead. Search and
  // the playlist filter apply first, so this paginates the filtered result,
  // not the whole library.
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.videoPage = Math.min(state.videoPage || 0, totalPages - 1);
  const pageRows = rows.slice(state.videoPage * PAGE_SIZE, (state.videoPage + 1) * PAGE_SIZE);

  table.innerHTML = pageRows.map((v) => {
    // Validate before use in a src attribute — even with the backend now
    // rejecting malformed IDs at creation time, this stays defensive
    // against any data already in the database from before that fix.
    const safeVideoId = /^[A-Za-z0-9_-]{11}$/.test(v.youtube_video_id || '') ? v.youtube_video_id : '';
    return `
    <div class="admin-row has-thumb ${v.active ? '' : 'inactive'}">
      <img class="admin-row-thumb" src="${safeVideoId ? `https://i.ytimg.com/vi/${safeVideoId}/default.jpg` : ''}" alt="" loading="lazy">
      <div>
        <div class="primary">${escapeHtml(v.title)}</div>
        <div class="secondary">
          ${escapeHtml(v.youtube_video_id)} · ${v.duration_seconds}s · +${v.quiz_bonus_points ?? 5} pts/correct${v.published_at ? ' · ' + new Date(v.published_at).toLocaleDateString() : ''}
          ${(v.playlists || []).map((p) => `<span class="playlist-badge">${escapeHtml(p.title)}</span>`).join('')}
        </div>
      </div>
      <input type="number" class="pts-input" min="0" value="${v.points_reward}" data-id="${v.id}">
      <span></span>
      <div class="row-actions">
        <button class="btn-ghost quiz-manage-btn" data-id="${v.id}" data-title="${escapeHtml(v.title)}">Quiz</button>
        <button class="pill-toggle ${v.active ? 'active-state' : 'inactive-state'}" data-id="${v.id}" data-active="${v.active}">
          ${v.active ? 'Active' : 'Inactive'}
        </button>
        <button class="pill-toggle ${v.featured ? 'active-state' : ''} feature-toggle" data-id="${v.id}" data-featured="${v.featured}">
          ${v.featured ? 'Featured' : 'Feature'}
        </button>
      </div>
    </div>
  `;
  }).join('') + (totalPages > 1 ? `
    <div class="pagination-controls">
      <button type="button" class="btn-ghost" id="video-page-prev" ${state.videoPage === 0 ? 'disabled' : ''}>Prev</button>
      <span class="note">Page ${state.videoPage + 1} of ${totalPages} (${rows.length} video${rows.length === 1 ? '' : 's'})</span>
      <button type="button" class="btn-ghost" id="video-page-next" ${state.videoPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
    </div>
  ` : '');

  $('video-page-prev')?.addEventListener('click', () => { state.videoPage--; renderVideoTable(); });
  $('video-page-next')?.addEventListener('click', () => { state.videoPage++; renderVideoTable(); });

  table.querySelectorAll('.pill-toggle').forEach((btn) => {
    btn.onclick = async () => {
      if (btn.classList.contains('feature-toggle')) {
        await adminApi(`/admin/videos/${btn.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ featured: btn.dataset.featured !== 'true' }),
        });
        await loadVideos();
        return;
      }
      const nowActive = btn.dataset.active !== 'true';
      await adminApi(`/admin/videos/${btn.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: nowActive }),
      });
      await loadVideos();
    };
  });

  table.querySelectorAll('.pts-input').forEach((input) => {
    input.onchange = async () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      input.disabled = true;
      try {
        await adminApi(`/admin/videos/${input.dataset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ pointsReward: value }),
        });
        const video = state.videos.find((v) => v.id === input.dataset.id);
        if (video) video.points_reward = value;
      } catch (err) {
        showAdminToast(err.message, 'error');
      }
      input.disabled = false;
    };
  });

  table.querySelectorAll('.quiz-manage-btn').forEach((btn) => {
    btn.onclick = () => openQuizEditor(btn.dataset.id, btn.dataset.title);
  });
}

$('sort-toggle-btn').onclick = () => {
  state.sortNewestFirst = !state.sortNewestFirst;
  $('sort-toggle-btn').textContent = state.sortNewestFirst ? 'Newest first' : 'Oldest first';
  renderVideoTable();
};

$('playlist-filter').onchange = () => {
  state.playlistFilter = $('playlist-filter').value;
  state.videoPage = 0;
  renderVideoTable();
};

$('video-status-filter').onchange = () => {
  state.videoStatusFilter = $('video-status-filter').value;
  state.videoPage = 0;
  renderVideoTable();
};

$('video-search').oninput = (event) => {
  state.videoQuery = event.target.value;
  state.videoPage = 0;
  renderVideoTable();
};

// ---------- Redemptions ----------

async function loadRedemptions() {
  const table = $('redemption-table');
  table.innerHTML = '<p class="note">Loading…</p>';
  const rows = await adminApi(`/admin/redemptions?status=${state.redemptionStatus}`);
  if (!rows.length) {
    table.innerHTML = '<p class="note">No redemption requests here.</p>';
    return;
  }
  table.innerHTML = rows.map((r) => `
    <div class="admin-row">
      <div>
        <div class="primary">${escapeHtml(r.email || 'Unknown user')}</div>
        <div class="secondary">${r.reward_amount_label ? escapeHtml(r.reward_amount_label) : escapeHtml(r.reward_type.replace('_', ' '))} · requested ${new Date(r.created_at).toLocaleDateString()}</div>
        <div class="admin-destination">Destination: <strong>${escapeHtml(r.destination)}</strong></div>
        ${r.payouts?.failure_message ? `<div class="admin-failure">Failure: ${escapeHtml(r.payouts.failure_message)}</div>` : ''}
      </div>
      <span class="pts">${r.points_spent} pts</span>
      <span class="secondary">${r.status}${r.payouts?.status ? ` · payout ${r.payouts.status}` : ''}</span>
      ${r.status === 'pending' ? `
        <div class="row-actions">
          ${r.payouts?.status === 'failed' ? '<button class="btn-approve payout-retry-btn" data-id="' + r.id + '">Retry payout</button>' : ''}
          <button class="btn-approve" data-id="${r.id}" data-action="fulfilled">Fulfill</button>
          <button class="btn-reject" data-id="${r.id}" data-action="rejected">Reject</button>
        </div>
      ` : '<span></span>'}
    </div>
  `).join('');

  table.querySelectorAll('.btn-approve, .btn-reject').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const action = btn.dataset.action === 'fulfilled' ? 'fulfill this redemption' : 'reject this redemption';
        if (!await requestAdminConfirmation(`Are you sure you want to ${action}?`)) {
          btn.disabled = false;
          return;
        }
        await adminApi(`/admin/redemptions/${btn.dataset.id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ status: btn.dataset.action }),
        });
        showAdminToast(btn.dataset.action === 'fulfilled' ? 'Redemption marked fulfilled.' : 'Redemption rejected and refunded.', 'success');
        await loadRedemptions();
        await loadStats();
      } catch (err) {
        showAdminToast(err.message, 'error');
        btn.disabled = false;
      }
    };
  });

  table.querySelectorAll('.payout-retry-btn').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await adminApi('/admin/payouts/process', { method: 'POST' });
        showAdminToast('Queued payout retry started.', 'success');
        await loadRedemptions();
      } catch (err) {
        showAdminToast(err.message, 'error');
        btn.disabled = false;
      }
    };
  });
}

async function loadAuditLog() {
  const table = $('audit-table');
  table.innerHTML = '<p class="note">Loading…</p>';
  try {
    const rows = await adminApi('/admin/audit-log');
    table.innerHTML = rows.length
      ? rows.map((row) => `<div class="admin-row audit-row"><div><div class="primary">${escapeHtml(row.action.replaceAll('_', ' '))}</div><div class="secondary">${escapeHtml(row.entity_type)} · ${escapeHtml(row.admin_user_id)}</div></div><span class="secondary">${new Date(row.created_at).toLocaleString()}</span></div>`).join('')
      : '<p class="note">No payout actions recorded yet.</p>';
  } catch (err) {
    table.innerHTML = `<p class="note error">Audit history unavailable: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadRewardTiers() {
  const table = $('reward-tier-table');
  table.innerHTML = '<p class="note">Loading…</p>';
  const tiers = await adminApi('/admin/reward-tiers');

  table.innerHTML = `
    <div class="admin-row reward-tier-header">
      <span class="secondary">Points</span>
      <span class="secondary">Airtime (GHS)</span>
      <span class="secondary">Data (GHS)</span>
      <span class="secondary">Cash (GHS)</span>
    </div>
  ` + tiers.map((t) => `
    <div class="admin-row reward-tier-row" data-id="${t.id}">
      <div class="tier-field" data-label="Points"><span class="primary">${t.points_required.toLocaleString()}</span></div>
      <div class="tier-field" data-label="Airtime (GHS)"><input type="number" step="0.01" min="0" class="reward-tier-input" data-field="airtimeGhs" value="${t.airtime_ghs ?? ''}" placeholder="—"></div>
      <div class="tier-field" data-label="Data (GHS)"><input type="number" step="0.01" min="0" class="reward-tier-input" data-field="dataGhs" value="${t.data_ghs ?? ''}" placeholder="—"></div>
      <div class="tier-field" data-label="Cash (GHS)"><input type="number" step="0.01" min="0" class="reward-tier-input" data-field="cashGhs" value="${t.cash_ghs ?? ''}" placeholder="—"></div>
    </div>
  `).join('');

  table.querySelectorAll('.reward-tier-input').forEach((input) => {
    input.onchange = async () => {
      const id = input.closest('.reward-tier-row').dataset.id;
      const field = input.dataset.field;
      const value = input.value === '' ? null : Number(input.value);
      input.disabled = true;
      try {
        await adminApi(`/admin/reward-tiers/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ [field]: value }),
        });
        showAdminToast('Reward tier updated.', 'success');
      } catch (err) {
        showAdminToast(err.message, 'error');
      }
      input.disabled = false;
    };
  });
}

$('process-payouts-btn').onclick = async () => {
  $('process-payouts-btn').disabled = true;
  $('payout-message').textContent = 'Processing…';
  try {
    const result = await adminApi('/admin/payouts/process', { method: 'POST' });
    $('payout-message').textContent = `${result.processed} payout(s) processed.`;
    await loadRedemptions();
    await loadStats();
  } catch (err) {
    $('payout-message').textContent = err.message;
  }
  $('process-payouts-btn').disabled = false;
};

$('role-form').onsubmit = async (event) => {
  event.preventDefault();
  try {
    await adminApi('/admin/roles', {
      method: 'POST',
      body: JSON.stringify({ userId: $('role-user-id').value.trim(), role: $('role-name').value }),
    });
    $('role-message').textContent = 'Role granted.';
    $('role-user-id').value = '';
    await loadRoles();
  } catch (err) {
    $('role-message').textContent = err.message;
  }
};

async function loadRoles() {
  if (state.role !== 'admin') return;
  $('role-table').innerHTML = '<p class="note">Loading…</p>';
  const roles = await adminApi('/admin/roles');
  $('role-table').innerHTML = roles.map((role) => `
    <div class="admin-row"><div><div class="primary">${escapeHtml(role.user_id)}</div><div class="secondary">${escapeHtml(role.role)}</div></div><span class="secondary">${new Date(role.created_at).toLocaleDateString()}</span></div>
  `).join('') || '<p class="note">No admin roles configured.</p>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- YouTube sync ----------

$('sync-youtube-btn').onclick = async () => {
  $('sync-youtube-btn').disabled = true;
  $('sync-message').textContent = 'Syncing…';
  try {
    const result = await adminApi('/admin/videos/sync-youtube', { method: 'POST' });
    $('sync-message').textContent = `Done — ${result.added} added, ${result.updated} updated.`;
    await loadVideos();
    await loadStats();
  } catch (err) {
    $('sync-message').textContent = err.message;
  }
  $('sync-youtube-btn').disabled = false;
};

// ---------- Quiz editor ----------

const BLANK_QUESTION = { question: '', options: ['', '', '', ''], correctIndex: 0 };

function openQuizEditor(videoId, title) {
  $('quiz-editor-overlay').classList.remove('hidden');
  $('quiz-editor-title').textContent = `Quiz questions — ${title}`;
  $('quiz-editor-message').textContent = 'Loading…';
  $('quiz-editor-questions').innerHTML = '';
  $('quiz-editor-save').dataset.videoId = videoId;

  adminApi(`/admin/videos/${videoId}/questions`)
    .then((existing) => {
      const questions = [0, 1, 2].map((i) => existing[i]
        ? { question: existing[i].question, options: existing[i].options, correctIndex: existing[i].correct_index }
        : { ...BLANK_QUESTION, options: [...BLANK_QUESTION.options] });
      renderQuizEditorForm(questions);
      $('quiz-editor-message').textContent = '';
    })
    .catch((err) => { $('quiz-editor-message').textContent = err.message; });
}

function renderQuizEditorForm(questions) {
  $('quiz-editor-questions').innerHTML = questions.map((q, qi) => `
    <div class="quiz-editor-question" data-index="${qi}">
      <label>Question ${qi + 1}
        <input type="text" class="qe-question" value="${escapeHtml(q.question)}" placeholder="e.g. What city did they move to?">
      </label>
      <div class="qe-options">
        ${q.options.map((opt, oi) => `
          <label class="qe-option-row">
            <input type="radio" name="qe-correct-${qi}" value="${oi}" ${q.correctIndex === oi ? 'checked' : ''}>
            <input type="text" class="qe-option" value="${escapeHtml(opt)}" placeholder="Option ${oi + 1}">
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

$('quiz-editor-close').onclick = () => $('quiz-editor-overlay').classList.add('hidden');

$('quiz-editor-save').onclick = async () => {
  const videoId = $('quiz-editor-save').dataset.videoId;
  $('quiz-editor-message').textContent = '';

  const blocks = [...document.querySelectorAll('.quiz-editor-question')];
  const questions = blocks.map((block) => {
    const question = block.querySelector('.qe-question').value.trim();
    const optionInputs = [...block.querySelectorAll('.qe-option')];
    const options = optionInputs.map((o) => o.value.trim()).filter(Boolean);
    const checkedRadio = block.querySelector('input[type=radio]:checked');
    const correctIndex = checkedRadio ? Number(checkedRadio.value) : 0;
    return { question, options, correctIndex };
  });

  for (const q of questions) {
    if (!q.question || q.options.length < 2 || q.options.length > 4 || q.correctIndex >= q.options.length) {
      $('quiz-editor-message').textContent = 'Every video requires 3 questions. Each needs text, 2-4 options, and one correct answer.';
      return;
    }
  }

  try {
    await adminApi(`/admin/videos/${videoId}/questions`, {
      method: 'PUT',
      body: JSON.stringify({ questions }),
    });
    $('quiz-editor-message').textContent = 'Saved. This video will now show a quiz at the end.';
  } catch (err) {
    $('quiz-editor-message').textContent = err.message;
  }
};
