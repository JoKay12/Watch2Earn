# Watch & Earn — Starter App

A working starter for a "watch videos from my YouTube channel, earn rewards" site: accounts, persistent points, server-validated watch tracking, self-reported bonus tasks, referrals, and a redemption request flow for cash/airtime/data bundles.

## Read this first — two important risks

1. **Social engagement is not rewarded.** YouTube and other platforms can treat paid or incentivized likes, comments, shares, and subscriptions as fake engagement. This project keeps rewards tied to watching videos and quizzes; the signed-in Community page links users to the official social channels without offering points for following them.
2. **Cash/airtime/data payouts are opt-in automated.** The `/api/redeem` endpoint records a request, deducts points, and queues an idempotent payout. The worker stays disabled until `PAYOUT_AUTOMATION_ENABLED=true` and a provider endpoint is configured. To connect a real provider:
   - Airtime/data: [Reloadly](https://www.reloadly.com/) or your local telco's API
   - Cash: Paystack, Flutterwave, or PayPal Payouts, depending on your country
   Before automating payouts at any real volume, check whether your country requires a money-transmission license or similar — worth a quick conversation with a lawyer once you're past prototyping.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is fine to start).
2. **Run the schema.** In your project dashboard, go to SQL Editor → New query, paste the entire contents of `supabase/schema.sql` from this project, and click Run. Then run `supabase/migration_002_quiz_and_tracking.sql`, `supabase/migration_003_daily_explore_and_quiz_bonus.sql`, `supabase/migration_004_security_hardening.sql`, `supabase/migration_005_admin_roles_and_payouts.sql`, `supabase/migration_006_referral_rewards_and_sharing.sql`, `supabase/migration_007_signup_referral_reward.sql`, `supabase/migration_008_featured_videos.sql`, `supabase/migration_009_admin_audit_log.sql`, and `supabase/migration_010_profile_phone_number.sql` in order. Migration 010 is intentionally a no-op; phone numbers are stored in Supabase Auth metadata and do not require public schema permissions.
3. **Turn off email confirmation for local testing** (optional but recommended while developing): Authentication → Providers → Email → toggle off "Confirm email." With it on, new signups won't get a usable session until they click a confirmation link in their inbox.
4. **Copy your keys.** Go to Settings → API and copy: `Project URL`, the `anon` `public` key, and the `service_role` key.
5. **Set up your local `.env`:**
   ```bash
   cp .env.example .env
   ```
   Fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` with what you copied, plus a unique random value of at least 32 characters for `SESSION_SECRET`.
6. **Install and run:**
   ```bash
   npm install
   npm start
   ```

   To run the frontend browser tests, install the Playwright browser once and run:

   ```bash
   node ./node_modules/@playwright/test/cli.js install chromium
   npm test
   ```

   The suite covers the public auth shell, unavailable-login API feedback, the admin key gate, and the mobile layout using mocked API responses so it does not require a live user account.

Visit `http://localhost:3000`. No local database to install — Supabase hosts the Postgres database for you, which also means the Windows native-compilation issues from earlier versions of this project (`better-sqlite3`, `node-gyp`, Python/Visual Studio) no longer apply at all.

If `npm start` exits immediately with a "Missing Supabase config" message, it means `.env` still has placeholder values — double check step 5.

## Setting up Google sign-in

The "Continue with Google" button needs a real Google OAuth app connected to your Supabase project before it'll work — this is one-time setup, done outside this codebase.

1. **Get your Supabase callback URL.** In Supabase: Authentication → Providers → Google. Copy the "Callback URL (for OAuth)" shown there — it looks like `https://your-project-ref.supabase.co/auth/v1/callback`. Keep this tab open.
2. **Create a Google OAuth client.** Go to the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create a project if you don't have one, then Create Credentials → OAuth client ID → Application type: Web application.
3. **Add the redirect URI.** Under "Authorized redirect URIs," paste the Supabase callback URL from step 1. Save.
4. **Copy the Client ID and Client Secret** Google gives you after creating it.
5. **Paste them into Supabase.** Back on the Google provider page in Supabase, toggle it on, paste the Client ID and Client Secret, and save.
6. **Try it.** Click "Continue with Google" on your site — it should redirect to a real Google account picker, then land you back on the dashboard.

You don't need to touch any code for this — the button and the redirect handling are already built.

## Password reset

"Forgot password?" on the login form sends a Supabase-generated reset email automatically — no email service to configure, Supabase sends it for you. The link in that email takes the user to `/reset-password.html`, which lets them set a new password, then sends them back to log in. If your Supabase project has custom SMTP configured, the email will come from that address; otherwise it comes from Supabase's default sender (fine for testing, but check Supabase's docs on custom SMTP before relying on this for real users at scale — their default sender has low rate limits).

