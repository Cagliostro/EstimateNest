import { Participant } from '@estimatenest/shared';

/**
 * A participant row whose WebSocket connection is gone but whose client is
 * still actively polling via REST stays "present": the polling fallback
 * refreshes every 5-30 s, so a stale REST row is a client that left.
 */
export const REST_PRESENT_GRACE_MS = 90_000;

export function isPresent(participant: Participant, now: number = Date.now()): boolean {
  const connectionId = participant.connectionId;
  if (!connectionId) return false;
  if (connectionId !== 'REST') return true; // live WebSocket connection
  const lastSeen = new Date(participant.lastSeenAt).getTime();
  return now - lastSeen < REST_PRESENT_GRACE_MS;
}

export function filterPresent(
  participants: Participant[],
  now: number = Date.now()
): Participant[] {
  return participants.filter((p) => isPresent(p, now));
}
