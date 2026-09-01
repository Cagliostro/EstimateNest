import { test, expect } from '@playwright/test';

const API_BASE = 'https://api.dev.estimatenest.net';
const API_KEY = 'estimatenest-dev-851725560801-eu-central-1';

interface RoomInfo {
  roomId: string;
  shortCode: string;
}

async function createRoom(): Promise<RoomInfo> {
  const res = await fetch(`${API_BASE}/rooms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({ deck: 'fibonacci' }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create room: ${res.status} ${await res.text()}`);
  }
  return await res.json();
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
    for (const [name, page] of Object.entries({ alice: alicePage, bob: bobPage, charlie: charliePage })) {
      page.on('console', (msg) => {
        logs.push(`[${name}] ${msg.type()}: ${msg.text().substring(0, 120)}`);
      });
    }

    try {
      // Step 3: Alice navigates first (becomes moderator)
      await alicePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' });
      await alicePage.waitForFunction(
        () => !document.body.textContent?.includes('Connecting...'),
        { timeout: 30_000 }
      );
      await expect(alicePage.locator('body')).toContainText(room.shortCode);
      await alicePage.waitForSelector('text=Participants', { timeout: 15_000 });

      // Step 4: Bob and Charlie join after Alice (Alice stays moderator)
      await Promise.all([
        bobPage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
        charliePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
      ]);
      for (const [name, page] of Object.entries({ bob: bobPage, charlie: charliePage })) {
        await page.waitForFunction(
          () => !document.body.textContent?.includes('Connecting...'),
          { timeout: 30_000 }
        );
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

      // ── Round 1 ──────────────────────────────────────────────
      console.log('--- Round 1 ---');
      await startRound(alicePage);

      // Everyone votes
      await alicePage.locator('[data-value="5"]').click();
      await bobPage.locator('[data-value="8"]').click();
      await charliePage.locator('[data-value="13"]').click();
      await alicePage.waitForTimeout(1000);

      // Alice reveals
      const revealBtn = alicePage.locator('button', { hasText: 'Reveal Votes' });
      await revealBtn.click();
      await alicePage.waitForTimeout(1000);

      // Verify results on Alice's screen
      await expect(alicePage.locator('body')).toContainText('Revealed!');
      await expect(alicePage.locator('body')).toContainText('5');
      await expect(alicePage.locator('body')).toContainText('8');
      await expect(alicePage.locator('body')).toContainText('13');
      // Average: (5+8+13)/3 = 8.7 (rounded to 1 decimal)
      await expect(alicePage.locator('body')).toContainText('8.7');
      console.log('Round 1 revealed — average 8.7');

      // ── Round 2 ──────────────────────────────────────────────
      console.log('--- Round 2 ---');
      await startRound(alicePage);

      await alicePage.locator('[data-value="1"]').click();
      await bobPage.locator('[data-value="2"]').click();
      await charliePage.locator('[data-value="3"]').click();
      await alicePage.waitForTimeout(500);

      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(1000);

      await expect(alicePage.locator('body')).toContainText('Revealed!');
      await expect(alicePage.locator('body')).toContainText('2.0');
      console.log('Round 2 revealed — average 2.0');

      // ── Round 3 ──────────────────────────────────────────────
      console.log('--- Round 3 ---');
      await startRound(alicePage);

      await alicePage.locator('[data-value="40"]').click();
      await bobPage.locator('[data-value="100"]').click();
      await charliePage.locator('[data-value="?"]').click();
      await alicePage.waitForTimeout(500);

      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(1000);

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
