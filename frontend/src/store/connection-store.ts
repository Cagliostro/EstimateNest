import { create } from 'zustand';
import { WebSocketClient } from '../lib/websocket-client';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ConnectionStore {
  state: ConnectionState;
  error: string | null;
  wsClient: WebSocketClient | null;

  // Actions
  setConnecting: () => void;
  setConnected: () => void;
  setDisconnected: () => void;
  setError: (error: string) => void;
  clearError: () => void;
  setWsClient: (client: WebSocketClient | null) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  state: 'disconnected',
  error: null,
  wsClient: null,

  setConnecting: () => set({ state: 'connecting', error: null }),

  setConnected: () => set({ state: 'connected', error: null }),

  setDisconnected: () => set({ state: 'disconnected' }),

  setError: (error) => set({ state: 'error', error }),

  clearError: () => set({ error: null }),

  setWsClient: (wsClient) => set({ wsClient }),
}));
