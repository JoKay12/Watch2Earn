import { test, expect } from '@playwright/test';

async function loginAsMember(page, { pointsBalance = 150, videos = [], rewardTiers = [] } = {}) {
  await page.route('**/api/config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'public-test-key' }),
  }));
  await page.route('**/api/featured-videos', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/login', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accessToken: 'test-token', user: { email: 'member@example.com' } }),
  }));
  await page.route('**/api/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ email: 'member@example.com', referral_code: 'JOIN1234', points_balance: pointsBalance, display_name: null }),
  }));
  // boot() fetches these immediately on login — they must be mocked with
  // real data before login happens, not registered afterward, since
  // pages like Explore Videos reuse state.videos from this fetch rather
  // than re-fetching independently.
  await page.route('**/api/videos', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(videos) }));
  await page.route('**/api/reward-tiers', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rewardTiers) }));
  await page.route('**/api/tasks', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/watch-history', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/ledger', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/redemptions', (route) => route.fulfill({ status: 200, body: '[]' }));

  await page.goto('/');
  await page.locator('#login-email').fill('member@example.com');
  await page.locator('#login-password').fill('password123');
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator('#app-panel')).toBeVisible();
}

async function loginAsAdmin(page, { pendingRedemptions = [], rewardTiers = [] } = {}) {
  await page.route('**/api/login', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ accessToken: 'test-admin-token', user: { email: 'admin@example.com' } }),
  }));
  await page.route('**/api/admin/stats', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ role: 'admin', userCount: 2, totalPointsIssued: 100, pendingRedemptions: pendingRedemptions.length, completedWatches: 1, pendingTaskProofs: 0 }),
  }));
  await page.route('**/api/admin/videos', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/playlists', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/tasks', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/roles**', (route) => route.fulfill({ status: 200, body: '[]' }));
  await page.route('**/api/admin/audit-log**', (route) => route.fulfill({ status: 200, body: '[]' }));
  // unlockConsole() fetches these immediately on login, in this exact
  // sequence, all inside one try/catch — if any of them 404s or 401s
  // unmocked, the whole console silently reverts to the login gate with
  // "Invalid or expired session", which is confusing to debug from the
  // failure site alone. Mock them here, before login, not per-test after.
  await page.route('**/api/admin/redemptions**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(pendingRedemptions),
  }));
  await page.route('**/api/admin/reward-tiers', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rewardTiers) });
  });

  await page.goto('/admin.html');
  await page.locator('#admin-email-input').fill('admin@example.com');
  await page.locator('#admin-password-input').fill('password123');
  await page.locator('#key-form').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#console')).toBeVisible();
}

async function answerAllQuestions(page) {
  // renderQuiz() shows the modal immediately, then populates it once
  // /videos/:id/questions resolves — wait for the real content, not just
  // panel visibility, or there's nothing yet to check.
  await expect(page.locator('.quiz-question')).toHaveCount(3);
  const questionCount = await page.locator('.quiz-question').count();
  for (let i = 0; i < questionCount; i++) {
    await page.locator('.quiz-question').nth(i).locator('input[type=radio]').first().check();
  }
  // Belt-and-suspenders: verify every question still has a checked radio
  // immediately before submitting, re-checking any that didn't stick —
  // guards against timing jitter in slower/headless environments.
  for (let i = 0; i < questionCount; i++) {
    const group = page.locator('.quiz-question').nth(i);
    const anyChecked = await group.locator('input[type=radio]:checked').count();
    if (anyChecked === 0) await group.locator('input[type=radio]').first().check();
  }
}

// ---------- Quiz flow ----------