## Admin panel

Go to `http://localhost:3000/admin.html` and sign in with a Supabase account that has a row in `admin_roles`. The first administrator must be seeded manually after migration 005:

```sql
insert into public.admin_roles (user_id, role)
values ('YOUR_AUTH_USER_UUID', 'admin');
```

Administrators can grant `admin`, `content_editor`, and `payout_operator` roles from the Roles panel. Content routes require a content role; payout routes require a payout role.

From there you can:
   - **Videos** — add videos manually (paste the YouTube video ID, title, duration in seconds, and point reward), or sync your whole channel's uploads automatically (see "Syncing videos from YouTube" below). Toggle any video active/inactive without deleting it, click **Quiz** on any video to write its 3 questions, and mark eligible videos **Featured** for the public landing page.
- **Tasks** — add limited bonus tasks such as like/comment/share only after reviewing the applicable platform rules. Subscription/follow tasks and screenshot proof review have been removed; use the Community page for official social links.
- **Redemptions** — see pending cash/airtime/data requests with the user's email and destination, and Fulfill or Reject each one with a click. Rejecting automatically refunds the user's points.
- A stat strip at the top shows total users, points issued, videos completed, and pending redemptions at a glance.

Admin access uses Supabase accounts with server-side roles. Use `admin` for full access, `content_editor` for video and quiz management, and `payout_operator` for redemption operations.

## Syncing videos from YouTube

The "Sync now" button on the admin Videos panel pulls your channel's uploads automatically instead of adding them one at a time.

