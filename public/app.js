import { state, REDEMPTION_TIER, METER_CIRC, WATCH_CIRC, setAccessToken, accessToken } from './modules/app-state.js';
import { $, escapeHtml, showToast, setButtonBusy } from './modules/app-ui.js';
import { api, registerHeartbeatStopper } from './modules/app-api.js';
import { renderRedeemTiers, renderRedemptions, renderLedger, initRewards } from './modules/app-rewards.js';

localStorage.removeItem('watch2earn_access_token');

const referralFromUrl = new URLSearchParams(window.location.search).get('ref');
if (referralFromUrl && $('register-referral')) $('register-referral').value = referralFromUrl.trim().slice(0, 32);

async function loadFeaturedVideos() {
  const grid = $('featured-video-grid');
  grid.innerHTML = '<p class="note">Loading…</p>';
  try {
    const response = await fetch('/api/featured-videos');
    const videos = await response.json().catch(() => []);
    if (!response.ok) throw new Error('Featured videos unavailable');
    if (!videos.length) {
      grid.innerHTML = '<p class="note featured-empty-state">New featured videos are coming soon. Create an account to explore the full channel.</p>';
      return;
    }
    grid.innerHTML = videos.map((video) => `
      <a class="featured-video-card" href="#auth-panel" data-cta="register" aria-label="Sign up to watch: ${escapeHtml(video.title)}">
        <div class="featured-thumbnail">
          <img src="https://i.ytimg.com/vi/${encodeURIComponent(video.youtube_video_id)}/hqdefault.jpg" alt="${escapeHtml(video.title)} video thumbnail" loading="lazy">
          <span class="featured-play" aria-hidden="true">▶</span>
        </div>
        <div class="featured-video-copy">
          <span class="featured-video-name">${escapeHtml(video.title)}</span>
          <span class="featured-video-cta">Sign up to watch &amp; earn · +${video.points_reward} pts</span>
        </div>
      </a>
    `).join('');
    grid.querySelectorAll('[data-cta]').forEach((el) => {
      el.onclick = (event) => {
        event.preventDefault();
        switchTab('register');
        $('auth-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
  } catch {
    grid.innerHTML = '<p class="note error featured-empty-state">Featured videos are temporarily unavailable. Please try again later.</p>';
  }
}

loadFeaturedVideos();

// Shows the real current minimum redemption tier on the landing page,
// rather than a hardcoded figure that goes stale the moment an admin
// changes the reward tiers. The markup already has a correct-as-of-today
// fallback value, so this only needs to succeed to stay accurate — no
// harm if it fails silently for a logged-out visitor.
(async function loadMinRedemption() {
  const el = $('min-redemption-value');
  if (!el) return;
  try {
    const response = await fetch('/api/reward-tiers');
    const tiers = await response.json().catch(() => []);
    if (!response.ok || !tiers.length) return;
    const minPoints = Math.min(...tiers.map((t) => t.points_required));
    el.textContent = `${minPoints.toLocaleString()} pts`;
  } catch {
    // Static fallback in the HTML stays as-is — fine for a landing page.
  }
})();

// ---------- Auth ----------

let supabaseClient = null;
let lastReferralTrigger = null;
let lastQuizTrigger = null;

// Applies a fresh Supabase session (from login/register, an OAuth redirect,
// or an automatic background refresh) to app state. Supabase rotates the
// refresh token on every refresh, so a "remembered" one in localStorage has
// to be kept in sync here too, or it would go stale after the first refresh.
function handleSupabaseSession(session) {
  if (!session?.access_token) return;
  setAccessToken(session.access_token);
  if (session.refresh_token && localStorage.getItem('watch2earn_remembered_refresh_token')) {
    localStorage.setItem('watch2earn_remembered_refresh_token', session.refresh_token);
  }
}

async function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  const res = await fetch('/api/config');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  if (!window.supabase) throw new Error('Google sign-in is temporarily unavailable — check your connection and reload.');
  // persistSession is off: this app manages its own opt-in "remember me"
  // (see establishInitialSession/login below) instead of always silently
  // resuming whatever Supabase last stored. autoRefreshToken stays ON so a
  // tab left open keeps a valid access token via the refresh token, instead
  // of the access token quietly dying after Supabase's ~1h expiry — which
  // is what used to make /ledger, /redemptions, etc. start failing with
  // "Invalid or expired session" mid-session with no way to recover short
  // of a full page reload.
  supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true },
  });
  supabaseClient.auth.onAuthStateChange((_event, session) => handleSupabaseSession(session));
  return supabaseClient;
}

$('tab-login').onclick = () => switchTab('login');
$('tab-register').onclick = () => switchTab('register');
$('forgot-password-link').onclick = () => switchTab('forgot');
$('back-to-login-link').onclick = () => switchTab('login');

function switchTab(which) {
  $('tab-login').classList.toggle('active', which === 'login');
  $('tab-register').classList.toggle('active', which === 'register');
  $('login-form').classList.toggle('hidden', which !== 'login');
  $('register-form').classList.toggle('hidden', which !== 'register');
  $('forgot-form').classList.toggle('hidden', which !== 'forgot');
  $('auth-error').textContent = '';
  $('auth-error').style.color = '';

  if (which === 'register') {
    $('auth-branding-title').innerHTML = 'Start watching.<br><em>Start earning.</em>';
    $('auth-branding-sub').textContent = 'Create a free account to unlock videos, complete quick quizzes, and redeem points for cash, airtime, or data.';
  } else {
    $('auth-branding-title').innerHTML = 'Welcome back!<br><em>Keep earning.</em>';
    $('auth-branding-sub').textContent = 'Your rewards are waiting. Sign in to continue watching and earning cash, airtime, and data bundles.';
  }
}

