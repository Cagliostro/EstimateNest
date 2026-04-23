import { test, expect } from '@playwright/test';
import { BrowserUser } from '../utils/browser-user';
import path from 'path';
import fs from 'fs';

test.describe('scenarios', () => {
  test.beforeEach(() => {
    // Clean output dir before each test (handle race by ignoring errors)
    const outputDir = path.join(__dirname, '..', 'test-results', 'scenarios');
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  function testOutputDir(testName: string): string {
    return path.join(__dirname, '..', 'test-results', 'scenarios', testName.replace(/\s+/g, '-'));
  }

  test('full voting cycle with reveal and new round', async ({ browser }) => {
    const outputDir = testOutputDir('voting-cycle');
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    const host = await BrowserUser.create(hostCtx, 'Host');
    const guest = await BrowserUser.create(guestCtx, 'Guest');

    try {
      const { roomCode } = await host.createRoom();
      expect(roomCode).toBeTruthy();

      await host.navigate(`/${roomCode}`);
      await host.waitForReady();
      await guest.navigate(`/${roomCode}`);
      await guest.waitForReady();

      // Both vote
      await host.castVote(5);
      await guest.castVote(8);
      await host.page.waitForTimeout(500);

      // Verify voting button is disabled after voting on host
      const host5Btn = host.page.locator('[data-value="5"]');
      await expect(host5Btn).toBeDisabled();

      // Host reveals
      await host.revealRound();
      await host.page.waitForTimeout(500);

      // Verify revealed state
      await expect(host.page.locator('body')).toContainText('Revealed!');
      await expect(host.page.locator('body')).toContainText('Results');
      await expect(host.page.locator('body')).toContainText('5');
      await expect(host.page.locator('body')).toContainText('8');
      await expect(host.page.locator('body')).toContainText('6.5');

      // Host starts new round
      await host.startNewRound();
      await host.page.waitForTimeout(500);

      // Verify new round state
      await expect(host.page.locator('body')).not.toContainText('Revealed!');
      await expect(host.page.locator('body')).toContainText('Ready for estimation');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([host, guest], outputDir, msg);
      throw error;
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });

  test('change participant name via UI', async ({ browser }) => {
    const outputDir = testOutputDir('change-name');
    const ctx = await browser.newContext();
    const user = await BrowserUser.create(ctx, 'User');

    try {
      const { roomCode } = await user.createRoom();
      await user.navigate(`/${roomCode}`);
      await user.waitForReady();

      // Default name is 'Anonymous' when participant store not pre-set
      await expect(user.page.locator('body')).toContainText('Anonymous');

      // Change name
      await user.changeName('Bob');

      // Wait for WS broadcast
      await user.page.waitForTimeout(500);

      // Verify new name visible in participant list area
      await expect(user.page.locator('body')).toContainText('Bob');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([user], outputDir, msg);
      throw error;
    } finally {
      await ctx.close();
    }
  });

  test('create room with tshirt deck', async ({ browser }) => {
    const outputDir = testOutputDir('tshirt-deck');
    const ctx = await browser.newContext();
    const user = await BrowserUser.create(ctx, 'User');

    try {
      const { roomCode } = await user.createRoom({ deck: 'tshirt' });
      await user.navigate(`/${roomCode}`);
      await user.waitForReady();

      // Verify tshirt values are rendered as voting buttons
      const expectedValues = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
      for (const val of expectedValues) {
        await expect(user.page.locator(`[data-value="${val}"]`)).toBeVisible();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([user], outputDir, msg);
      throw error;
    } finally {
      await ctx.close();
    }
  });

  test('multi-user voting with three participants', async ({ browser }) => {
    const outputDir = testOutputDir('multi-user');
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();

    const user1 = await BrowserUser.create(ctx1, 'Alice');
    const user2 = await BrowserUser.create(ctx2, 'Bob');
    const user3 = await BrowserUser.create(ctx3, 'Charlie');

    try {
      const { roomCode } = await user1.createRoom();

      await user1.navigate(`/${roomCode}`);
      await user1.waitForReady();
      await user2.navigate(`/${roomCode}`);
      await user2.waitForReady();
      await user3.navigate(`/${roomCode}`);
      await user3.waitForReady();

      // All vote
      await user1.castVote(3);
      await user2.castVote(8);
      await user3.castVote(13);
      await user1.page.waitForTimeout(500);

      // Reveal
      await user1.revealRound();
      await user1.page.waitForTimeout(500);

      // Verify all votes visible
      await expect(user1.page.locator('body')).toContainText('3');
      await expect(user1.page.locator('body')).toContainText('8');
      await expect(user1.page.locator('body')).toContainText('13');
      await expect(user1.page.locator('body')).toContainText('Revealed!');

      // Verify average: (3+8+13)/3 = 8.0
      await expect(user1.page.locator('body')).toContainText('8.0');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([user1, user2, user3], outputDir, msg);
      throw error;
    } finally {
      await ctx1.close();
      await ctx2.close();
      await ctx3.close();
    }
  });

  test('disconnect and reconnect flow', async ({ browser }) => {
    const outputDir = testOutputDir('disconnect-reconnect');
    const ctx = await browser.newContext();
    const user = await BrowserUser.create(ctx, 'User');

    try {
      // Create room with allowAllParticipantsToReveal so reconnected user can reveal
      const { roomCode } = await user.createRoom({ allowAllParticipantsToReveal: true });

      // Join and vote
      await user.navigate(`/${roomCode}`);
      await user.waitForReady();
      await user.castVote(5);
      await user.page.waitForTimeout(500);

      // Disconnect (simulate network offline)
      await user.disconnect();
      await user.page.waitForTimeout(1000);

      // Reconnect by reloading
      await user.reconnect();
      await user.waitForReady();

      // Verify voting buttons are available (WS reconnected)
      const voteButton = user.page.locator('[data-value="8"]');
      await expect(voteButton).toBeVisible({ timeout: 10_000 });
      await expect(voteButton).toBeEnabled({ timeout: 10_000 });

      // Cast a vote to confirm round interaction works after reconnect
      await user.castVote(8);
      await user.page.waitForTimeout(500);

      // Reveal and verify
      await user.revealRound();
      await user.page.waitForTimeout(500);

      await expect(user.page.locator('body')).toContainText('Revealed!');
      await expect(user.page.locator('body')).toContainText('8');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([user], outputDir, msg);
      throw error;
    } finally {
      await ctx.close();
    }
  });
});
