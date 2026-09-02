import { describe, it, expect, beforeEach } from 'vitest';
import { useRoomStore } from './room-store';
import type { Round } from '@estimatenest/shared';

const makeRound = (id: string, isRevealed: boolean): Round => ({
  id,
  roomId: 'room-1',
  startedAt: '2026-09-02T12:00:00.000Z',
  isRevealed,
  revealedAt: isRevealed ? '2026-09-02T12:01:00.000Z' : undefined,
  scheduledRevealAt: undefined,
});

describe('room-store setCurrentRound', () => {
  beforeEach(() => {
    useRoomStore.getState().clearRoom();
  });

  it('applies vote updates while the round is active', () => {
    const { setCurrentRound } = useRoomStore.getState();
    setCurrentRound(makeRound('round-1', false));

    useRoomStore.setState({
      votes: [
        {
          id: 'v1',
          roundId: 'round-1',
          participantId: 'p1',
          value: 5,
          votedAt: '2026-09-02T12:00:01.000Z',
        },
      ],
    });
    setCurrentRound(makeRound('round-1', false));

    expect(useRoomStore.getState().isRevealed).toBe(false);
    expect(useRoomStore.getState().votes).toHaveLength(1);
  });

  it('drops a stale unrevealed update for an already revealed round', () => {
    const { setCurrentRound } = useRoomStore.getState();
    setCurrentRound(makeRound('round-1', true));

    // Late vote broadcast from a concurrent voter invocation — must not
    // regress the revealed round back into a voting state.
    setCurrentRound(makeRound('round-1', false));

    const state = useRoomStore.getState();
    expect(state.isRevealed).toBe(true);
    expect(state.currentRound?.id).toBe('round-1');
    expect(state.currentRound?.isRevealed).toBe(true);
  });

  it('applies a new round after the previous one was revealed', () => {
    const { setCurrentRound } = useRoomStore.getState();
    setCurrentRound(makeRound('round-1', true));
    setCurrentRound(makeRound('round-2', false));

    const state = useRoomStore.getState();
    expect(state.currentRound?.id).toBe('round-2');
    expect(state.isRevealed).toBe(false);
    expect(state.votes).toHaveLength(0);
  });
});