// Password show/hide toggles (used on login + register forms)
document.querySelectorAll('.password-toggle').forEach((btn) => {
  btn.onclick = () => {
    const input = $(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  };
});

$('forgot-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    const data = await api('/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: $('forgot-email').value }),
    });
    $('auth-error').style.color = 'var(--mint)';
    $('auth-error').textContent = data.message;
  } catch (err) {
    $('auth-error').style.color = '';
    $('auth-error').textContent = err.message;
  }
};

$('google-btn').onclick = async () => {
  try {
    const sb = await getSupabaseClient();
    await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/' },
    });
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
};

// Runs once on page load, in strict order: check for a fresh Google OAuth
// return FIRST, and only fall back to a remembered session if that didn't
// apply. These used to be two separate, uncoordinated pieces of code — a
// stale "remembered" token could win the race and overwrite a fresh Google
// session before it finished resolving, which is what caused Google
// sign-in to silently fail and bounce back to the landing page.
(async function establishInitialSession() {
  let handledByOAuth = false;
  try {
    const sb = await getSupabaseClient();
    const isGoogleReturn = window.location.hash.includes('access_token=');
    if (isGoogleReturn) {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        // Keep this session live in the client (rather than discarding it)
        // so autoRefreshToken can keep it valid for the rest of the visit —
        // previously it was thrown away right after being read, which is
        // why Google-authenticated sessions went stale after an hour too.
        handleSupabaseSession(session);
        history.replaceState(null, '', window.location.pathname + window.location.search);
        await boot();
        handledByOAuth = true;
      }
    }
  } catch {
    // Supabase client library didn't load — email/password login still works,
    // Google sign-in just won't be available this session.
  }

  // If "Remember me" was checked at an earlier login, use the saved refresh
  // token to mint a brand-new access token — this session then stays alive
  // on its own via autoRefreshToken for as long as the refresh token is
  // valid (weeks), rather than the old approach of replaying a raw access
  // token that was already stale within an hour. Skipped entirely when a
  // fresh OAuth session just took over.
  if (!handledByOAuth) {
    const rememberedRefreshToken = localStorage.getItem('watch2earn_remembered_refresh_token');
    if (rememberedRefreshToken && !accessToken) {
      try {
        const sb = await getSupabaseClient();
        const { data, error } = await sb.auth.refreshSession({ refresh_token: rememberedRefreshToken });
        if (error || !data.session) throw error || new Error('No session returned');
        handleSupabaseSession(data.session);
        await boot();
      } catch {
        // Refresh token expired or was revoked elsewhere — don't keep
        // retrying it on every future visit.
        localStorage.removeItem('watch2earn_remembered_refresh_token');
      }
    }
  }
})();

$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const submitButton = $('login-form').querySelector('button[type="submit"]');
  setButtonBusy(submitButton, true, 'Signing in...');
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('login-email').value, password: $('login-password').value }),
    });
    if (data.refreshToken) {
      // Hands the refresh token to the Supabase client so it can keep this
      // session alive on its own — see getSupabaseClient() for why.
      const sb = await getSupabaseClient();
      await sb.auth.setSession({ access_token: data.accessToken, refresh_token: data.refreshToken });
    } else {
      setAccessToken(data.accessToken);
    }
    // Remembering here means "restore this session (via its refresh token)
    // if the tab is reopened" — it lasts as long as the refresh token
    // stays valid (weeks), not just the ~1h access token.
    if ($('login-remember').checked && data.refreshToken) {
      localStorage.setItem('watch2earn_remembered_refresh_token', data.refreshToken);
    } else {
      localStorage.removeItem('watch2earn_remembered_refresh_token');
    }
    await boot();
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    setButtonBusy(submitButton, false);
  }
};

$('register-form').onsubmit = async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  const submitButton = $('register-form').querySelector('button[type="submit"]');
  setButtonBusy(submitButton, true, 'Creating account...');
  try {
    const data = await api('/register', {
      method: 'POST',
      body: JSON.stringify({
        email: $('register-email').value,
        password: $('register-password').value,
        referralCode: $('register-referral').value || undefined,
      }),
    });
    if (!data.accessToken) {
      $('auth-error').textContent = data.message || 'Check your email to confirm your account, then log in.';
      switchTab('login');
      return;
    }
    if (data.refreshToken) {
      const sb = await getSupabaseClient();
      await sb.auth.setSession({ access_token: data.accessToken, refresh_token: data.refreshToken });
    } else {
      setAccessToken(data.accessToken);
    }
    await boot();
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    setButtonBusy(submitButton, false);
  }
};

