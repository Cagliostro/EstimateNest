import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketClient } from './websocket-client';

// Minimal WebSocket stand-in: the client only uses onopen/onclose/onerror/
// onmessage, close() and send(). One instance is constructed per connect().
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.({ code: 1000, reason: 'closed' });
  }
}

function pingsOf(ws: FakeWebSocket): unknown[] {
  return ws.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'ping');
}

describe('WebSocketClient heartbeat (ADR-16)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pings every 5 minutes while the connection stays open', () => {
    const client = new WebSocketClient({ roomId: 'r', participantId: 'p' });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();

    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(pingsOf(ws)).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(pingsOf(ws)).toHaveLength(1);

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(pingsOf(ws)).toHaveLength(2);
  });

  it('stops pinging once the connection is closed', () => {
    const client = new WebSocketClient({ roomId: 'r', participantId: 'p' });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();

    ws.onclose?.({ code: 1000, reason: '' });
    // Reconnect attempts may open fresh sockets but never re-enter onopen in
    // this fake — no socket may receive a ping after the close.
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(FakeWebSocket.instances.every((s) => pingsOf(s).length === 0)).toBe(true);
  });

  it('does not ping after an explicit disconnect', () => {
    const client = new WebSocketClient({ roomId: 'r', participantId: 'p' });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();

    client.disconnect();
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(FakeWebSocket.instances.every((s) => pingsOf(s).length === 0)).toBe(true);
  });
});
