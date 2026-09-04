import { test, expect, type Page } from '@playwright/test';

// Room creation points at the deployed dev API by default. SMOKE_* overrides
// let the advanced scenarios run against the local in-memory server too
// (e.g. SMOKE_API_BASE=http://localhost:3000 SMOKE_FRONTEND_URL=http://localhost:5173).
const API_BASE = process.env.SMOKE_API_BASE ?? 'https://api.dev.estimatenest.net';
const API_KEY = process.env.SMOKE_API_KEY ?? 'estimatenest-dev-851725560801-eu-central-1';

interface RoomInfo {
  roomId: string;
  shortCode: string;
}

interface CreateRoomOptions {
  deck?: string;
  autoRevealEnabled?: boolean;
  autoRevealCountdownSeconds?: number;
  moderatorPassword?: string;
}

async function createRoom(options: CreateRoomOptions = {}): Promise<RoomInfo> {
  const res = await fetch(`${API_BASE}/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      deck: options.deck ?? 'fibonacci',
      // autoRevealEnabled off by default: once everyone voted, the full-screen
      // countdown overlay would otherwise race (and intercept) the manual
      // reveal clicks the multi-user suite performs — the manual flow must
      // stay deterministic.
      autoRevealEnabled: options.autoRevealEnabled ?? false,
      ...(options.autoRevealCountdownSeconds !== undefined
        ? { autoRevealCountdownSeconds: options.autoRevealCountdownSeconds }
        : {}),
      ...(options.moderatorPassword ? { moderatorPassword: options.moderatorPassword } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create room: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function waitForRoomReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.body.textContent?.includes('Connecting...'), {
    timeout: 30_000,
  });
  await page.waitForSelector('text=Participants', { timeout: 30_000 });
}

/** Join via the HomePage form — the flow that surfaces the password dialog. */
async function joinViaHomePage(page: Page, code: string, name: string): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.locator('#roomCode').fill(code);
  await page.locator('#participantName').fill(name);
  await page.locator('button', { hasText: 'Join Room' }).click();
}

/** Start a new round with retry (mirrors the multi-user helper). */
async function startRound(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = page.locator('button', { hasText: 'New Round' });
    await btn.waitFor({ state: 'visible', timeout: 10_000 });
    await btn.click();
    try {
      await page.waitForSelector('[data-value]', { timeout: 8_000 });
      return; // success
    } catch {
      if (attempt < 2) {
        console.log(`  Retry startRound (attempt ${attempt + 2})...`);
        await page.waitForTimeout(1000);
      }
    }
  }
  throw new Error('Failed to start round after 3 attempts');
}

test.describe('Dev Smoke — SEO basics', () => {
  test('home page ships robots noindex and OG tags (dev must not rank)', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const html = await res.text();

    expect(html).toMatch(/<meta name="robots" content="noindex,nofollow"/);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:image"');
  });

  test('sitemap.xml and robots.txt are served', async ({ request }) => {
    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain('<loc>');

    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain('Sitemap:');
  });
});

test.describe('Dev Smoke — Multi-User Estimation', () => {
  test.setTimeout(120_000);

  test('three participants complete multiple voting rounds', async ({ browser }) => {
    // Step 1: Create a room via REST API
    const room = await createRoom();
    expect(room.shortCode).toBeTruthy();
    console.log(`Room created: ${room.shortCode}`);

    // Step 2: Open three browser contexts (isolated sessions)
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const charlieCtx = await browser.newContext();

    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();
    const charliePage = await charlieCtx.newPage();

    // Collect console logs for debugging
    const logs: string[] = [];
    for (const [name, page] of Object.entries({
      alice: alicePage,
      bob: bobPage,
      charlie: charliePage,
    })) {
      page.on('console', (msg) => {
        logs.push(`[${name}] ${msg.type()}: ${msg.text().substring(0, 120)}`);
      });
    }

    try {
      // Step 3: Alice navigates first (becomes moderator)
      await alicePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' });
      await alicePage.waitForFunction(() => !document.body.textContent?.includes('Connecting...'), {
        timeout: 30_000,
      });
      await expect(alicePage.locator('body')).toContainText(room.shortCode);
      await alicePage.waitForSelector('text=Participants', { timeout: 30_000 });

      // Step 4: Bob and Charlie join after Alice (Alice stays moderator)
      await Promise.all([
        bobPage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
        charliePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
      ]);
      for (const [name, page] of Object.entries({ bob: bobPage, charlie: charliePage })) {
        await page.waitForFunction(() => !document.body.textContent?.includes('Connecting...'), {
          timeout: 30_000,
        });
        await expect(page.locator('body')).toContainText(room.shortCode);
      }

      // Step 5: Wait until all 3 participants appear in Alice's view.
      await expect
        .poll(() => alicePage.locator('text=Participants (3)').isVisible(), { timeout: 30_000 })
        .toBeTruthy();

      console.log('All 3 participants connected');

      // ── Helper: start a new round with retry ─────────────────
      async function startRound(page: typeof alicePage) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const btn = page.locator('button', { hasText: 'New Round' });
          await btn.waitFor({ state: 'visible', timeout: 10_000 });
          await btn.click();
          try {
            await page.waitForSelector('[data-value]', { timeout: 8_000 });
            return; // success
          } catch {
            if (attempt < 2) {
              console.log(`  Retry startRound (attempt ${attempt + 2})...`);
              await page.waitForTimeout(1000);
            }
          }
        }
        throw new Error('Failed to start round after 3 attempts');
      }

      // ── Sync helpers ─────────────────────────────────────────
      // Vote fan-out over API Gateway can lag by hundreds of ms. Only reveal
      // once the host sees all votes registered, and only start the next
      // round once every client rendered the reveal — otherwise a client
      // still on the previous (active) round would cast its vote into that
      // stale round and the vote would be silently lost.
      async function waitForAllVotesCast(page: typeof alicePage) {
        await expect(page.locator('body')).toContainText('3 vote(s) cast.', { timeout: 20_000 });
      }
      async function waitForRevealOnAll() {
        for (const [name, page] of Object.entries({
          alice: alicePage,
          bob: bobPage,
          charlie: charliePage,
        })) {
          await expect(page.locator('body')).toContainText('Revealed!', { timeout: 20_000 });
        }
      }

      // ── Round 1 ──────────────────────────────────────────────
      console.log('--- Round 1 ---');
      await startRound(alicePage);

      // Everyone votes
      await alicePage.locator('[data-value="5"]').click();
      await bobPage.locator('[data-value="8"]').click();
      await charliePage.locator('[data-value="13"]').click();
      await waitForAllVotesCast(alicePage);

      // Alice reveals
      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(500);

      // Verify results on Alice's screen
      await expect(alicePage.locator('body')).toContainText('Revealed!');
      await expect(alicePage.locator('body')).toContainText('5');
      await expect(alicePage.locator('body')).toContainText('8');
      await expect(alicePage.locator('body')).toContainText('13');
      // Average: (5+8+13)/3 = 8.7 (rounded to 1 decimal)
      await expect(alicePage.locator('body')).toContainText('8.7');
      console.log('Round 1 revealed — average 8.7');
      await waitForRevealOnAll();

      // ── Round 2 ──────────────────────────────────────────────
      console.log('--- Round 2 ---');
      await startRound(alicePage);

      await alicePage.locator('[data-value="1"]').click();
      await bobPage.locator('[data-value="2"]').click();
      await charliePage.locator('[data-value="3"]').click();
      await waitForAllVotesCast(alicePage);

      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(500);

      await expect(alicePage.locator('body')).toContainText('Revealed!');
      await expect(alicePage.locator('body')).toContainText('2.0');
      console.log('Round 2 revealed — average 2.0');
      await waitForRevealOnAll();

      // ── Round 3 ──────────────────────────────────────────────
      console.log('--- Round 3 ---');
      await startRound(alicePage);

      await alicePage.locator('[data-value="40"]').click();
      await bobPage.locator('[data-value="100"]').click();
      await charliePage.locator('[data-value="?"]').click();
      await waitForAllVotesCast(alicePage);

      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(500);

      await expect(alicePage.locator('body')).toContainText('Revealed!');
      // "?" is a special value — should still be displayed
      await expect(alicePage.locator('body')).toContainText('?');
      console.log('Round 3 revealed with special card');
    } catch (error) {
      // Dump logs on failure
      console.log('=== FAILURE LOGS ===');
      console.log(logs.join('\n'));
      throw error;
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
      await charlieCtx.close();
    }
  });
});

test.describe('Dev Smoke — Password, auto-reveal and moderator handover', () => {
  test('password-protected room: dialog gates joins, first member is moderator', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const room = await createRoom({ moderatorPassword: 'secret-123' });
    expect(room.shortCode).toBeTruthy();
    console.log(`Password room created: ${room.shortCode}`);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    try {
      // Alice joins first — the join without a password opens the dialog.
      await joinViaHomePage(alicePage, room.shortCode, 'Alice');
      const aliceDialog = alicePage.getByRole('dialog');
      await expect(aliceDialog).toContainText('This room requires a password');
      await aliceDialog.getByPlaceholder('Room password').fill('secret-123');
      await aliceDialog.getByRole('button', { name: 'Join' }).click();
      await waitForRoomReady(alicePage);

      // First verified participant becomes the moderator.
      const aliceItem = alicePage.locator('main ul li').filter({ hasText: 'Alice' });
      await expect(aliceItem).toContainText('👑', { timeout: 10_000 });

      // Bob types a wrong password first — the error keeps the dialog open.
      await joinViaHomePage(bobPage, room.shortCode, 'Bob');
      const bobDialog = bobPage.getByRole('dialog');
      await expect(bobDialog).toContainText('This room requires a password');
      await bobDialog.getByPlaceholder('Room password').fill('wrong-password');
      await bobDialog.getByRole('button', { name: 'Join' }).click();
      await expect(bobDialog).toContainText('Incorrect password');

      // The correct password joins Bob as a regular member.
      await bobDialog.getByPlaceholder('Room password').fill('secret-123');
      await bobDialog.getByRole('button', { name: 'Join' }).click();
      await waitForRoomReady(bobPage);

      await expect(bobPage.locator('body')).toContainText('Bob');
      const bobItem = bobPage.locator('main ul li').filter({ hasText: 'Bob' });
      await expect(bobItem).not.toContainText('👑');

      // Mini cycle: Alice moderates, both vote, Alice reveals.
      await startRound(alicePage);
      await alicePage.locator('[data-value="5"]').click();
      await bobPage.locator('[data-value="8"]').click();
      await expect(alicePage.locator('body')).toContainText('2 vote(s) cast.', {
        timeout: 20_000,
      });
      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await expect(alicePage.locator('body')).toContainText('Revealed!', { timeout: 20_000 });
      await expect(alicePage.locator('body')).toContainText('6.5');
      console.log('Password room cycle complete — Alice moderator, Bob member');
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('auto-reveal reveals once everyone voted — no manual click', async ({ browser }) => {
    test.setTimeout(120_000);
    const room = await createRoom({
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 2,
    });
    expect(room.shortCode).toBeTruthy();
    console.log(`Auto-reveal room created: ${room.shortCode}`);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    try {
      await alicePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' });
      await waitForRoomReady(alicePage);
      await bobPage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' });
      await waitForRoomReady(bobPage);
      await expect
        .poll(() => alicePage.locator('text=Participants (2)').isVisible(), { timeout: 30_000 })
        .toBeTruthy();

      await startRound(alicePage);
      await alicePage.locator('[data-value="5"]').click();
      await bobPage.locator('[data-value="8"]').click();

      // No Reveal Votes click anywhere: the scheduled auto-reveal (2 s after
      // the last vote) must reveal on both sides. The 6.5 average proves both
      // votes were cast — a premature reveal would show a single value.
      await expect(alicePage.locator('body')).toContainText('Revealed!', { timeout: 20_000 });
      await expect(alicePage.locator('body')).toContainText('6.5');
      await expect(bobPage.locator('body')).toContainText('Revealed!', { timeout: 20_000 });
      await expect(bobPage.locator('body')).toContainText('6.5');
      console.log('Auto-reveal fired without a manual reveal');
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
    }
  });

  test('moderator role hands over after the moderator leaves as the last live participant', async ({
    browser,
  }) => {
    // ~10 s joins + ~5 s leave + 65 s grace wait + ~15 s join/promotion +
    // ~15 s round — exceeds the 120 s default, so raise the timeout.
    test.setTimeout(180_000);
    const room = await createRoom();
    expect(room.shortCode).toBeTruthy();
    console.log(`Handover room created: ${room.shortCode}`);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alicePage = await aliceCtx.newPage();
    const bobPage = await bobCtx.newPage();

    try {
      // Alice joins alone and becomes the moderator.
      await joinViaHomePage(alicePage, room.shortCode, 'Alice');
      await waitForRoomReady(alicePage);
      const aliceItem = alicePage.locator('main ul li').filter({ hasText: 'Alice' });
      await expect(aliceItem).toContainText('👑', { timeout: 10_000 });

      // Alice leaves as the last live connection. Closing the context triggers
      // the API Gateway $disconnect, which must mark the moderator vacancy
      // even without any other participant present (BK-011).
      await aliceCtx.close();

      // Wait out the 60 s moderator-handoff grace (65 s covers disconnect
      // delivery lag).
      console.log('Alice left as the last participant — waiting 65 s for the handoff grace...');
      await bobPage.waitForTimeout(65_000);

      // Bob joins after the grace window: his join (or the subsequent
      // connect) resolves the vacancy — he is promoted, the dormant Alice row
      // is demoted.
      await joinViaHomePage(bobPage, room.shortCode, 'Bob');
      await waitForRoomReady(bobPage);

      await expect(bobPage.locator('body')).toContainText('Bob');
      const bobItem = bobPage.locator('main ul li').filter({ hasText: 'Bob' });
      await expect(bobItem).toContainText('👑', { timeout: 15_000 });
      // Only the promoted Bob remains — the dormant Alice row is filtered out.
      await expect(bobPage.locator('main ul li')).toHaveCount(1);

      // Bob now moderates: starts a round, votes, reveals.
      await startRound(bobPage);
      await bobPage.locator('[data-value="3"]').click();
      await expect(bobPage.locator('[data-value="3"]')).toBeDisabled({ timeout: 10_000 });
      await bobPage.locator('button', { hasText: 'Reveal Votes' }).click();
      await expect(bobPage.locator('body')).toContainText('Revealed!', { timeout: 20_000 });
      await expect(bobPage.locator('body')).toContainText('3.0');
      console.log('Moderator role handed over to the next joiner after the grace window');
    } finally {
      await bobCtx.close();
    }
  });
});