// Sidebar collapse — persists across visits. First-time visitors on a
// tablet-width screen (no space for a full sidebar, but wide enough that
// the phone bottom-bar layout doesn't kick in) default to collapsed; wider
// desktop visitors default to expanded. Either way, once someone actually
// clicks the toggle, their choice is remembered from then on.
(function initSidebarCollapse() {
  const saved = localStorage.getItem('sidebarCollapsed');
  const collapsed = saved !== null ? saved === 'true' : window.innerWidth < 1024;
  $('sidebar').classList.toggle('collapsed', collapsed);
  $('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
})();

$('sidebar-toggle').onclick = () => {
  const collapsed = $('sidebar').classList.toggle('collapsed');
  localStorage.setItem('sidebarCollapsed', String(collapsed));
  $('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
};

// Mobile-only "More" menu — a small popup for the lower-frequency
// destinations (Profile, Watched History, Community, Log out) that don't
// fit directly in the 4-item bottom bar without crowding it.
function closeMobileMoreMenu() {
  $('mobile-more-menu').classList.add('hidden');
  $('mobile-more-btn').setAttribute('aria-expanded', 'false');
}
$('mobile-more-btn').onclick = (event) => {
  event.stopPropagation();
  const nowHidden = $('mobile-more-menu').classList.toggle('hidden');
  $('mobile-more-btn').setAttribute('aria-expanded', String(!nowHidden));
};
$('mobile-more-menu').addEventListener('click', closeMobileMoreMenu);
document.addEventListener('click', (event) => {
  if (!$('mobile-more-menu').classList.contains('hidden') && !$('mobile-more-menu').contains(event.target) && event.target !== $('mobile-more-btn')) {
    closeMobileMoreMenu();
  }
});

async function handleLogout() {
  try { await api('/logout', { method: 'POST' }); } catch { /* token may already be invalid — fine */ }
  setAccessToken(null);
  localStorage.removeItem('watch2earn_remembered_refresh_token');
  try {
    const sb = await getSupabaseClient();
    await sb.auth.signOut({ scope: 'local' });
  } catch { /* email/password sign-ins do not need the OAuth client to log out */ }
  stopHeartbeat();
  state.user = null;
  $('app-panel').classList.add('hidden');
  $('landing-panel').classList.remove('hidden');
  document.body.classList.remove('is-authed');
}

$('logout-btn').onclick = handleLogout;
$('mobile-more-logout').onclick = handleLogout;

// Hero / topbar / footer / featured-video CTAs
document.querySelectorAll('[data-cta]').forEach((el) => {
  el.onclick = (e) => {
    e.preventDefault();
    switchTab(el.dataset.cta === 'register' ? 'register' : 'login');
    $('auth-panel').classList.remove('hidden');
    document.body.classList.add('dialog-open');
  };
});

$('auth-close-btn').onclick = () => {
  $('auth-panel').classList.add('hidden');
  document.body.classList.remove('dialog-open');
};

// ---------- Sidebar navigation ----------

document.querySelectorAll('.side-nav-btn:not(.side-nav-parent):not(.mobile-more-btn)').forEach((btn) => {
  btn.onclick = () => switchPage(btn.dataset.page);
});

document.querySelectorAll('.side-nav-subbtn').forEach((btn) => {
  btn.onclick = () => switchPage(btn.dataset.page);
});

function switchPage(page) {
  if (page !== 'explore') pauseActivePlayerIfPlaying();
  $('referral-share-panel')?.classList.add('hidden');
  $('quiz-panel')?.classList.add('hidden');
  document.body.classList.remove('dialog-open');
  document.querySelectorAll('.side-nav-btn:not(.side-nav-parent)').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.side-nav-subbtn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));

  document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
  $(`page-${page}`).classList.remove('hidden');

  if (page === 'explore') renderExploreVideos();
  if (page === 'history') renderWatchHistory();
  if (page === 'profile') renderProfile();
  if (page === 'rewards') { renderRedeemTiers(); renderRedemptions(); renderLedger(); }
  if (page === 'dashboard') renderDashboard();
}

// Keeps keyboard behavior correct for whichever dialog is currently open —
// Escape closes it via its own close button (so each dialog's existing
// close logic, like restoring focus to whatever triggered it, still runs),
// and Tab is trapped inside it so a keyboard user can't tab "through" the
// modal into page content that's visually hidden behind the overlay.
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
      // Focus somehow already isn't inside the dialog — pull it back in
      // rather than letting Tab move it further away.
      event.preventDefault();
      first.focus();
    }
  }
});

// ---------- Boot ----------

