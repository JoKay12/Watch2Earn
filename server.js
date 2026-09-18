import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';

import authRoutes from './routes/auth.js'; // route handlers for /register, /login, etc. — not the middleware (see middleware/authMiddleware.js)
import videoRoutes from './routes/videos.js'; // video content: explore feed, quiz questions, admin video/playlist management, YouTube sync
import watchSessionRoutes from './routes/watchSessions.js'; // watch-session lifecycle: history, start, heartbeat anti-cheat, quiz submission
import taskRoutes from './routes/tasks.js';
import rewardRoutes from './routes/rewards.js';
import configRoutes from './routes/config.js';
import { rateLimit } from './lib/rateLimit.js';
import { processQueuedPayouts } from './lib/payouts.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Trusts the first proxy hop (correct for most single-layer setups: Render,
// Railway, Heroku, a single Nginx in front of Node). Without this, req.ip
// resolves to the proxy's own address behind ANY reverse proxy — which
// would collapse every distinct user into one shared rate-limit bucket
// (see lib/rateLimit.js), rather than actually limiting per-client. If this
// is ever deployed behind multiple proxy layers (e.g. Cloudflare AND a
// platform proxy), this may need to become a higher number instead of 1.
app.set('trust proxy', 1);

// Security headers. The default CSP is tightened to 'self' and then opened
// up only for the specific third parties the frontend actually talks to —
// the two CDN scripts index.html loads, the YouTube iframe player and its
// thumbnails, and the Supabase project the client SDK calls directly for
// OAuth/password-reset. crossOriginEmbedderPolicy is off because the
// YouTube iframe embed doesn't send the headers COEP would require.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://www.youtube.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline style="" attrs + the Google Fonts stylesheet link
      imgSrc: ["'self'", 'data:', 'https://i.ytimg.com'],
      connectSrc: ["'self'", 'https://*.supabase.co'],
      frameSrc: ["'self'", 'https://www.youtube.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '8mb' })); // screenshot proof uploads are sent as base64 JSON
app.use(express.static(path.join(__dirname, 'public')));

// API responses must never be cached by the browser — a stale cached error
// (e.g. a 404 from an older deployment that didn't have a route yet) can
// otherwise keep being served after the route is fixed, even past a hard
// refresh, since it's a background fetch rather than the page navigation.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/register', rateLimit({ name: 'register', windowMs: 15 * 60_000, max: 10 }));
app.use('/api/login', rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10 }));
app.use('/api/forgot-password', rateLimit({ name: 'password-reset', windowMs: 15 * 60_000, max: 5 }));
app.use('/api/session/heartbeat', rateLimit({ name: 'heartbeat', windowMs: 60_000, max: 30 }));
app.use('/api/session', rateLimit({ name: 'session', windowMs: 60_000, max: 20 }));
app.use('/api/redeem', rateLimit({ name: 'redeem', windowMs: 15 * 60_000, max: 5 }));
app.use('/api/admin', rateLimit({ name: 'admin', windowMs: 60_000, max: 30 }));

app.use('/api', authRoutes);
app.use('/api', videoRoutes);
app.use('/api', watchSessionRoutes);
app.use('/api', taskRoutes);
app.use('/api', rewardRoutes);
app.use('/api', configRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

if (process.env.PAYOUT_AUTOMATION_ENABLED === 'true') {
  setInterval(() => processQueuedPayouts().catch((error) => {
    console.error('Payout worker failed:', error.message);
  }), 15_000).unref();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`watch2earn running on http://localhost:${PORT}`));
