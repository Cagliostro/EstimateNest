import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UserLogger, mergeLogs, formatMergedLogs, formatWSSummary } from './logger';
import type { RoomOptions, CreateRoomResult } from '../types';
import fs from 'fs';

const API_BASE = 'http://localhost:3000';

export class BrowserUser {
  public readonly logger: UserLogger;
  public readonly page: Page;
  public readonly context: BrowserContext;
  public participantId?: string;
  public roomId?: string;
  public roomCode?: string;

  private constructor(context: BrowserContext, page: Page, name: string) {
    this.context = context;
    this.page = page;
    this.logger = new UserLogger(name);
    this.attachListeners();
  }

  static async create(context: BrowserContext, name: string): Promise<BrowserUser> {
    const page = await context.newPage();
    return new BrowserUser(context, page, name);
  }

  private attachListeners(): void {
    this.page.on('console', (msg) => {
      this.logger.logConsole(msg.type(), msg.text(), msg.location()?.url ?? '');
    });

    this.page.on('pageerror', (err) => {
      this.logger.logPageError(err.message, err.stack);
    });

    this.page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => this.logger.logWS('sent', String(frame.payload)));
      ws.on('framereceived', (frame) => this.logger.logWS('received', String(frame.payload)));
    });

    this.page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/rooms') || url.includes('/health')) {
        response
          .text()
          .then((body) => {
            this.logger.logNetwork(url, response.request().method(), response.status(), body);
          })
          .catch(() => {});
      }
    });
  }

  async navigate(path: string): Promise<void> {
    this.logger.logAction('navigate', { path });
    await this.page.goto(path, { waitUntil: 'networkidle' });
  }

  async createRoom(opts: RoomOptions = {}): Promise<CreateRoomResult> {
    this.logger.logAction('createRoom', opts);

    const response = await this.page.request.post(`${API_BASE}/rooms`, {
      data: {
        deck: opts.deck ?? 'fibonacci',
        ...(opts.moderatorPassword ? { moderatorPassword: opts.moderatorPassword } : {}),
        ...(opts.autoRevealEnabled !== undefined
          ? { autoRevealEnabled: opts.autoRevealEnabled }
          : {}),
        ...(opts.allowAllParticipantsToReveal !== undefined
          ? { allowAllParticipantsToReveal: opts.allowAllParticipantsToReveal }
          : {}),
        ...(opts.maxParticipants ? { maxParticipants: opts.maxParticipants } : {}),
      },
    });

    const body = (await response.json()) as Record<string, unknown>;

    if (!response.ok()) {
      this.logger.logActionResult('createRoom', { error: body });
      throw new Error(`Failed to create room: ${JSON.stringify(body)}`);
    }

    this.roomId = body.roomId as string;
    this.roomCode = body.shortCode as string;

    this.logger.logActionResult('createRoom', { roomCode: this.roomCode, roomId: this.roomId });

    return {
      roomCode: this.roomCode,
      participantId: '',
      roomId: this.roomId,
      joinUrl: `/${this.roomCode}`,
    };
  }

  async joinRoom(code: string, opts: { name?: string } = {}): Promise<void> {
    this.logger.logAction('joinRoom', { code, ...opts });
    this.roomCode = code;

    await this.navigate(`/${code}`);
    await this.waitForReady();

    // Extract participantId from the UI state for logging
    this.participantId = await this.page.evaluate(() => {
      return undefined as string | undefined;
    });

    this.logger.logActionResult('joinRoom', { roomCode: code });
  }

  async waitForReady(timeout = 20_000): Promise<void> {
    // Wait for voting buttons to appear (indicates WS connection + round loaded)
    await this.page.waitForSelector('[data-value]', { timeout });
    // Also check that we're connected
    await this.page.waitForFunction(
      () => {
        const body = document.body;
        return !body.textContent?.includes('Connecting...');
      },
      { timeout }
    );
  }

  async castVote(value: string | number): Promise<void> {
    this.logger.logAction('castVote', { value });
    const button = this.page.locator(`[data-value="${value}"]`);
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(button).toBeEnabled({ timeout: 10_000 });
    await button.click();
    this.logger.logActionResult('castVote', { value });
  }

  async revealRound(): Promise<void> {
    this.logger.logAction('reveal');
    const revealButton = this.page.locator('button', { hasText: 'Reveal' });
    await revealButton.click();
    this.logger.logActionResult('reveal');
  }

  async startNewRound(): Promise<void> {
    this.logger.logAction('startNewRound');
    const newRoundButton = this.page.locator('button', { hasText: 'New Round' });
    await newRoundButton.click();
    this.logger.logActionResult('startNewRound');
  }

  async changeName(name: string): Promise<void> {
    this.logger.logAction('changeName', { name });
    const editButton = this.page.locator('button[title="Edit name"]');
    await editButton.click();
    const nameInput = this.page.locator('input[type="text"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 5000 });
    await nameInput.fill(name);
    const saveButton = this.page.locator('button', { hasText: 'Save' });
    await saveButton.click();
    this.logger.logActionResult('changeName', { name });
  }

  async disconnect(): Promise<void> {
    this.logger.logAction('disconnect');
    this.context.setOffline(true);
    this.logger.logActionResult('disconnect');
  }

  async reconnect(): Promise<void> {
    this.logger.logAction('reconnect');
    await this.context.setOffline(false);
    await this.page.reload({ waitUntil: 'networkidle' });
    this.logger.logActionResult('reconnect');
    await this.waitForReady();
  }

  async waitForSelector(selector: string, timeout = 15_000): Promise<void> {
    await this.page.waitForSelector(selector, { timeout });
  }

  async dumpLogs(outputDir: string, errorMessage?: string): Promise<void> {
    try {
      await this.page.screenshot({ path: `${outputDir}/${this.logger.userName}-screenshot.png` });
    } catch {
      /* page might be closed */
    }
    try {
      const html = await this.page.content();
      await fs.promises.writeFile(`${outputDir}/${this.logger.userName}-dom.html`, html);
    } catch {
      /* page might be closed */
    }
    await this.logger.dump(outputDir, errorMessage);
  }

  static async dumpAll(
    users: BrowserUser[],
    outputDir: string,
    errorMessage: string
  ): Promise<void> {
    await Promise.all(users.map((u) => u.dumpLogs(outputDir, errorMessage)));

    const merged = mergeLogs(users.map((u) => u.logger));
    const mergedText = formatMergedLogs(merged);
    const wsSummary = formatWSSummary(users.map((u) => u.logger));

    await fs.promises.writeFile(`${outputDir}/all-events-merged.log`, mergedText);
    await fs.promises.writeFile(`${outputDir}/ws-summary.log`, wsSummary);
    await fs.promises.writeFile(`${outputDir}/error.log`, errorMessage);

    const summary = [
      `Error: ${errorMessage}`,
      '',
      `=== Merged Event Log (${merged.length} events) ===`,
      mergedText,
      '',
      '=== WebSocket Summary ===',
      wsSummary,
      '',
      '=== Network Requests ===',
      ...users.flatMap((u) =>
        u.logger
          .getNetworkRequests()
          .map((r) => `[${u.logger.userName}] ${r.method} ${r.url} \u2192 ${r.status}`)
      ),
    ].join('\n');

    await fs.promises.writeFile(`${outputDir}/failure-report.txt`, summary);
  }

  get name(): string {
    return this.logger.userName;
  }
}
