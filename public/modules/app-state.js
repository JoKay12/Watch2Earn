export const state = {
  user: null,
  videos: [],
  videoStatus: {},
  tasks: [],
  watchHistory: [],
  player: null,
  heartbeatTimer: null,
  sessionToken: null,
  sessionId: null,
  activeVideo: null,
  redeemType: 'cash',
  rewardTiers: [],
  exploreQuery: '',
  exploreSort: 'daily',
};

export const REDEMPTION_TIER = 2000;
export const METER_CIRC = 326.7;
export const WATCH_CIRC = 276.5;

export let accessToken = null;

export function setAccessToken(token) {
  accessToken = token;
}
