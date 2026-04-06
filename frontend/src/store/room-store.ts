import { create } from 'zustand';
import { Participant, Round, Vote } from '@estimatenest/shared';

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

  // Actions
  setRoom: (roomId: string, shortCode: string) => void;
  setParticipants: (participants: Participant[]) => void;
  addParticipant: (participant: Participant) => void;
  removeParticipant: (participantId: string) => void;
  setCurrentRound: (round: Round) => void;
  addVote: (vote: Vote) => void;
  setVotes: (votes: Vote[]) => void;
  revealVotes: () => void;
  clearRoom: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  roomId: null,
  shortCode: null,
  participants: [],
  currentRound: null,
  votes: [],
  isRevealed: false,

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

  setCurrentRound: (round) => set({ currentRound: round, votes: [], isRevealed: false }),

  addVote: (vote) =>
    set((state) => ({
      votes: [...state.votes.filter((v) => v.participantId !== vote.participantId), vote],
    })),

  setVotes: (votes) => set({ votes }),

  revealVotes: () => set({ isRevealed: true }),

  clearRoom: () =>
    set({
      roomId: null,
      shortCode: null,
      participants: [],
      currentRound: null,
      votes: [],
      isRevealed: false,
    }),
}));
