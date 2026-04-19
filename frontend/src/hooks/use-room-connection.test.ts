// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoomConnection } from './use-room-connection';
import { apiClient } from '../lib/api-client';
import { WebSocketService } from '../lib/websocket-service';
import type { Participant, Round, Vote } from '@estimatenest/shared';
import type { RoundHistoryItem } from '../lib/api-client';

// Hoisted mock stores
const mockStores = vi.hoisted(() => {
  // Create state objects with mock functions
  const roomStoreState = {
    roomId: null as string | null,
    shortCode: null as string | null,
    autoRevealEnabled: true,
    participants: [] as Participant[],
    currentRound: null as Round | null,
    votes: [] as Vote[],
    isRevealed: false,
    roundHistory: [] as RoundHistoryItem[],
    countdownSeconds: null as number | null,
    setRoom: vi.fn(),
    setParticipants: vi.fn(),
    setCurrentRound: vi.fn(),
    setVotes: vi.fn(),
    clearRoom: vi.fn(),
    startCountdown: vi.fn(),
    stopCountdown: vi.fn(),
    revealVotes: vi.fn(),
    setAutoRevealEnabled: vi.fn(),
    addParticipant: vi.fn(),
    removeParticipant: vi.fn(),
    addVote: vi.fn(),
    setRoundHistory: vi.fn(),
    resetCountdown: vi.fn(),
  };

  const participantStoreState = {
    participantId: null as string | null,
    name: '',
    avatarSeed: '',
    isModerator: false,
    setParticipant: vi.fn(),
    clearParticipant: vi.fn(),
  };

  const connectionStoreState = {
    state: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
    error: null as string | null,
    setConnecting: vi.fn(),
    setConnected: vi.fn(),
    setDisconnected: vi.fn(),
    setError: vi.fn(),
    clearError: vi.fn(),
  };

  // Create mock store functions with getState property
  const createMockStore = <T>(state: T) => {
    const mockFn = vi.fn((selector?: (s: T) => unknown) => {
      if (typeof selector === 'function') {
        return selector(state);
      }
      return state;
    }) as Mock & { getState: () => T };

    mockFn.getState = vi.fn(() => state);
    return mockFn;
  };

  return {
    roomStore: createMockStore(roomStoreState),
    participantStore: createMockStore(participantStoreState),
    connectionStore: createMockStore(connectionStoreState),
    roomStoreState,
    participantStoreState,
    connectionStoreState,
  };
});

// Mock dependencies
vi.mock('../lib/api-client', () => ({
  apiClient: {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
  },
}));

vi.mock('../lib/websocket-service', () => ({
  WebSocketService: {
    getInstance: vi.fn(),
    resetInstance: vi.fn(),
  },
}));

// Mock store modules using hoisted mocks
vi.mock('../store/room-store', () => ({
  useRoomStore: mockStores.roomStore,
}));

vi.mock('../store/participant-store', () => ({
  useParticipantStore: mockStores.participantStore,
}));

vi.mock('../store/connection-store', () => ({
  useConnectionStore: mockStores.connectionStore,
}));

vi.mock('./use-interval', () => ({
  useInterval: vi.fn(),
}));

const mockApiClient = vi.mocked(apiClient);
const mockWebSocketService = vi.mocked(WebSocketService);

