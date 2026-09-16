import { test, expect } from '@playwright/test';

async function mockPublicApi(page) {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public-test-key' }),
  }));
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, body: JSON.stringify({ error: 'Not logged in' }) }));
  await page.route('**/api/featured-videos', (route) => route.fulfill({ status: 200, body: '[]' }));
}

test('landing page renders featured videos from the public content API', async ({ page }) => {
  await mockPublicApi(page);
  await page.route('**/api/featured-videos', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ youtube_video_id: 'dynamic123', title: 'A newly featured conversation', points_reward: 15 }]),
  }));
  await page.goto('/');

  await expect(page.locator('.featured-video-card')).toHaveCount(1);
  await expect(page.locator('.featured-video-name')).toHaveText('A newly featured conversation');
  await expect(page.locator('.featured-video-card img')).toHaveAttribute('src', /dynamic123/);
});

test('landing auth tabs switch without a page reload', async ({ page }) => {
  await mockPublicApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Sign up', exact: true }).first().click();
  await expect(page.locator('#register-form')).toBeVisible();
  await expect(page.locator('#login-form')).toBeHidden();

  await page.getByRole('button', { name: 'Log in', exact: true }).first().click();
  await expect(page.locator('#login-form')).toBeVisible();
});

test('login reports a useful network error when the API is unavailable', async ({ page }) => {
  await mockPublicApi(page);
  await page.goto('/');
  await page.route('**/api/login', (route) => route.abort('connectionrefused'));

  await page.locator('#login-email').fill('user@example.com');
  await page.locator('#login-password').fill('password123');
  await page.locator('#login-form button[type="submit"]').click();

  await expect(page.locator('#auth-error')).toContainText('server is unavailable');
});

test('admin gate validates a key and loads the console', async ({ page }) => {
  await page.route('**/api/login', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accessToken: 'test-admin-token', user: { email: 'admin@example.com' } }),
  }));
  await page.route('**/api/admin/stats', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ userCount: 2, totalPointsIssued: 100, pendingRedemptions: 0, completedWatches: 1, pendingTaskProofs: 0 }),
  }));
  await page.route('**/api/admin/videos', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/playlists', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/tasks', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/task-proofs?status=pending', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/redemptions?status=pending', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.goto('/admin.html');

  await page.locator('#admin-email-input').fill('admin@example.com');
  await page.locator('#admin-password-input').fill('password123');
  await page.locator('#key-form').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#console')).toBeVisible();
  await expect(page.locator('#stat-grid')).toContainText('Users');
});

test('community page replaces subscription navigation', async ({ page }) => {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public-test-key' }),
  }));
  await page.route('**/api/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ email: 'member@example.com', referral_code: 'JOIN1234', points_balance: 0, display_name: 'Member' }),
  }));
  await page.route('**/api/videos', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/tasks', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/watch-history', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/ledger', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accessToken: 'test-token', user: { email: 'member@example.com' } }),
  }));
  await page.goto('/');

  await page.locator('#login-email').fill('member@example.com');
  await page.locator('#login-password').fill('password123');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#app-panel')).toBeVisible();
  await page.locator('[data-page="dashboard"]').click();
  await page.locator('#share-referral-btn').click();
  await expect(page.locator('#referral-share-panel')).toBeVisible();
  await expect(page.locator('#referral-link')).toHaveValue(/\?ref=JOIN1234/);
  await expect(page.locator('#referral-qr')).toBeVisible();
  await expect(page.locator('.referral-social-option')).toHaveCount(5);
  await expect(page.locator('.referral-social-option svg')).toHaveCount(5);
  await expect(page.locator('#share-whatsapp')).toHaveAttribute('href', /wa\.me/);
  await expect(page.locator('#share-facebook')).toHaveAttribute('href', /facebook\.com\/sharer/);
  await expect(page.locator('#share-email')).toHaveAttribute('href', /^mailto:/);
  // Close the referral modal before navigating elsewhere — on narrow
  // viewports it covers the whole screen (correctly, as a real modal
  // should), which would otherwise block clicks on the nav underneath.
  await page.locator('#referral-share-close').click();
  await expect(page.locator('#referral-share-panel')).toBeHidden();
  await expect(page.locator('[data-page="subscription"]')).toHaveCount(0);
  // On mobile, Community lives in the "More" popup, not the main bar directly
  // — open it first if that's where we are; on desktop it's already visible.
  const mainCommunityLink = page.locator('.side-nav [data-page="community"]');
  if (!(await mainCommunityLink.isVisible())) {
    await page.locator('#mobile-more-btn').click();
  }
  await page.locator('[data-page="community"]:visible').click();
  await expect(page.locator('#page-community')).toBeVisible();
  await expect(page.locator('.community-social-card')).toHaveCount(5);
});
