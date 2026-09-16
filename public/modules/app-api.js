import { $, showToast } from './app-ui.js';
import { state, setAccessToken, accessToken } from './app-state.js';

let heartbeatStopper = () => {};

export function registerHeartbeatStopper(stopper) {
  heartbeatStopper = stopper;
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch('/api' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    const networkError = new Error('The server is unavailable. Start the app with `npm.cmd start` and try again.');
    networkError.cause = error;
    showToast(networkError.message, 'error');
    throw networkError;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    // Only force a full logout for mutating requests (POST/PATCH/DELETE) —
    // a 401 there means the user just tried to DO something and genuinely
    // needs to know their session is invalid. A GET fetching supplementary
    // page data (videos, reward tiers, redemptions, etc.) failing shouldn't
    // nuke an otherwise-working session; the calling code degrades that
    // gracefully on its own (empty list, "unavailable" message, etc.).
    const isMutation = options.method && options.method !== 'GET';
    if (response.status === 401 && accessToken && isMutation) {
      setAccessToken(null);
      heartbeatStopper();
      state.user = null;
      $('app-panel')?.classList.add('hidden');
      $('landing-panel')?.classList.remove('hidden');
      document.body.classList.remove('is-authed');
      showToast('Your session expired. Please log in again.', 'error');
    }
    throw error;
  }
  return data;
}
