/**
 * Per-room client identity, kept in sessionStorage so that a reload of the
 * room page rejoins with the same participantId (no duplicate rows, name and
 * moderator role survive). Tab-scoped: shared devices never leak one user's
 * identity into another's tab.
 */
const STORAGE_PREFIX = 'estimatenest.identity.';

export interface RoomIdentity {
  participantId: string;
  name: string;
}

function keyFor(roomCode: string): string {
  return `${STORAGE_PREFIX}${roomCode.toUpperCase()}`;
}

function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage unavailable (privacy mode, quota) — identity persistence
    // is best-effort; joining still works.
  }
}

export function getIdentity(roomCode: string): RoomIdentity | null {
  const raw = safeGet(keyFor(roomCode));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RoomIdentity>;
    if (typeof parsed.participantId === 'string' && typeof parsed.name === 'string') {
      return { participantId: parsed.participantId, name: parsed.name };
    }
  } catch {
    // corrupted entry — ignore
  }
  return null;
}

export function saveIdentity(roomCode: string, identity: RoomIdentity): void {
  safeSet(keyFor(roomCode), JSON.stringify(identity));
}

export function clearIdentity(roomCode: string): void {
  try {
    sessionStorage.removeItem(keyFor(roomCode));
  } catch {
    // ignore
  }
}