async function boot() {
  try {
    state.user = await api('/me');
  } catch (err) {
    state.user = null;
    $('landing-panel').classList.remove('hidden');
    $('app-panel').classList.add('hidden');
    document.body.classList.remove('is-authed');
    // A 401 here just means "not logged in yet" — normal, stays silent.
    // Anything else (404, 500, network error) means something is actually
    // broken, so surface it instead of quietly dropping back to the login
    // screen with no explanation.
    if (err.status !== 401) {
      $('auth-error').textContent = `Couldn't load your account (${err.message}). Try refreshing — if this keeps happening, the server may need to be restarted.`;
      console.error('Unexpected error in boot():', err.status, err.message);
    } else {
      // A remembered refresh token that no longer works (revoked, or the
      // user logged out elsewhere) shouldn't keep being retried on every visit.
      localStorage.removeItem('watch2earn_remembered_refresh_token');
    }
    return;
  }

  $('landing-panel').classList.add('hidden');
  $('app-panel').classList.remove('hidden');
  document.body.classList.add('is-authed');
  $('referral-code').textContent = state.user.referral_code;
  setupReferralSharing(state.user.referral_code);
  $('profile-email').textContent = state.user.display_name || state.user.email;
  $('avatar-initial').textContent = state.user.email.charAt(0).toUpperCase();
  updateBalanceDisplay(state.user.points_balance, { animateFrom: 0 });
  $('dashboard-greeting').textContent = `Welcome, ${state.user.display_name || state.user.email.split('@')[0]}!`;

  // Each of these three failing independently (one endpoint down, a
  // migration not yet run, a transient network blip) must not break the
  // other two or leave the sidebar unusable — each degrades to an empty
  // list on its own rather than letting Promise.all reject as a whole.
  const [videos, tasks, rewardTiers] = await Promise.all([
    api('/videos').catch((err) => { console.error('Failed to load videos:', err.message); return []; }),
    api('/tasks').catch((err) => { console.error('Failed to load tasks:', err.message); return []; }),
    api('/reward-tiers').catch((err) => { console.error('Failed to load reward tiers:', err.message); return []; }),
  ]);
  state.videos = videos;
  state.tasks = tasks;
  state.rewardTiers = rewardTiers;
  // The very first updateBalanceDisplay() call above ran before reward tiers
  // had loaded, so it used the fallback threshold — refresh it now that the
  // real minimum tier is known.
  updateBalanceDisplay(state.user.points_balance);
  const dailyLimit = videos[0]?.daily_limit || 5;
  const dailyWatchLimit = videos[0]?.daily_watch_limit || 3;
  const referralCount = videos[0]?.referral_count ?? state.user.referral_count ?? 0;
  $('explore-access-note').textContent = dailyLimit === 8
    ? `You have access to 8 Let's Discuss videos today, and can watch up to ${dailyWatchLimit} of them for reward. Your ${referralCount} referrals unlocked the expanded selection. Watch fully, then answer correctly to earn video points plus a quiz bonus.`
    : `You have access to 5 Let's Discuss videos today, and can watch up to ${dailyWatchLimit} of them for reward. Refer ${Math.max(0, 5 - referralCount)} more new user${5 - referralCount === 1 ? '' : 's'} to unlock 8 videos and a daily watch limit of 5. Watch fully, then answer correctly to earn video points plus a quiz bonus.`;
  await refreshBalance();
  await refreshVideoStatus();

  renderDashboard();
}