test.describe('Quiz flow', () => {
  const questions = [
    { id: 'q1', question: 'Question one?', options: ['A', 'B'] },
    { id: 'q2', question: 'Question two?', options: ['A', 'B'] },
    { id: 'q3', question: 'Question three?', options: ['A', 'B'] },
  ];

  async function openQuiz(page) {
    await loginAsMember(page, {
      videos: [{ id: 'v1', youtube_video_id: 'dQw4w9WgXcQ', title: 'Sample video', duration_seconds: 1650, points_reward: 15, quiz_bonus_points: 5, active: true, daily_limit: 5, referral_count: 0 }],
    });
    await page.route('**/api/session/start', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'quiz_pending', sessionId: 'sess1', sessionToken: 'tok1' }),
    }));
    await page.route('**/api/videos/v1/questions', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(questions),
    }));

    await page.locator('[data-page="explore"]').click();
    await page.locator('.video-card button').first().click();
    await expect(page.locator('#quiz-panel')).toBeVisible();
  }

  test('renders all questions and blocks submission until every one is answered', async ({ page }) => {
    await openQuiz(page);
    await expect(page.locator('.quiz-question')).toHaveCount(3);

    // Answer only 2 of 3, then try to submit
    await page.locator('.quiz-question').nth(0).locator('input[type=radio]').first().check();
    await page.locator('.quiz-question').nth(1).locator('input[type=radio]').first().check();
    await page.locator('#quiz-submit-btn').click();
    await expect(page.locator('#quiz-result')).toContainText('Answer every question');
  });

  test('submits and shows a bonus message on a perfect score', async ({ page }) => {
    await openQuiz(page);
    await page.route('**/api/session/sess1/quiz', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ passed: true, correct: 3, total: 3, pointsEarned: 15, quizBonusPoints: 5 }),
    }));

    await answerAllQuestions(page);
    await page.locator('#quiz-submit-btn').click();
    await expect(page.locator('#quiz-result')).toContainText('bonus');
  });

  test('an imperfect score still earns a proportional bonus and does not allow retrying', async ({ page }) => {
    await openQuiz(page);
    await page.route('**/api/session/sess1/quiz', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ correct: 2, total: 3, pointsEarned: 6, quizBonusPoints: 6 }),
    }));

    await answerAllQuestions(page);
    await page.locator('#quiz-submit-btn').click();
    await expect(page.locator('#quiz-result')).toContainText('2/3 correct');
    await expect(page.locator('#quiz-result')).toContainText('+6 bonus points');
    // Submission is one-shot — the video's base reward is already secured
    // regardless of quiz score, so there's nothing to retry. The button
    // hides after submitting, same as a perfect score.
    await expect(page.locator('#quiz-submit-btn')).toBeHidden();
  });

  test('keeps keyboard focus trapped inside the modal', async ({ page }) => {
    await openQuiz(page);
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const stillInside = await page.evaluate(() => document.getElementById('quiz-panel').contains(document.activeElement));
      expect(stillInside).toBe(true);
    }
  });

  test('Escape closes the quiz modal', async ({ page }) => {
    await openQuiz(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#quiz-panel')).toBeHidden();
  });
});

// ---------- Reward tiers ----------

test.describe('Reward tiers', () => {
  const rewardTiers = [
    { id: 't1', points_required: 2000, airtime_ghs: 100, data_ghs: 100, cash_ghs: 100 },
    { id: 't2', points_required: 3000, airtime_ghs: 150, data_ghs: 150, cash_ghs: 150 },
    { id: 't3', points_required: 4000, airtime_ghs: 200, data_ghs: 200, cash_ghs: 200 },
    { id: 't4', points_required: 10000, airtime_ghs: 500, data_ghs: 500, cash_ghs: 500 },
  ];

  test('cash tiers use the same affordability rule as airtime and data — no separate unlock threshold', async ({ page }) => {
    await loginAsMember(page, { pointsBalance: 3000, rewardTiers });
    await page.locator('[data-page="rewards"]').click();
    // Cash is the default active tab. All four tiers exist, but only the
    // ones this balance can actually afford (2,000 and 3,000) should be
    // enabled — no tier-independent "unlocks at 5,000" gate anymore.
    const options = page.locator('.redeem-tier-option');
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).not.toHaveClass(/disabled/); // 2,000 pts
    await expect(options.nth(1)).not.toHaveClass(/disabled/); // 3,000 pts
    await expect(options.nth(2)).toHaveClass(/disabled/); // 4,000 pts — unaffordable
    await expect(options.nth(3)).toHaveClass(/disabled/); // 10,000 pts — unaffordable
    await expect(page.locator('.redeem-tier-note')).toHaveCount(0);
  });

  test('formats every reward type — including data — as a flat GHS amount', async ({ page }) => {
    await loginAsMember(page, { pointsBalance: 10000, rewardTiers });
    await page.locator('[data-page="rewards"]').click();
    await page.locator('.redeem-tab[data-type="data_bundle"]').click();
    const amounts = await page.locator('.redeem-tier-amount').allInnerTexts();
    expect(amounts).toEqual(['100 GHS', '150 GHS', '200 GHS', '500 GHS']);
  });

  test('submits the selected tier and destination to the redeem endpoint', async ({ page }) => {
    await loginAsMember(page, { pointsBalance: 10000, rewardTiers });
    let redeemBody = null;
    await page.route('**/api/redeem', (route) => {
      redeemBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'r1', status: 'pending' }) });
    });

    await page.locator('[data-page="rewards"]').click();
    await page.locator('.redeem-tab[data-type="airtime"]').click();
    await expect(page.locator('#redeem-submit-btn')).toBeDisabled();

    await page.locator('.redeem-tier-option', { hasText: '2,000 pts' }).click();
    await page.locator('#redeem-destination').fill('+233555000111');
    await expect(page.locator('#redeem-submit-btn')).toBeEnabled();
    await Promise.all([
      page.waitForResponse('**/api/redeem'),
      page.locator('#redeem-submit-btn').click(),
    ]);

    expect(redeemBody).toEqual({ pointsRequired: 2000, rewardType: 'airtime', destination: '+233555000111' });
    await expect(page.locator('#redeem-message')).toContainText('24 hours');
  });
});