1. **Get an API key.** Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (the same project you may have already made for Google sign-in works fine, or a new one). Enable "YouTube Data API v3" under APIs & Services → Library, then create an API key under Credentials.
2. **Find your channel ID.** Either your channel ID (starts with `UC...`, found in your channel's About page or Advanced settings) or your `@handle` works.
3. **Add to `.env`:** `YOUTUBE_API_KEY`, and either `YOUTUBE_CHANNEL_ID` or `YOUTUBE_CHANNEL_HANDLE`.
4. Restart the server, go to the admin Videos panel, click **Sync now**. New videos are added *inactive* with a default reward — review and activate them from the video list. Videos already in your database get their title/duration refreshed without touching your reward amount or active state.

This uses your API key's daily quota (YouTube's free tier is generous for a single channel's worth of syncing, but avoid clicking Sync repeatedly in a short window).

## Quiz questions and the "must fully watch" requirement

Each video can have exactly 3 quiz questions (2-4 options each), written by you in the admin panel via the **Quiz** button next to any video. A user must answer **all 3 correctly** before a video's reward is credited — wrong answers don't lose them anything, they just retry.

## Referral sharing

The dashboard's **Share** button creates a referral link and QR code. Opening that link pre-fills the referral code on the registration form. A new account receives no signup points. The referrer receives 10 points when the new user signs up with a valid referral code; three completed referrals unlock the expanded daily Explore selection and milestone bonus.

Every active video must have exactly 3 questions configured. When the watch threshold is reached, the quiz opens immediately in a modal and the user must answer all 3 correctly before receiving the video reward and quiz bonus. Videos without a complete quiz cannot be activated or assigned in Explore.

Explore currently assigns each signed-in user a deterministic random selection of 5 active videos from the channel's `Let's Discuss` playlist per UTC day. After the user refers 3 new accounts, the selection expands to 8 videos and a one-time 100-point referral milestone bonus is credited. A correctly answered quiz adds the video's configured quiz bonus (5 points by default) on top of the normal video reward.

I deliberately didn't build AI-generated questions from video content — reliably extracting an accurate transcript and generating fair questions from it is a separate, failure-prone pipeline, and you know your own content's actual key details better than an automated guess would. Writing 3 questions when you add a video takes a minute and gives you full control over what "proves you watched it" actually means for that video.

## How watch tracking works (and why it's hard to fake)

- The video plays inside the app itself (embedded YouTube player), never redirecting to youtube.com.
- The seek bar, keyboard shortcuts, and fullscreen are all disabled on the player (`controls:0`, `disablekb:1`, `fs:0`) — there's no built-in way to click or key your way to a later point in the video.
- The real enforcement is server-side, not just hiding buttons: every ~5 seconds the player reports its position, and the backend only ever advances a session's *verified* position by a few seconds per heartbeat — a reported jump ahead is simply ignored server-side, no matter how it was produced. The player also gets visually snapped back if this happens, so the UI never shows a position the server didn't actually credit.
- Heartbeats stop while the browser tab is hidden/backgrounded, so a muted background tab doesn't rack up watch time.
- Once a video is fully watched, the reward isn't credited yet — the session moves to a "quiz pending" state, and the 3 questions must be answered correctly first.
- One reward per user per video per day, enforced at the database level.

This isn't bulletproof against a determined bot operator scripting raw HTTP requests (nothing fully is), but it stops everything short of that: editing client-side JS to fake progress, using the seek bar, muting and leaving the tab open, or replaying old requests.

## Project structure

```
server.js                Express app entry point
auth.js                  Supabase-verified auth middleware + admin key middleware
lib/supabase.js          Supabase client setup (anon client for auth, service-role client for data)
supabase/schema.sql      Postgres schema, RLS policies, and RPC functions — run this in Supabase's SQL editor
routes/auth.js           register/login/logout/me (via Supabase Auth)
routes/session.js        video list, watch session start/heartbeat, referral payout
routes/tasks.js          self-reported bonus tasks
routes/rewards.js        points ledger, redemption requests, admin endpoints
public/                  frontend (HTML/CSS/vanilla JS + YouTube IFrame API)
```

## Why Supabase, and how the pieces fit together

- **Auth** is handled entirely by Supabase Auth (`routes/auth.js` calls `supabaseAuth.auth.signUp` / `signInWithPassword`) — no password hashing or session-token code to maintain ourselves.
- **The backend still sits in front of the database.** The frontend never talks to Supabase directly; it only ever calls our own `/api/...` routes, same as before. The backend uses the Supabase **service-role key**, which bypasses Row Level Security, because it's a trusted server — RLS in `schema.sql` exists as a defense-in-depth layer in case anything ever queries Supabase directly, not as the main access control.
- **Multi-step writes** (crediting points for a finished video, resolving a redemption and possibly refunding it) are implemented as Postgres functions (`supabase/schema.sql`) called via `.rpc(...)`, so they run atomically in one round trip instead of several separate requests that could partially fail.
- **New-user setup** (creating a profile row, generating a referral code, linking up a referral) happens via a Postgres trigger that fires automatically whenever Supabase Auth creates a user — see `handle_new_user()` in `schema.sql`.

## Before going live

- Keep `SESSION_SECRET` as a unique random secret of at least 32 characters; the server refuses to start when it is missing or weak.
- Keep `PAYOUT_AUTOMATION_ENABLED=false` until the provider has been tested in its sandbox. Provider retries reuse the same idempotency key to prevent duplicate payments.
- Add HTTPS (e.g. behind a reverse proxy like Caddy or Nginx, or deploy to a platform that provides it).
- Rate limiting is enabled for authentication, heartbeat, redemption, session, and admin routes. For multiple server instances, replace the in-memory limiter with a shared Redis-backed limiter.
- Consider device fingerprinting or phone-number verification if you see multi-account farming.
- Use a provider's webhook or status API to reconcile payouts that remain in `processing` after a network interruption.
