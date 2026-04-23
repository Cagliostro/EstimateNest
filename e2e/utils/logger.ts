import fs from 'fs';
import path from 'path';
import type { LogEntry, WSFrame, NetworkRequest } from '../types';

export class UserLogger {
  private events: LogEntry[] = [];
  private wsFrames: WSFrame[] = [];
  private networkRequests: NetworkRequest[] = [];

  constructor(public readonly userName: string) {}

  log(type: LogEntry['type'], data: Record<string, unknown>): void {
    this.events.push({
      type,
      timestamp: Date.now(),
      user: this.userName,
      data,
    });
  }

  logAction(action: string, args?: unknown): void {
    this.log('action', { action, args: args ?? {} });
  }

  logActionResult(action: string, result?: unknown): void {
    this.log('action_result', { action, result: result ?? {} });
  }

  logConsole(level: string, text: string, location?: string): void {
    this.log('console', { level, text, location: location ?? '' });
  }

  logPageError(message: string, stack?: string): void {
    this.log('pageerror', { message, stack: stack ?? '' });
  }

  logNetwork(url: string, method: string, status: number, body: string): void {
    this.networkRequests.push({ url, method, status, body });
  }

  logWS(direction: 'sent' | 'received', payload: string): void {
    this.wsFrames.push({ direction, timestamp: Date.now(), payload });
    this.log('ws', { direction, payloadLength: payload.length });
  }

  async dump(outputDir: string, errorMessage?: string): Promise<void> {
    await fs.promises.mkdir(outputDir, { recursive: true });

    const prefix = this.userName.replace(/[^a-zA-Z0-9_-]/g, '_');

    await fs.promises.writeFile(
      path.join(outputDir, `${prefix}-events.json`),
      JSON.stringify(this.events, null, 2)
    );

    await fs.promises.writeFile(
      path.join(outputDir, `${prefix}-ws.json`),
      JSON.stringify(this.wsFrames, null, 2)
    );

    await fs.promises.writeFile(
      path.join(outputDir, `${prefix}-network.json`),
      JSON.stringify(this.networkRequests, null, 2)
    );

    if (errorMessage) {
      await fs.promises.writeFile(path.join(outputDir, `${prefix}-error.txt`), errorMessage);
    }
  }

  getEvents(): LogEntry[] {
    return this.events;
  }

  getWSFrames(): WSFrame[] {
    return this.wsFrames;
  }

  getNetworkRequests(): NetworkRequest[] {
    return this.networkRequests;
  }
}

export function mergeLogs(loggers: UserLogger[]): LogEntry[] {
  const allEvents = loggers.flatMap((l) => l.getEvents());
  allEvents.sort((a, b) => a.timestamp - b.timestamp);
  return allEvents;
}

export function formatMergedLogs(merged: LogEntry[]): string {
  const start = merged.length > 0 ? merged[0].timestamp : Date.now();
  return merged
    .map((e) => {
      const rel = ((e.timestamp - start) / 1000).toFixed(3);
      const friendlyType = e.type.padEnd(14);
      const dataStr = JSON.stringify(e.data);
      return `[+${rel}s] ${e.user.padEnd(12)} ${friendlyType} ${dataStr}`;
    })
    .join('\n');
}

export function formatWSSummary(loggers: UserLogger[]): string {
  const lines: string[] = [];
  for (const logger of loggers) {
    lines.push(`\n--- ${logger.userName} WebSocket frames ---`);
    for (const frame of logger.getWSFrames()) {
      lines.push(`  ${frame.direction === 'sent' ? 'SEND' : 'RECV'}: ${frame.payload}`);
    }
  }
  return lines.join('\n');
}
