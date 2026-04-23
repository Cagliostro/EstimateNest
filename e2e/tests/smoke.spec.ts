import { test, expect } from '@playwright/test';
import { BrowserUser } from '../utils/browser-user';
import path from 'path';
import fs from 'fs';

test.describe('smoke', () => {
  const outputDir = path.join(__dirname, '..', 'test-results', 'smoke');

  test.beforeEach(() => {
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  test('create room and join via UI', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    const host = await BrowserUser.create(hostCtx, 'Host');
    const guest = await BrowserUser.create(guestCtx, 'Guest');

    try {
      // Host creates room via REST API
      const { roomCode } = await host.createRoom();
      expect(roomCode).toBeTruthy();
      expect(roomCode.length).toBeGreaterThanOrEqual(4);

      // Host navigates to the room — auto-join via WS
      await host.navigate(`/${roomCode}`);
      await host.waitForReady();

      // Guest navigates to the room — auto-join via WS
      await guest.navigate(`/${roomCode}`);
      await guest.waitForReady();
      await guest.waitForSelector('[data-value]');

      // Both should see the room code somewhere on the page
      await expect(host.page.locator('body')).toContainText(roomCode);
      await expect(guest.page.locator('body')).toContainText(roomCode);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([host, guest], path.join(outputDir, 'create-join-fail'), msg);
      throw error;
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test('full voting round with two users', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    const host = await BrowserUser.create(hostCtx, 'Host');
    const guest = await BrowserUser.create(guestCtx, 'Guest');

    try {
      // Create room
      const { roomCode } = await host.createRoom();

      // Both join the room page and wait for WS connection + voting UI
      await host.navigate(`/${roomCode}`);
      await host.waitForReady();
      await guest.navigate(`/${roomCode}`);
      await guest.waitForReady();

      // Host votes
      await host.castVote(5);

      // Guest votes
      await guest.castVote(8);

      // Wait for round updates to propagate
      await host.page.waitForTimeout(500);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([host, guest], path.join(outputDir, 'voting-fail'), msg);
      throw error;
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
