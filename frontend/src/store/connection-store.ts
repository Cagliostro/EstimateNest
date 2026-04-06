import { create } from 'zustand';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ConnectionStore {
  state: ConnectionState;
  error: string | null;

  // Actions
  setConnecting: () => void;
  setConnected: () => void;
  setDisconnected: () => void;
  setError: (error: string) => void;
  clearError: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  state: 'disconnected',
  error: null,

  setConnecting: () => set({ state: 'connecting', error: null }),

  setConnected: () => set({ state: 'connected', error: null }),

  setDisconnected: () => set({ state: 'disconnected' }),

  setError: (error) => set({ state: 'error', error }),

  clearError: () => set({ error: null }),
}));
