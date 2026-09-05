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

      // Start a round first (vote buttons only appear after round starts)
      await host.startNewRound();

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

      // BK-001: the rename must survive a reload — identity is only
      // persisted at join time, so without the fix the join-time name
      // ('Anonymous') would reappear after the reload.
      await user.page.reload({ waitUntil: 'networkidle' });
      await user.waitForReady();
      await expect(user.page.locator('body')).toContainText('Bob');
      await expect(user.page.locator('main ul li')).toHaveCount(1);
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

      // Start a round to make vote buttons visible
      await user.startNewRound();

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

      // Start a round first
      await user1.startNewRound();

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
      // The user is the first participant, so they are the moderator. The
      // room has no password and no allowAllParticipantsToReveal: revealing
      // after the reconnect only works if the moderator role survived the
      // reload (identity reuse — the fix for "moderator lost after reload").
      const { roomCode } = await user.createRoom();

      // Join and start a round
      await user.navigate(`/${roomCode}`);
      await user.waitForReady();
      await user.startNewRound();
      await user.castVote(5);
      await user.page.waitForTimeout(500);

      // Disconnect (simulate network offline)
      await user.disconnect();
      await user.page.waitForTimeout(1000);

      // Reconnect by reloading
      await user.reconnect();
      await user.waitForReady();

      // The same participant rejoined (stored identity): exactly one own row
      // with the moderator crown — no duplicate from the reload.
      await expect(user.page.locator('body')).toContainText('Connected');
      await expect(user.page.locator('[data-value="5"]')).toBeDisabled({ timeout: 10_000 });
      await expect(user.page.locator('main ul li')).toHaveCount(1);
      await expect(user.page.locator('body')).toContainText('👑');

      // Reveal as the (still) moderator and verify
      await user.revealRound();
      await user.page.waitForTimeout(500);

      await expect(user.page.locator('body')).toContainText('Revealed!');
      await expect(user.page.locator('body')).toContainText('5');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([user], outputDir, msg);
      throw error;
    } finally {
      await ctx.close();
    }
  });

  test('BK-016: leaving participants stay gone from the moderator roster', async ({ browser }) => {
    const outputDir = testOutputDir('leave-ghosting');
    const hostCtx = await browser.newContext();
    const guest1Ctx = await browser.newContext();
    const guest2Ctx = await browser.newContext();

    const host = await BrowserUser.create(hostCtx, 'Host');
    const guest1 = await BrowserUser.create(guest1Ctx, 'Guest1');
    const guest2 = await BrowserUser.create(guest2Ctx, 'Guest2');

    try {
      // User scenario: moderator + two participants, round voted and revealed.
      const { roomCode } = await host.createRoom();
      expect(roomCode).toBeTruthy();

      await host.navigate(`/${roomCode}`);
      await host.waitForReady();
      await guest1.navigate(`/${roomCode}`);
      await guest1.waitForReady();
      await guest2.navigate(`/${roomCode}`);
      await guest2.waitForReady();

      // All three are in the roster.
      await expect(host.page.locator('main ul li')).toHaveCount(3, { timeout: 10_000 });

      await host.startNewRound();
      await host.castVote(5);
      await guest1.castVote(8);
      await guest2.castVote(13);
      await host.page.waitForTimeout(500);
      await host.revealRound();
      await host.page.waitForTimeout(500);
      await expect(host.page.locator('body')).toContainText('Revealed!');

      // Both participants leave during the results view.
      await guest1.page.locator('button', { hasText: 'Leave Room' }).click();
      await guest1.page.waitForURL('**/');
      await guest2.page.locator('button', { hasText: 'Leave Room' }).click();
      await guest2.page.waitForURL('**/');

      // The disconnects land: the moderator roster drops to the moderator alone.
      await expect(host.page.locator('main ul li')).toHaveCount(1, { timeout: 10_000 });

      // BK-016: it must STAY at one. Before the fix, the abandoned
      // WebSocketClient reconnected with the same room/participant ids ~1 s
      // after the leave (onclose → attemptReconnect, backoff 1 s · 1.5^n),
      // so the leavers re-appeared in the moderator's roster moments later.
      // Waiting past the full backoff window (max attempt ~5 s) proves the
      // orphaned clients are really dead.
      await host.page.waitForTimeout(8_000);
      await expect(host.page.locator('main ul li')).toHaveCount(1);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([host, guest1, guest2], outputDir, msg);
      throw error;
    } finally {
      await hostCtx.close();
      await guest1Ctx.close();
      await guest2Ctx.close();
    }
  });

  test('password-protected room: creator becomes moderator, guest joins via dialog', async ({
    browser,
  }) => {
    const outputDir = testOutputDir('password-room');
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();

    const host = await BrowserUser.create(hostCtx, 'Host');
    const guest = await BrowserUser.create(guestCtx, 'Guest');

    try {
      // BK-002: creator creates a password-protected room via the HomePage UI.
      // The auto-join must carry the password so the creator lands in the room
      // as the first verified participant — and therefore as moderator.
      await host.navigate('/');
      await host.page.locator('#creatorName').fill('Host');
      await host.page.locator('button', { hasText: 'Room Settings' }).click();
      await host.page.locator('#moderatorPassword').fill('secret-123');
      await host.page.locator('button', { hasText: 'Create Room' }).click();
      await host.waitForReady();

      // The host is in the room with the moderator crown
      const hostItem = host.page.locator('main ul li').filter({ hasText: 'Host' });
      await expect(hostItem).toContainText('👑', { timeout: 10_000 });

      const roomCode = new URL(host.page.url()).pathname.slice(1);
      expect(roomCode).toBeTruthy();

      // Guest joins via the HomePage join form — no password sent yet
      await guest.navigate('/');
      await guest.page.locator('#roomCode').fill(roomCode);
      await guest.page.locator('#participantName').fill('Guest');
      await guest.page.locator('button', { hasText: 'Join Room' }).click();

      // Password dialog appears
      const dialog = guest.page.getByRole('dialog');
      await expect(dialog).toContainText('This room requires a password');

      // Wrong password shows an error and keeps the dialog open
      await dialog.getByPlaceholder('Room password').fill('wrong-password');
      await dialog.getByRole('button', { name: 'Join' }).click();
      await expect(dialog).toContainText('Incorrect password');

      // Correct password joins the room as a regular member
      await dialog.getByPlaceholder('Room password').fill('secret-123');
      await dialog.getByRole('button', { name: 'Join' }).click();
      await guest.waitForReady();

      // Single moderator: the host keeps the crown, the guest stays a member
      await expect(guest.page.locator('body')).toContainText('Guest');
      const guestCrown = guest.page.locator('main ul li').filter({ hasText: 'Host' });
      await expect(guestCrown).toContainText('👑');
      const guestItem = guest.page.locator('main ul li').filter({ hasText: 'Guest' });
      await expect(guestItem).not.toContainText('👑');

      // Full cycle: moderator-only controls on the host, member can vote
      await host.startNewRound();
      await host.castVote(5);
      await guest.castVote(8);
      await host.page.waitForTimeout(500);
      await host.revealRound();
      await host.page.waitForTimeout(500);

      await expect(host.page.locator('body')).toContainText('Revealed!');
      await expect(host.page.locator('body')).toContainText('6.5');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await BrowserUser.dumpAll([host, guest], outputDir, msg);
      throw error;
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
