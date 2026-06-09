import { test, expect } from '@playwright/test';

const API_BASE = 'https://api.dev.estimatenest.net';
const WS_BASE = 'wss://ws.dev.estimatenest.net';
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
      // Step 3: All navigate to the room
      await Promise.all([
        alicePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
        bobPage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
        charliePage.goto(`/${room.shortCode}`, { waitUntil: 'networkidle' }),
      ]);

      // Step 4: Wait for all to connect — "Connecting..." disappears and room code appears
      for (const [name, page] of Object.entries({ alice: alicePage, bob: bobPage, charlie: charliePage })) {
        await page.waitForFunction(
          () => !document.body.textContent?.includes('Connecting...'),
          { timeout: 30_000 }
        );
        await expect(page.locator('body')).toContainText(room.shortCode);
        // Wait for participant list to populate
        await page.waitForSelector('text=Participants', { timeout: 15_000 });
      }

      // Step 5: Wait until all 3 participants appear in Alice's view.
      await expect
        .poll(() => alicePage.locator('text=Participants (3)').isVisible(), { timeout: 30_000 })
        .toBeTruthy();

      console.log('All 3 participants connected');

      // ── Round 1 ──────────────────────────────────────────────
      console.log('--- Round 1 ---');

      // Alice (moderator) starts a new round
      const newRoundBtn = alicePage.locator('button', { hasText: 'New Round' });
      await newRoundBtn.click();

      // Wait for vote buttons to appear for everyone
      for (const page of [alicePage, bobPage, charliePage]) {
        await page.waitForSelector('[data-value]', { timeout: 10_000 });
      }

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

      await alicePage.locator('button', { hasText: 'New Round' }).click();
      for (const page of [alicePage, bobPage, charliePage]) {
        await page.waitForSelector('[data-value]', { timeout: 10_000 });
      }

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

      await alicePage.locator('button', { hasText: 'New Round' }).click();
      for (const page of [alicePage, bobPage, charliePage]) {
        await page.waitForSelector('[data-value]', { timeout: 10_000 });
      }

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

      // ── Verify disconnect/reconnect ──────────────────────────
      console.log('--- Disconnect test ---');

      // Bob disconnects (go offline)
      await bobCtx.setOffline(true);
      await alicePage.waitForTimeout(3000);

      // Bob reconnects
      await bobCtx.setOffline(false);
      await bobPage.reload({ waitUntil: 'networkidle' });
      await bobPage.waitForFunction(
        () => !document.body.textContent?.includes('Connecting...'),
        { timeout: 20_000 }
      );

      // Bob should see the room again
      await expect(bobPage.locator('body')).toContainText(room.shortCode);
      console.log('Bob reconnected successfully');

      // ── Final round after reconnect ──────────────────────────
      console.log('--- Round 4 (after reconnect) ---');

      await alicePage.locator('button', { hasText: 'New Round' }).click();
      for (const page of [alicePage, bobPage, charliePage]) {
        await page.waitForSelector('[data-value]', { timeout: 10_000 });
      }

      await alicePage.locator('[data-value="20"]').click();
      await bobPage.locator('[data-value="20"]').click();
      await charliePage.locator('[data-value="20"]').click();
      await alicePage.waitForTimeout(500);

      await alicePage.locator('button', { hasText: 'Reveal Votes' }).click();
      await alicePage.waitForTimeout(1000);

      await expect(alicePage.locator('body')).toContainText('Revealed!');
      await expect(alicePage.locator('body')).toContainText('20.0');
      console.log('Round 4 revealed — unanimous 20');

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
