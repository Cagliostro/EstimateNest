import { create } from 'zustand';

interface ParticipantState {
  participantId: string | null;
  name: string | null;
  avatarSeed: string | null;
  isModerator: boolean;

  // Actions
  setParticipant: (
    participantId: string,
    name: string,
    avatarSeed: string,
    isModerator?: boolean
  ) => void;
  clearParticipant: () => void;
}

export const useParticipantStore = create<ParticipantState>((set) => ({
  participantId: null,
  name: null,
  avatarSeed: null,
  isModerator: false,

  setParticipant: (participantId, name, avatarSeed, isModerator = false) =>
    set({ participantId, name, avatarSeed, isModerator }),

  clearParticipant: () =>
    set({ participantId: null, name: null, avatarSeed: null, isModerator: false }),
}));
