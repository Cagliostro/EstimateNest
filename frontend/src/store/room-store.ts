import { create } from 'zustand';
import { Participant, Round, Vote } from '@estimatenest/shared';
import { RoundHistoryItem } from '../lib/api-client';

interface RoomState {
  // Room metadata
  roomId: string | null;
  shortCode: string | null;
  autoRevealEnabled: boolean;

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
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (participantId: string) => void;
  setCurrentRound: (round: Round) => void;
  addVote: (vote: Vote) => void;
  setVotes: (votes: Vote[]) => void;
  revealVotes: () => void;
  startCountdown: (seconds: number) => void;
  stopCountdown: () => void;
  resetCountdown: () => void;
  setRoundHistory: (rounds: RoundHistoryItem[]) => void;
  clearRoom: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  roomId: null,
  shortCode: null,
  autoRevealEnabled: true,
  participants: [],
  currentRound: null,
  votes: [],
  isRevealed: false,
  roundHistory: [],
  countdownSeconds: null,

  setRoom: (roomId, shortCode) => set({ roomId, shortCode }),

  setAutoRevealEnabled: (enabled) => set({ autoRevealEnabled: enabled }),

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

  setCurrentRound: (round) =>
    set((state) => ({
      currentRound: round,
      votes: round?.id === state.currentRound?.id ? state.votes : [],
      isRevealed: round?.isRevealed || false,
    })),

  addVote: (vote) =>
    set((state) => ({
      votes: [...state.votes.filter((v) => v.participantId !== vote.participantId), vote],
    })),

  setVotes: (votes) =>
    set((state) => {
      // Merge votes: keep existing votes unless replaced by new ones with same participantId
      const mergedVotes = [...state.votes];
      votes.forEach((newVote) => {
        const existingIndex = mergedVotes.findIndex(
          (v) => v.participantId === newVote.participantId
        );
        if (existingIndex >= 0) {
          mergedVotes[existingIndex] = newVote;
        } else {
          mergedVotes.push(newVote);
        }
      });
      return { votes: mergedVotes };
    }),

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
      participants: [],
      currentRound: null,
      votes: [],
      isRevealed: false,
      roundHistory: [],
      countdownSeconds: null,
    }),
}));
