import type { Page } from '@playwright/test';

export function waitForWsMessage(
  page: Page,
  type: string,
  timeout = 15_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket message type "${type}"`));
    }, timeout);

    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const parsed = JSON.parse(String(frame.payload));
          if (parsed.type === type) {
            clearTimeout(timer);
            resolve(parsed.payload ?? {});
          }
        } catch {
          // Non-JSON frame, ignore
        }
      });
    });
  });
}

export function waitForWsMessageMatch(
  page: Page,
  predicate: (payload: Record<string, unknown>) => boolean,
  timeout = 15_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for matching WebSocket message'));
    }, timeout);

    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const parsed = JSON.parse(String(frame.payload));
          const payload = parsed.payload ?? {};
          if (predicate(payload)) {
            clearTimeout(timer);
            resolve(payload as Record<string, unknown>);
          }
        } catch {
          // Non-JSON frame, ignore
        }
      });
    });
  });
}