describe('useRoomConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset store state mocks
    mockStores.roomStoreState.setRoom.mockClear();
    mockStores.roomStoreState.setParticipants.mockClear();
    mockStores.roomStoreState.setCurrentRound.mockClear();
    mockStores.roomStoreState.setVotes.mockClear();
    mockStores.roomStoreState.clearRoom.mockClear();
    mockStores.roomStoreState.startCountdown.mockClear();
    mockStores.roomStoreState.stopCountdown.mockClear();
    mockStores.roomStoreState.revealVotes.mockClear();
    mockStores.roomStoreState.setAutoRevealEnabled.mockClear();
    mockStores.roomStoreState.addParticipant.mockClear();
    mockStores.roomStoreState.removeParticipant.mockClear();
    mockStores.roomStoreState.addVote.mockClear();
    mockStores.roomStoreState.setRoundHistory.mockClear();
    mockStores.roomStoreState.resetCountdown.mockClear();

    mockStores.participantStoreState.setParticipant.mockClear();
    mockStores.participantStoreState.clearParticipant.mockClear();

    mockStores.connectionStoreState.setConnecting.mockClear();
    mockStores.connectionStoreState.setConnected.mockClear();
    mockStores.connectionStoreState.setDisconnected.mockClear();
    mockStores.connectionStoreState.setError.mockClear();
    mockStores.connectionStoreState.clearError.mockClear();

    // Setup WebSocket service mock
    mockWebSocketService.getInstance.mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
      sendVote: vi.fn(),
      revealVotes: vi.fn(),
      updateParticipant: vi.fn(),
      createNewRound: vi.fn(),
      updateRound: vi.fn(),
      addMessageHandler: vi.fn(),
      removeMessageHandler: vi.fn(),
      addStateChangeCallback: vi.fn(),
      removeStateChangeCallback: vi.fn(),
      getState: vi.fn(() => 'disconnected'),
      isConnected: vi.fn(),
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    mockApiClient.createRoom.mockResolvedValue({
      roomId: 'test-room-id',
      shortCode: 'TEST',
      participantId: 'test-participant-id',
      name: 'Test User',
      avatarSeed: 'test-seed',
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    mockApiClient.joinRoom.mockResolvedValue({
      roomId: 'test-room-id',
      participantId: 'test-participant-id',
      name: 'Test User',
      avatarSeed: 'test-seed',
      webSocketUrl: 'wss://test.example.com',
      participants: [],
      round: null,
      votes: [],
      shortCode: 'TEST',
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it('should return all expected functions', () => {
    const { result } = renderHook(() => useRoomConnection());

    expect(result.current.createRoom).toBeDefined();
    expect(result.current.joinRoom).toBeDefined();
    expect(result.current.disconnect).toBeDefined();
    expect(result.current.sendVote).toBeDefined();
    expect(result.current.revealVotes).toBeDefined();
    expect(result.current.updateParticipant).toBeDefined();
    expect(result.current.createNewRound).toBeDefined();
    expect(result.current.updateRound).toBeDefined();
  });

  it('should create room successfully', async () => {
    const { result } = renderHook(() => useRoomConnection());

    await act(async () => {
      const response = await result.current.createRoom({ deck: 'fibonacci' });
      expect(response).toEqual({
        roomId: 'test-room-id',
        shortCode: 'TEST',
        participantId: 'test-participant-id',
        name: 'Test User',
        avatarSeed: 'test-seed',
      });
    });

    expect(mockApiClient.createRoom).toHaveBeenCalledWith({
      deck: 'fibonacci',
    });
  });

  it('should join room successfully', async () => {
    const { result } = renderHook(() => useRoomConnection());

    await act(async () => {
      const response = await result.current.joinRoom('TEST', 'Test User');
      expect(response).toEqual({
        roomId: 'test-room-id',
        shortCode: 'TEST',
        participantId: 'test-participant-id',
        name: 'Test User',
        avatarSeed: 'test-seed',
        webSocketUrl: 'wss://test.example.com',
        participants: [],
        round: null,
        votes: [],
      });
    });

    expect(mockApiClient.joinRoom).toHaveBeenCalledWith('TEST', 'Test User');
    expect(mockStores.connectionStoreState.setConnecting).toHaveBeenCalled();
    expect(mockStores.participantStoreState.setParticipant).toHaveBeenCalledWith(
      'test-participant-id',
      'Test User',
      'test-seed',
      false
    );
    expect(mockStores.roomStoreState.setRoom).toHaveBeenCalledWith('test-room-id', 'TEST');
    expect(mockWebSocketService.getInstance().connect).toHaveBeenCalledWith(
      'test-room-id',
      'test-participant-id'
    );
  });

  it('should handle join room error', async () => {
    const error = new Error('Network error');
    mockApiClient.joinRoom.mockRejectedValue(error);

    const { result } = renderHook(() => useRoomConnection());

    await act(async () => {
      await expect(result.current.joinRoom('TEST', 'Test User')).rejects.toThrow('Network error');
    });

    expect(mockStores.connectionStoreState.setError).toHaveBeenCalledWith('Network error');
    expect(mockStores.connectionStoreState.setDisconnected).toHaveBeenCalled();
  });

  it('should disconnect successfully', () => {
    const { result } = renderHook(() => useRoomConnection());

    act(() => {
      result.current.disconnect();
    });

    expect(mockWebSocketService.getInstance().disconnect).toHaveBeenCalled();
    expect(mockStores.roomStoreState.clearRoom).toHaveBeenCalled();
    expect(mockStores.participantStoreState.clearParticipant).toHaveBeenCalled();
    expect(mockStores.connectionStoreState.setDisconnected).toHaveBeenCalled();
  });

  it('should send vote when connected', () => {
    const mockServiceInstance = mockWebSocketService.getInstance();
    (mockServiceInstance as any).isConnected.mockReturnValue(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { result } = renderHook(() => useRoomConnection());

    act(() => {
      result.current.sendVote(5);
    });

    expect(mockServiceInstance.sendVote).toHaveBeenCalledWith(5);
  });

  it('should throw error when sending vote while disconnected', () => {
    const mockServiceInstance = mockWebSocketService.getInstance();
    (mockServiceInstance as any).isConnected.mockReturnValue(false); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { result } = renderHook(() => useRoomConnection());

    expect(() => result.current.sendVote(5)).toThrow('Not connected');
  });

  it('should prevent duplicate votes within 1 second', async () => {
    const mockServiceInstance = mockWebSocketService.getInstance();
    (mockServiceInstance as any).isConnected.mockReturnValue(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { result } = renderHook(() => useRoomConnection());

    act(() => {
      result.current.sendVote(5);
    });

    act(() => {
      result.current.sendVote(8); // Should be ignored
    });

    expect(mockServiceInstance.sendVote).toHaveBeenCalledTimes(1);
    expect(mockServiceInstance.sendVote).toHaveBeenCalledWith(5);

    // Wait for 1 second timeout
    await new Promise((resolve) => setTimeout(resolve, 1100));

    act(() => {
      result.current.sendVote(8);
    });

    expect(mockServiceInstance.sendVote).toHaveBeenCalledTimes(2);
    expect(mockServiceInstance.sendVote).toHaveBeenCalledWith(8);
  });
});
