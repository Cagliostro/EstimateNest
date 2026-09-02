// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getIdentity, saveIdentity, clearIdentity } from './room-identity';

describe('room-identity', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns null when nothing is stored for a code', () => {
    expect(getIdentity('ABC123')).toBeNull();
  });

  it('roundtrips an identity and normalizes the room code', () => {
    saveIdentity('abc123', { participantId: 'p-1', name: 'Sebastian' });
    expect(getIdentity('ABC123')).toEqual({ participantId: 'p-1', name: 'Sebastian' });
  });

  it('isolates identities across room codes', () => {
    saveIdentity('AAA111', { participantId: 'p-1', name: 'One' });
    saveIdentity('BBB222', { participantId: 'p-2', name: 'Two' });
    expect(getIdentity('AAA111')?.participantId).toBe('p-1');
    expect(getIdentity('BBB222')?.participantId).toBe('p-2');
  });

  it('returns null for corrupted JSON', () => {
    sessionStorage.setItem('estimatenest.identity.ABC123', '{not-json');
    expect(getIdentity('ABC123')).toBeNull();
  });

  it('returns null for an entry with the wrong shape', () => {
    sessionStorage.setItem('estimatenest.identity.ABC123', JSON.stringify({ participantId: 'p-1' }));
    expect(getIdentity('ABC123')).toBeNull();
  });

  it('removes the entry on clear', () => {
    saveIdentity('ABC123', { participantId: 'p-1', name: 'One' });
    clearIdentity('ABC123');
    expect(getIdentity('ABC123')).toBeNull();
  });
});
