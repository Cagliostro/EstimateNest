import { describe, it, expect } from 'vitest';
import { isPresent, filterPresent, REST_PRESENT_GRACE_MS } from '../../src/utils/participants.js';
import type { Participant } from '@estimatenest/shared';

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  const now = new Date().toISOString();
  return {
    id: 'participant-1',
    roomId: 'room-1',
    connectionId: 'conn-1',
    name: 'Test',
    avatarSeed: 'test',
    joinedAt: now,
    lastSeenAt: now,
    isModerator: false,
    ...overrides,
  };
}

describe('isPresent', () => {
  it('treats a live WebSocket mapping as present', () => {
    expect(isPresent(makeParticipant({ connectionId: 'conn-abc' }))).toBe(true);
  });

  it('treats a fresh REST poller as present', () => {
    const fresh = new Date(Date.now() - 30_000).toISOString();
    expect(
      isPresent(makeParticipant({ connectionId: 'REST', lastSeenAt: fresh }))
    ).toBe(true);
  });

  it('treats a REST poller at the edge of the grace window as present', () => {
    const edge = new Date(Date.now() - REST_PRESENT_GRACE_MS + 5_000).toISOString();
    expect(isPresent(makeParticipant({ connectionId: 'REST', lastSeenAt: edge }))).toBe(true);
  });

  it('treats a REST row without recent polls as absent', () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(isPresent(makeParticipant({ connectionId: 'REST', lastSeenAt: stale }))).toBe(false);
  });

  it('treats a row without connectionId as absent', () => {
    expect(isPresent(makeParticipant({ connectionId: '' }))).toBe(false);
  });

  it('treats a REST row without lastSeenAt as absent', () => {
    const participant = makeParticipant({ connectionId: 'REST' });
    delete (participant as Partial<Participant>).lastSeenAt;
    expect(isPresent(participant)).toBe(false);
  });
});

describe('filterPresent', () => {
  it('keeps only present participants', () => {
    const staleREST = new Date(Date.now() - 5 * 60_000).toISOString();
    const freshREST = new Date(Date.now() - 10_000).toISOString();
    const list = [
      makeParticipant({ id: 'live', connectionId: 'conn-1' }),
      makeParticipant({ id: 'fresh-poller', connectionId: 'REST', lastSeenAt: freshREST }),
      makeParticipant({ id: 'ghost', connectionId: 'REST', lastSeenAt: staleREST }),
      makeParticipant({ id: 'no-mapping', connectionId: '' }),
    ];
    const present = filterPresent(list);
    expect(present.map((p) => p.id)).toEqual(['live', 'fresh-poller']);
  });

  it('returns an empty list when nobody is present', () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(filterPresent([makeParticipant({ connectionId: 'REST', lastSeenAt: stale })])).toEqual(
      []
    );
  });
});