// ---------- Admin payout workflow ----------

test.describe('Admin payout workflow', () => {
  const pendingRedemption = {
    id: 'r1',
    email: 'member@example.com',
    reward_type: 'airtime',
    reward_amount_label: '20 GHS airtime',
    points_spent: 2000,
    destination: '+233555000111',
    status: 'pending',
    created_at: '2026-09-01T10:00:00Z',
  };

  test('admin can fulfill a pending redemption after confirming', async ({ page }) => {
    await loginAsAdmin(page, { pendingRedemptions: [pendingRedemption] });

    let resolveBody = null;
    await page.route('**/api/admin/redemptions/r1/resolve', (route) => {
      resolveBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'r1', status: 'fulfilled' }) });
    });

    await page.locator('[data-panel="redemptions"]').click();
    await expect(page.locator('.admin-row', { hasText: '20 GHS airtime' })).toBeVisible();
    await expect(page.locator('.admin-row', { hasText: '+233555000111' })).toBeVisible();

    await page.locator('.btn-approve[data-action="fulfilled"]').click();
    await expect(page.locator('#admin-confirm')).toBeVisible();
    await Promise.all([
      page.waitForResponse('**/api/admin/redemptions/r1/resolve'),
      page.locator('#admin-confirm-accept').click(),
    ]);

    expect(resolveBody).toEqual({ status: 'fulfilled' });
  });

  test('admin can reject a pending redemption after confirming', async ({ page }) => {
    await loginAsAdmin(page, { pendingRedemptions: [pendingRedemption] });

    let resolveBody = null;
    await page.route('**/api/admin/redemptions/r1/resolve', (route) => {
      resolveBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'r1', status: 'rejected' }) });
    });

    await page.locator('[data-panel="redemptions"]').click();
    await page.locator('.btn-reject[data-action="rejected"]').click();
    await Promise.all([
      page.waitForResponse('**/api/admin/redemptions/r1/resolve'),
      page.locator('#admin-confirm-accept').click(),
    ]);

    expect(resolveBody).toEqual({ status: 'rejected' });
  });

  test('cancelling the confirmation dialog does not resolve the redemption', async ({ page }) => {
    await loginAsAdmin(page, { pendingRedemptions: [pendingRedemption] });
    let resolveCalled = false;
    await page.route('**/api/admin/redemptions/r1/resolve', (route) => {
      resolveCalled = true;
      return route.fulfill({ status: 200, body: '{}' });
    });

    await page.locator('[data-panel="redemptions"]').click();
    await page.locator('.btn-approve[data-action="fulfilled"]').click();
    await page.locator('#admin-confirm-cancel').click();
    await expect(page.locator('#admin-confirm')).toBeHidden();
    expect(resolveCalled).toBe(false);
  });

  test('admin can edit reward tier amounts', async ({ page }) => {
    await loginAsAdmin(page, {
      rewardTiers: [{ id: 'tier-500', points_required: 500, airtime_ghs: 5, data_mb: 521.03, cash_ghs: null, active: true }],
    });
    let patchBody = null;
    await page.route('**/api/admin/reward-tiers/tier-500', (route) => {
      patchBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tier-500' }) });
    });

    await page.locator('[data-panel="settings"]').click();
    const airtimeInput = page.locator('.reward-tier-row[data-id="tier-500"] input[data-field="airtimeGhs"]');
    await airtimeInput.fill('7.5');
    await Promise.all([
      page.waitForResponse('**/api/admin/reward-tiers/tier-500'),
      airtimeInput.blur(),
    ]);

    expect(patchBody).toEqual({ airtimeGhs: 7.5 });
  });
});
