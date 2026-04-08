import { create } from 'zustand';
import { Participant, Round, Vote } from '@estimatenest/shared';
import { RoundHistoryItem } from '../lib/api-client';

interface RoomState {
  // Room metadata
  roomId: string | null;
  shortCode: string | null;

  // Participants
  participants: Participant[];

  // Current round
  currentRound: Round | null;

  // Votes for current round (concealed until reveal)
  votes: Vote[];
  isRevealed: boolean;

  // Round history (revealed rounds)
  roundHistory: RoundHistoryItem[];

  // Actions
  setRoom: (roomId: string, shortCode: string) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (participantId: string) => void;
  setCurrentRound: (round: Round) => void;
  addVote: (vote: Vote) => void;
  setVotes: (votes: Vote[]) => void;
  revealVotes: () => void;
  setRoundHistory: (rounds: RoundHistoryItem[]) => void;
  clearRoom: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  roomId: null,
  shortCode: null,
  participants: [],
  currentRound: null,
  votes: [],
  isRevealed: false,
  roundHistory: [],

  setRoom: (roomId, shortCode) => set({ roomId, shortCode }),

  setParticipants: (participants) => set({ participants }),

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

  setVotes: (votes) => set({ votes }),

  revealVotes: () => set({ isRevealed: true }),

  setRoundHistory: (rounds) => set({ roundHistory: rounds }),

  clearRoom: () =>
    set({
      roomId: null,
      shortCode: null,
      participants: [],
      currentRound: null,
      votes: [],
      isRevealed: false,
      roundHistory: [],
    }),
}));
