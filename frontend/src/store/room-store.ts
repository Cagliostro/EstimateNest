import { create } from 'zustand';
import { Participant, Round, Vote, CardDeck } from '@estimatenest/shared';
import { RoundHistoryItem } from '../lib/api-client';

interface RoomState {
  // Room metadata
  roomId: string | null;
  shortCode: string | null;
  autoRevealEnabled: boolean;
  autoRevealCountdownSeconds: number;
  allowAllParticipantsToReveal: boolean;
  deck: CardDeck | null;
  maxParticipants: number;
  hasPassword: boolean;

  // Participants
  participants: Participant[];

  // Current round
  currentRound: Round | null;

  // Votes for current round (concealed until reveal)
  votes: Vote[];
  isRevealed: boolean;

  // Round history (revealed rounds)
  roundHistory: RoundHistoryItem[];

  // Auto-reveal countdown
  countdownSeconds: number | null;

  // Actions
  setRoom: (roomId: string, shortCode: string) => void;
  setAutoRevealEnabled: (enabled: boolean) => void;
  setRoomSettings: (settings: {
    autoRevealEnabled?: boolean;
    autoRevealCountdownSeconds?: number;
    allowAllParticipantsToReveal?: boolean;
    deck?: CardDeck;
    maxParticipants?: number;
    hasPassword?: boolean;
  }) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (participantId: string) => void;
  setCurrentRound: (round: Round) => boolean;
  addVote: (vote: Vote) => void;
  setVotes: (votes: Vote[]) => void;
  revealVotes: () => void;
  startCountdown: (seconds: number) => void;
  stopCountdown: () => void;
  resetCountdown: () => void;
  setRoundHistory: (rounds: RoundHistoryItem[]) => void;
  clearRoom: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  roomId: null,
  shortCode: null,
  autoRevealEnabled: true,
  autoRevealCountdownSeconds: 3,
  allowAllParticipantsToReveal: false,
  deck: null,
  maxParticipants: 50,
  hasPassword: false,
  participants: [],
  currentRound: null,
  votes: [],
  isRevealed: false,
  roundHistory: [],
  countdownSeconds: null,

  setRoom: (roomId, shortCode) => set({ roomId, shortCode }),

  setAutoRevealEnabled: (enabled) => set({ autoRevealEnabled: enabled }),

  setRoomSettings: (settings) =>
    set((state) => ({
      autoRevealEnabled: settings.autoRevealEnabled ?? state.autoRevealEnabled,
      autoRevealCountdownSeconds:
        settings.autoRevealCountdownSeconds ?? state.autoRevealCountdownSeconds,
      allowAllParticipantsToReveal:
        settings.allowAllParticipantsToReveal ?? state.allowAllParticipantsToReveal,
      deck: settings.deck ?? state.deck,
      maxParticipants: settings.maxParticipants ?? state.maxParticipants,
      hasPassword: settings.hasPassword ?? state.hasPassword,
    })),

  setParticipants: (participants) => {
    console.log(
      '[RoomStore] Setting participants:',
      participants.map((p) => ({ id: p.id, name: p.name }))
    );
    return set({ participants });
  },

  addParticipant: (participant) =>
    set((state) => ({
      participants: [...state.participants.filter((p) => p.id !== participant.id), participant],
    })),

  removeParticipant: (participantId) =>
    set((state) => ({
      participants: state.participants.filter((p) => p.id !== participantId),
    })),

  // Returns true when the update was applied. Dropped updates must also skip
  // the follow-up vote/reveal handling in the caller, or a stale votes
  // snapshot would overwrite the revealed state.
  setCurrentRound: (round) => {
    const state = get();
    const current = state.currentRound;
    const sameRound = current?.id != null && current.id === round?.id;
    const currentRevealed = state.isRevealed || !!current?.isRevealed;

    // A reveal is terminal per round. Vote broadcasts come from concurrent
    // voter Lambda invocations whose gateway delivery order is not
    // guaranteed, so a pre-reveal "N votes, not revealed" update can land
    // AFTER the reveal update. Applying it would regress the UI back to a
    // voting state — drop unrevealed updates for an already-revealed round.
    if (sameRound && round?.isRevealed === false && currentRevealed) {
      console.warn('[RoomStore] Dropping stale roundUpdate for revealed round', {
        roundId: round.id,
      });
      return false;
    }

    // A roundUpdate for an OLDER round (a vote broadcast that raced a
    // newRound) must not regress the store back to the previous round.
    if (
      !sameRound &&
      current &&
      round?.startedAt &&
      new Date(round.startedAt).getTime() < new Date(current.startedAt).getTime()
    ) {
      console.warn('[RoomStore] Dropping stale roundUpdate for older round', {
        roundId: round.id,
        currentRoundId: current.id,
      });
      return false;
    }

    set({
      currentRound: round,
      votes: sameRound ? state.votes : [],
      isRevealed: round?.isRevealed || false,
    });
    return true;
  },

  addVote: (vote) =>
    set((state) => ({
      votes: [...state.votes.filter((v) => v.participantId !== vote.participantId), vote],
    })),

  setVotes: (votes) => set({ votes }),

  revealVotes: () => set({ isRevealed: true }),

  startCountdown: (seconds) => set({ countdownSeconds: seconds }),

  stopCountdown: () => set({ countdownSeconds: null }),

  resetCountdown: () => set({ countdownSeconds: null }),

  setRoundHistory: (rounds) => set({ roundHistory: rounds }),

  clearRoom: () =>
    set({
      roomId: null,
      shortCode: null,
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
      allowAllParticipantsToReveal: false,
      deck: null,
      maxParticipants: 50,
      hasPassword: false,
      participants: [],
      currentRound: null,
      votes: [],
      isRevealed: false,
      roundHistory: [],
      countdownSeconds: null,
    }),
}));