function setupReferralSharing(referralCode) {
  const referralLink = `${window.location.origin}/?ref=${encodeURIComponent(referralCode)}`;
  const panel = $('referral-share-panel');
  const linkInput = $('referral-link');
  const qr = $('referral-qr');
  linkInput.value = referralLink;
  qr.replaceChildren();
  if (window.QRCode) {
    new window.QRCode(qr, { text: referralLink, width: 200, height: 200, colorDark: '#07101f', colorLight: '#ffffff' });
  } else {
    qr.textContent = 'QR code unavailable. Copy the referral link below.';
  }

  const shareText = 'Join me on Watch & Earn.';
  const encodedLink = encodeURIComponent(referralLink);
  const encodedText = encodeURIComponent(`${shareText} ${referralLink}`);
  $('share-whatsapp').href = `https://wa.me/?text=${encodedText}`;
  $('share-facebook').href = `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`;
  $('share-messenger').href = `https://www.messenger.com/share?link=${encodedLink}`;
  $('share-x').href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodedLink}`;
  $('share-email').href = `mailto:?subject=${encodeURIComponent('Join Watch & Earn')}&body=${encodedText}`;

  $('share-referral-btn').onclick = () => {
    lastReferralTrigger = $('share-referral-btn');
    panel.classList.remove('hidden');
    document.body.classList.add('dialog-open');
    panel.focus();
    $('referral-share-message').textContent = '';
  };
  const closeReferral = () => {
    panel.classList.add('hidden');
    document.body.classList.remove('dialog-open');
    lastReferralTrigger?.focus();
  };
  $('referral-share-close').onclick = closeReferral;
  panel.onclick = (event) => { if (event.target === panel) closeReferral(); };
  panel.dataset.close = 'referral';
  $('copy-referral-link-btn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(referralLink);
      $('referral-share-message').textContent = 'Copied! Your referral link is ready to share.';
    } catch {
      linkInput.select();
      $('referral-share-message').textContent = 'Select and copy the referral link.';
    }
  };
  $('native-share-referral-btn').onclick = async () => {
    if (!navigator.share) {
      $('referral-share-message').textContent = 'Choose a social app or email below.';
      return;
    }
    try {
      await navigator.share({ title: 'Join Watch & Earn', text: 'Join me on Watch & Earn.', url: referralLink });
    } catch (error) {
      if (error.name !== 'AbortError') $('referral-share-message').textContent = 'Sharing was unavailable.';
    }
  };
}

// Builds state.videoStatus from watch-history: for each video, the most
// recent session's status/position (history is already ordered newest-first).
async function refreshVideoStatus() {
  let history = [];
  try {
    history = await api('/watch-history');
  } catch {
    history = [];
  }
  state.videoStatus = {};
  for (const row of history) {
    if (!row.videoId || state.videoStatus[row.videoId]) continue; // keep newest only
    state.videoStatus[row.videoId] = {
      status: row.status,
      positionSeconds: row.positionSeconds || 0,
      sessionId: row.id,
    };
  }
  state.watchHistory = history;
}

// ---------- Balance meter ----------

// The real minimum redemption threshold is whatever reward tier costs the
// fewest points (500 today, for airtime/data) — NOT the flat 5,000-point
// constant this used to be hardcoded to, which only ever applied to cash.
// Falls back to the old constant only until state.rewardTiers has actually
// loaded, so there's a sane default for the very first render.
function getMinRewardTierPoints() {
  if (!state.rewardTiers.length) return REDEMPTION_TIER;
  return Math.min(...state.rewardTiers.map((t) => t.points_required));
}

function updateBalanceDisplay(balance, { animateFrom } = {}) {
  const prev = animateFrom ?? state.user?.points_balance ?? balance;
  animateCount($('points-balance'), prev, balance);
  animateCount($('points-balance-2'), prev, balance);
  if (state.user) state.user.points_balance = balance;

  const minTier = getMinRewardTierPoints();
  const progress = balance % minTier;
  const fraction = progress / minTier;
  $('meter-fill').style.strokeDashoffset = METER_CIRC * (1 - fraction);

  const remaining = minTier - progress;
  $('meter-caption-text').textContent = balance >= minTier && progress === 0
    ? 'Redemption tier reached!'
    : `${remaining} pts to next tier`;
}

function animateCount(el, from, to) {
  if (!el) return;
  const duration = 500;
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(from + (to - from) * t);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function refreshBalance() {
  const me = await api('/me');
  const prevBalance = state.user.points_balance;
  state.user = me;
  updateBalanceDisplay(me.points_balance, { animateFrom: prevBalance });
}

// ---------- Dashboard ----------

function renderDashboard() {
  renderContinueWatching();
  renderDashboardSummary();
  renderDashboardRecent();
}

async function renderDashboardSummary() {
  const videos = state.videos || [];
  const incomplete = videos.filter((video) => state.videoStatus[video.id]?.status !== 'completed');
  const estimated = incomplete.reduce((total, video) => total + Number(video.points_reward || 0) + Number(video.quiz_bonus_points || 3), 0);
  const referralCount = Math.min(5, Number(state.user?.referral_count || 0));
  const balance = Number(state.user?.points_balance || 0);
  $('dashboard-video-count').textContent = `${incomplete.length} video${incomplete.length === 1 ? '' : 's'} available`;
  $('dashboard-earning-estimate').textContent = `Up to ${estimated} pts if you complete them`;
  const minTier = getMinRewardTierPoints();
  $('dashboard-redemption-progress').textContent = `${Math.min(balance, minTier).toLocaleString()} / ${minTier.toLocaleString()} pts`;
  $('dashboard-referral-progress').textContent = `${referralCount} of 5 referrals`;
  $('dashboard-referral-status').textContent = referralCount >= 5 ? 'Expanded daily video pool unlocked' : `Refer ${5 - referralCount} more to unlock 8 videos and a daily watch limit of 5`;
  try {
    const redemptions = await api('/redemptions');
    const pending = redemptions.filter((row) => ['pending', 'processing'].includes(row.status));
    $('dashboard-payout-status').textContent = pending.length ? `${pending.length} payout request${pending.length === 1 ? '' : 's'} in progress` : 'No pending payouts';
  } catch {
    $('dashboard-payout-status').textContent = 'Payout status unavailable';
  }
}

$('dashboard-start-btn').onclick = () => switchPage('explore');

function renderContinueWatching() {
  const entry = Object.entries(state.videoStatus).find(([, v]) => v.status === 'in_progress' || v.status === 'quiz_pending');
  const card = $('continue-watching-card');
  if (!entry) {
    card.classList.add('hidden');
    return;
  }
  const [videoId, info] = entry;
  const video = state.videos.find((v) => v.id === videoId);
  if (!video) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const label = info.status === 'quiz_pending' ? 'Reward earned — bonus quiz available' : 'Continue watching';
  $('continue-watching-body').innerHTML = `
    <div class="continue-watching-row">
      <img class="cw-thumb" src="${videoThumbUrl(video)}" alt="" loading="lazy">
      <div>
        <div class="cw-title">${escapeHtml(video.title)}</div>
        <div class="cw-sub">${label}</div>
      </div>
      <button type="button" class="btn-primary" id="continue-watching-btn">${info.status === 'quiz_pending' ? 'Bonus quiz' : 'Continue'}</button>
    </div>
  `;
  $('continue-watching-btn').onclick = () => {
    switchPage('explore');
    startVideo(video);
  };
}

async function renderDashboardRecent() {
  const list = $('dashboard-recent-list');
  list.innerHTML = '<p class="note">Loading…</p>';
  try {
    const rows = await api('/ledger');
    list.innerHTML = '';
    if (!rows.length) {
      list.innerHTML = '<p class="note">No activity yet — watch a video to get started.</p>';
      return;
    }
    for (const r of rows.slice(0, 6)) {
      const row = document.createElement('div');
      row.className = 'ticket-row';
      const positive = r.points > 0;
      row.innerHTML = `
        <span class="ticket-type">${escapeHtml(r.reason.replace('_', ' '))}</span>
        <span class="ticket-points" style="color:${positive ? 'var(--mint)' : 'var(--danger)'}">${positive ? '+' : ''}${r.points} pts</span>
        <span class="note">${new Date(r.created_at).toLocaleDateString()}</span>
      `;
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '<p class="note error">Could not load recent activity.</p>';
  }
}

// ---------- Explore Videos ----------

function videoThumbUrl(video) {
  const videoId = /^[A-Za-z0-9_-]{6,20}$/.test(video.youtube_video_id || '') ? video.youtube_video_id : '';
  return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : '';
}

function statusLabel(status) {
  return { not_started: 'Watch to earn', in_progress: 'Continue watching', quiz_pending: 'Bonus quiz available', completed: 'Earned' }[status] || 'Watch to earn';
}

function buttonLabel(status) {
  return { not_started: 'Watch to earn', in_progress: 'Continue watching', quiz_pending: 'Take bonus quiz', completed: 'Earned ✓' }[status] || 'Watch to earn';
}

async function renderExploreVideos() {
  const list = $('explore-video-list');
  list.innerHTML = '<p class="note">Loading…</p>';
  await refreshVideoStatus();
  const query = state.exploreQuery.trim().toLowerCase();
  const filteredVideos = state.videos
    .filter((video) => !query || video.title.toLowerCase().includes(query))
    .sort((a, b) => {
      if (state.exploreSort === 'daily') return 0;
      if (state.exploreSort === 'reward') return b.points_reward - a.points_reward;
      if (state.exploreSort === 'duration') return a.duration_seconds - b.duration_seconds;
      return new Date(b.published_at || b.created_at).getTime() - new Date(a.published_at || a.created_at).getTime();
    });
  list.innerHTML = '';
  if (!filteredVideos.length) {
    list.innerHTML = `<p class="note">${state.videos.length ? 'No videos match your search.' : 'No videos added yet. Ask the channel owner to add some.'}</p>`;
    return;
  }
  for (const v of filteredVideos) {
    const info = state.videoStatus[v.id] || { status: 'not_started', positionSeconds: 0 };
    const pct = info.positionSeconds && v.duration_seconds ? Math.min(100, Math.round((info.positionSeconds / v.duration_seconds) * 100)) : 0;

    const el = document.createElement('div');
    el.className = `video-card status-${info.status.replace('_', '-')}`;
    el.innerHTML = `
      <img class="video-thumb" src="${videoThumbUrl(v)}" alt="" loading="lazy">
      <span class="video-status-badge ${info.status.replace('_', '-')}">${statusLabel(info.status)}</span>
      <span class="video-title">${escapeHtml(v.title)}</span>
      <span class="credit-tag">${info.status === 'completed' ? 'Already earned' : `+${v.points_reward} pts`}</span>
      ${info.status === 'in_progress' ? `<div class="video-progress-track"><div class="video-progress-fill" style="width:${pct}%"></div></div>` : ''}
      <button data-id="${v.id}">${info.status === 'completed' ? 'Watch again' : buttonLabel(info.status)}</button>
    `;
    el.querySelector('button').onclick = () => startVideo(v, { rewatch: info.status === 'completed' });
    list.appendChild(el);
  }
}

// ---------- Profile ----------

function renderProfile() {
  $('profile-detail-email').textContent = state.user.email;
  $('profile-detail-referral').textContent = state.user.referral_code;
  $('profile-display-name').value = state.user.display_name || '';
  $('profile-phone-number').value = state.user.phone_number || '';
  $('profile-message').textContent = '';
}

$('profile-copy-referral-btn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.user.referral_code);
    showToast('Referral code copied.', 'success');
  } catch {
    showToast('Could not copy the referral code.', 'error');
  }
};

$('profile-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('profile-save-btn');
  setButtonBusy(button, true, 'Saving...');
  try {
    const updated = await api('/me', {
      method: 'PATCH',
      body: JSON.stringify({
        displayName: $('profile-display-name').value.trim() || null,
        phoneNumber: $('profile-phone-number').value.trim() || null,
      }),
    });
    state.user = updated;
    $('profile-email').textContent = updated.display_name || updated.email;
    $('profile-message').textContent = 'Profile updated.';
    showToast('Profile updated.', 'success');
  } catch (err) {
    $('profile-message').textContent = err.message;
    showToast(err.message, 'error');
  } finally {
    setButtonBusy(button, false);
  }
};

// ---------- Video watching ----------

function stopHeartbeat() {
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

registerHeartbeatStopper(stopHeartbeat);

async function startVideo(video, { rewatch = false } = {}) {
  state.activeVideo = video;
  $('quiz-panel').classList.add('hidden');
  document.body.classList.remove('dialog-open');
  $('player-panel').classList.remove('hidden');

  // Rewatching an already-completed video is just for enjoyment — skip
  // session tracking entirely so no heartbeat call can credit anything.
  // sendHeartbeat() itself also no-ops without a sessionToken, so this is
  // belt-and-suspenders, not the only thing preventing a second reward.
  if (rewatch) {
    state.sessionToken = null;
    state.sessionId = null;
    state.resumeFromSeconds = 0;
    setWatchRing(0);
    $('watch-limit-referral-cta').classList.add('hidden');
    $('watch-status').textContent = "Rewatching — you've already earned this video's reward today, so this replay won't earn anything extra.";
    $('player-play-overlay').classList.add('hidden');
    if (state.player) {
      state.player.loadVideoById(video.youtube_video_id);
    } else if (window.YT && window.YT.Player) {
      createPlayer(video.youtube_video_id);
    } else {
      window.onYouTubeIframeAPIReady = () => createPlayer(video.youtube_video_id);
    }
    $('player-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  $('watch-status').textContent = 'Loading player...';

  let session;
  try {
    session = await api('/session/start', {
      method: 'POST',
      body: JSON.stringify({ videoId: video.id }),
    });
  } catch (err) {
    $('watch-status').textContent = err.message;
    const ctaBtn = $('watch-limit-referral-cta');
    if (err.code === 'WATCH_LIMIT_REACHED' && err.data?.referralsNeeded > 0) {
      ctaBtn.classList.remove('hidden');
      ctaBtn.onclick = () => {
        const panel = $('referral-share-panel');
        lastReferralTrigger = ctaBtn;
        panel.classList.remove('hidden');
        document.body.classList.add('dialog-open');
        panel.focus();
        $('referral-share-message').textContent = '';
      };
    } else {
      ctaBtn.classList.add('hidden');
    }
    return;
  }

  $('watch-limit-referral-cta').classList.add('hidden');
  state.sessionToken = session.sessionToken;
  state.sessionId = session.sessionId;
  state.resumeFromSeconds = session.resumeFromSeconds || 0;
  setWatchRing(state.resumeFromSeconds / video.duration_seconds);

  if (session.status === 'quiz_pending') {
    $('player-panel').classList.add('hidden');
    $('watch-status').textContent = '';
    renderQuiz(video, session.sessionId);
    return;
  }

  $('player-play-overlay').classList.add('hidden');
  if (state.player) {
    state.player.loadVideoById(video.youtube_video_id);
  } else if (window.YT && window.YT.Player) {
    createPlayer(video.youtube_video_id);
  } else {
    window.onYouTubeIframeAPIReady = () => createPlayer(video.youtube_video_id);
  }
  $('player-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function createPlayer(youtubeVideoId) {
  state.player = new YT.Player('yt-player', {
    videoId: youtubeVideoId,
    // controls:0 + disablekb:1 + fs:0 remove every built-in way to seek —
    // no visible seek bar, no arrow-key/space-bar seeking, no fullscreen
    // (whose native controls could otherwise offer another seek path). The
    // real enforcement is server-side (see heartbeat handler), this just
    // keeps the UI honest about it instead of showing controls that don't work.
    playerVars: { controls: 0, disablekb: 1, fs: 0, modestbranding: 1, rel: 0, iv_load_policy: 3 },
    events: { onReady: onPlayerReady, onStateChange: onPlayerStateChange },
  });
}

function onPlayerReady() {
  if (state.resumeFromSeconds > 0) {
    state.player.seekTo(state.resumeFromSeconds, true);
  }
  $('player-play-overlay').classList.remove('hidden');
  $('watch-status').textContent = 'Press play to start earning.';
}

$('player-play-overlay').onclick = () => {
  if (state.player) state.player.playVideo();
};

function setWatchRing(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction || 0));
  $('watch-fill').style.strokeDashoffset = WATCH_CIRC * (1 - clamped);
  $('watch-percent').textContent = Math.round(clamped * 100) + '%';
}

function onPlayerStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    $('player-play-overlay').classList.add('hidden');
    $('watch-status').textContent = state.sessionToken
      ? 'Watching... keep this tab open and in focus to earn.'
      : "Rewatching — you've already earned this video's reward today, so this replay won't earn anything extra.";
    stopHeartbeat();
    state.heartbeatTimer = setInterval(sendHeartbeat, 5000);
  } else {
    stopHeartbeat();
    if (event.data === YT.PlayerState.PAUSED) {
      $('player-play-overlay').classList.remove('hidden');
      $('watch-status').textContent = state.sessionToken
        ? 'Paused — press play to keep earning.'
        : 'Paused.';
    }
  }
}

// Shared guard used both when the browser tab itself is hidden and when
// navigating to a different page within the app — either way, a video
// left playing in the background (audio still going, data still used)
// is bad UX, not just an unearned-reward risk.
function pauseActivePlayerIfPlaying() {
  if (typeof YT === 'undefined') return;
  if (state.player && typeof state.player.pauseVideo === 'function' && state.player.getPlayerState?.() === YT.PlayerState.PLAYING) {
    state.player.pauseVideo();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') pauseActivePlayerIfPlaying();
});

async function sendHeartbeat() {
  // Skip while tab is hidden/backgrounded so muted background tabs don't earn.
  if (document.visibilityState !== 'visible') return;
  if (!state.sessionToken || !state.player) return;

  const reportedPosition = Math.floor(state.player.getCurrentTime());

  try {
    const data = await api('/session/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ sessionToken: state.sessionToken, positionSeconds: reportedPosition }),
    });

    const verified = data.verifiedPositionSeconds ?? data.positionSeconds ?? 0;
    setWatchRing(verified / state.activeVideo.duration_seconds);

    // If the server didn't credit the position we reported (i.e. we tried to
    // seek ahead), snap the player back — the server already ignored the
    // jump for scoring purposes, this just keeps the UI consistent with that.
    if (reportedPosition > verified + 2) {
      state.player.seekTo(verified, true);
      $('watch-status').textContent = "Seeking ahead isn't allowed — watch time only counts while playing.";
    }

    if (data.status === 'quiz_pending') {
      stopHeartbeat();
      state.player.pauseVideo();
      $('player-panel').classList.add('hidden');
      if (data.pointsEarned) {
        showToast(`Video complete — +${data.pointsEarned} points earned! Stick around for a bonus quiz.`, 'success');
        await refreshBalance();
      }
      renderQuiz(state.activeVideo, state.sessionId);
    } else if (data.status === 'completed') {
      stopHeartbeat();
      $('watch-status').textContent = 'Already completed.';
    }
  } catch (err) {
    stopHeartbeat();
    $('watch-status').textContent = err.message;
  }
}

// ---------- Quiz ----------

async function renderQuiz(video, sessionId) {
  lastQuizTrigger = document.activeElement;
  $('quiz-panel').classList.remove('hidden');
  document.body.classList.add('dialog-open');
  $('quiz-panel').focus();
  $('quiz-result').textContent = '';
  $('quiz-questions').innerHTML = '<p class="note">Loading questions…</p>';

  let questions = [];
  try {
    questions = await api(`/videos/${video.id}/questions`);
  } catch (err) {
    $('quiz-questions').innerHTML = '';
    $('quiz-result').textContent = err.message;
    return;
  }

  if (!questions.length) {
    $('quiz-questions').innerHTML = '<p class="note error">This video is not ready for rewards yet because its quiz has not been configured. Please try another video.</p>';
    $('quiz-submit-btn').classList.add('hidden');
    return;
  }

  $('quiz-questions').innerHTML = questions.map((q) => `
    <div class="quiz-question" data-question-id="${q.id}">
      <div class="quiz-question-text">${escapeHtml(q.question)}</div>
      <div class="quiz-options">
        ${q.options.map((opt, i) => `
          <label class="quiz-option">
            <input type="radio" name="q-${q.id}" value="${i}">
            <span>${escapeHtml(opt)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  $('quiz-submit-btn').classList.remove('hidden');
  $('quiz-submit-btn').disabled = false;
  $('quiz-submit-btn').onclick = async () => {
    const answers = [];
    let missing = false;
    document.querySelectorAll('#quiz-questions .quiz-question').forEach((qEl) => {
      const questionId = qEl.dataset.questionId;
      const checked = qEl.querySelector('input[type=radio]:checked');
      if (!checked) { missing = true; return; }
      answers.push({ questionId, selectedIndex: Number(checked.value) });
    });
    if (missing) {
      $('quiz-result').textContent = 'Answer every question before submitting.';
      return;
    }
    await submitQuizAnswers(sessionId, answers);
  };
}

$('quiz-close').onclick = () => {
  $('quiz-panel').classList.add('hidden');
  document.body.classList.remove('dialog-open');
  lastQuizTrigger?.focus();
};

async function submitQuizAnswers(sessionId, answers) {
  $('quiz-submit-btn').disabled = true;
  $('quiz-result').textContent = '';
  try {
    const result = await api(`/session/${sessionId}/quiz`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
    $('quiz-result').style.color = 'var(--mint)';
    $('quiz-result').textContent = result.correct === result.total
      ? `Perfect! +${result.pointsEarned} bonus points for ${result.correct}/${result.total} correct.`
      : result.correct > 0
        ? `+${result.pointsEarned} bonus points for ${result.correct}/${result.total} correct. Your video reward is already in your balance either way.`
        : `No bonus this time (${result.correct}/${result.total} correct) — but your video reward is already in your balance.`;
    $('quiz-submit-btn').classList.add('hidden');
    await refreshBalance();
    await refreshVideoStatus();
    renderExploreVideos();
    renderDashboard();
  } catch (err) {
    $('quiz-result').style.color = '';
    $('quiz-result').textContent = err.message;
    $('quiz-submit-btn').disabled = false;
  }
}

// ---------- Watch history ----------

async function renderWatchHistory() {
  const list = $('history-list');
  list.innerHTML = '<p class="note">Loading…</p>';
  await refreshVideoStatus();
  const rows = state.watchHistory || [];
  if (!rows.length) {
    list.innerHTML = '<p class="note">You haven\'t started any videos yet.</p>';
    return;
  }
  list.innerHTML = '';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'ticket-row has-thumb';
    let statusText, actionHtml = '';
    if (r.status === 'completed') {
      statusText = `<span class="ticket-status fulfilled">+${r.pointsEarned} pts</span>`;
    } else if (r.status === 'quiz_pending') {
      statusText = `<span class="ticket-status fulfilled">+${r.pointsEarned} pts</span> <span class="ticket-status pending">Bonus quiz available</span>`;
      actionHtml = `<button type="button" class="btn-ghost history-resume-btn" data-video-id="${r.videoId}">Bonus quiz</button>`;
    } else {
      const pct = r.durationSeconds ? Math.round((r.positionSeconds / r.durationSeconds) * 100) : 0;
      statusText = `<span class="ticket-status pending">${pct}% watched</span>`;
      actionHtml = `<button type="button" class="btn-ghost history-resume-btn" data-video-id="${r.videoId}">Continue</button>`;
    }
    row.innerHTML = `
      <img class="ticket-row-thumb" src="${videoThumbUrl({ youtube_video_id: r.youtubeVideoId })}" alt="" loading="lazy">
      <span class="ticket-type as-written">${escapeHtml(r.title || 'Untitled video')}</span>
      ${statusText}
      <span class="note">${new Date(r.startedAt).toLocaleDateString()}</span>
      ${actionHtml}
    `;
    list.appendChild(row);
  }
  document.querySelectorAll('.history-resume-btn').forEach((btn) => {
    btn.onclick = () => {
      const video = state.videos.find((v) => v.id === btn.dataset.videoId);
      if (!video) return;
      switchPage('explore');
      startVideo(video);
    };
  });
}

// ---------- Redemption ----------
// Rendering and wiring for this section now live in modules/app-rewards.js
// (see renderRedeemTiers/renderRedemptions/renderLedger imports above).

initRewards({ refreshBalance });

// Do not restore a previous session on startup. A visitor must sign in via one
// of the forms above before boot() is called.