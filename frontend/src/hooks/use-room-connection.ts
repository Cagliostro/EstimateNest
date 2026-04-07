import { useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../lib/api-client';
import { WebSocketClient } from '../lib/websocket-client';
import { WebSocketMessage } from '@estimatenest/shared';
import { useRoomStore } from '../store/room-store';
import { useParticipantStore } from '../store/participant-store';
import { useConnectionStore } from '../store/connection-store';

export interface UseRoomConnectionOptions {
  autoReconnect?: boolean;
}

export function useRoomConnection() {
  const wsClientRef = useRef<WebSocketClient | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Store states
  const {
    setRoom,
    setParticipants,
    removeParticipant,
    setCurrentRound,
    setVotes,
    revealVotes: revealVotesInStore,
    clearRoom,
  } = useRoomStore();
  const { setParticipant, clearParticipant } = useParticipantStore();
  const { setConnecting, setConnected, setDisconnected, setError } = useConnectionStore();

  /**
   * Create a new room
   */
  const createRoom = useCallback(
    async (options?: { deck?: string }) => {
      try {
        const response = await apiClient.createRoom({
          deck: options?.deck || 'fibonacci',
        });

        // Room created, but participant still needs to join via joinRoom
        return response;
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Failed to create room');
        throw error;
      }
    },
    [setError]
  );

  /**
   * Reveal votes (moderator only)
   */
  const revealVotes = useCallback(() => {
    if (!wsClientRef.current) {
      throw new Error('Not connected');
    }

    // Get current round ID from store
    const { currentRound } = useRoomStore.getState();
    if (!currentRound) {
      throw new Error('No active round');
    }

    wsClientRef.current.send({
      type: 'reveal',
      payload: { roundId: currentRound.id },
    });
  }, []);

  /**
   * Handle incoming WebSocket messages
   */
  const handleWebSocketMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case 'participantList':
          setParticipants(message.payload.participants);
          break;

        case 'roundUpdate':
          setCurrentRound(message.payload.round);
          setVotes(message.payload.votes);
          if (message.payload.round.isRevealed) {
            revealVotesInStore();
          }
          break;

        case 'leave':
          removeParticipant(message.payload.participantId);
          break;

        // Note: 'join' messages are handled via participantList updates
        // 'error' messages could be displayed to user
      }
    },
    [setParticipants, setCurrentRound, setVotes, removeParticipant, revealVotesInStore]
  );

  /**
   * Start polling for room state updates
   */
  const startPolling = useCallback(
    (roomCode: string, participantId: string) => {
      // Clear any existing interval
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }

      // Poll every 5 seconds
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const response = await apiClient.joinRoom(roomCode, undefined, participantId);
          // Update store with latest state
          if (response.participants) {
            setParticipants(response.participants);
          }
          if (response.round) {
            setCurrentRound(response.round);
          }
          if (response.votes) {
            setVotes(response.votes);
          }
        } catch (error) {
          console.warn('Polling failed:', error);
          // Don't stop polling on transient errors
        }
      }, 5000);
    },
    [setParticipants, setCurrentRound, setVotes]
  );

  /**
   * Stop polling
   */
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  /**
   * Join an existing room
   */
  const joinRoom = useCallback(
    async (roomCode: string, name: string) => {
      try {
        console.log('[EstimateNest] Joining room:', roomCode, 'as', name);
        setConnecting();

        // 1. Join via REST API
        const joinResponse = await apiClient.joinRoom(roomCode, name);
        console.log(
          '[EstimateNest] Joined room:',
          joinResponse.roomId,
          'participant:',
          joinResponse.participantId
        );
        console.log('[EstimateNest] WebSocket URL:', joinResponse.webSocketUrl);

        // 2. Store participant info
        setParticipant(
          joinResponse.participantId,
          joinResponse.name,
          joinResponse.avatarSeed,
          false
        );

        // 3. Extract room ID from response (we don't have short code yet)
        // The roomId is in response, but short code is the input roomCode
        setRoom(joinResponse.roomId, roomCode.toUpperCase());

        // 4. Connect WebSocket
        const wsClient = new WebSocketClient({
          roomId: joinResponse.roomId,
          participantId: joinResponse.participantId,
          onMessage: handleWebSocketMessage,
          onStateChange: (state) => {
            console.log('[EstimateNest] WebSocket state change:', state);
            if (state === 'connected') {
              setConnected();
            } else if (state === 'disconnected' || state === 'error') {
              setDisconnected();
            }
          },
        });

        wsClientRef.current = wsClient;
        wsClient.connect();

        // Start polling for room state updates (fallback for WebSocket issues)
        startPolling(roomCode, joinResponse.participantId);

        return joinResponse;
      } catch (error) {
        console.error('[EstimateNest] Failed to join room:', error);
        setError(error instanceof Error ? error.message : 'Failed to join room');
        setDisconnected();
        throw error;
      }
    },
    [
      setConnecting,
      setConnected,
      setDisconnected,
      setError,
      setParticipant,
      setRoom,
      handleWebSocketMessage,
      startPolling,
    ]
  );

  /**
   * Disconnect from room
   */
  const disconnect = useCallback(() => {
    if (wsClientRef.current) {
      wsClientRef.current.disconnect();
      wsClientRef.current = null;
    }
    stopPolling();
    clearRoom();
    clearParticipant();
    setDisconnected();
  }, [clearRoom, clearParticipant, setDisconnected, stopPolling]);

  /**
   * Send a vote
   */
  const sendVote = useCallback((value: number | string) => {
    if (!wsClientRef.current) {
      throw new Error('Not connected');
    }

    // In Phase 1, we don't specify roundId - backend will use active round
    wsClientRef.current.send({
      type: 'vote',
      payload: { roundId: '', value },
    });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsClientRef.current) {
        wsClientRef.current.disconnect();
      }
    };
  }, []);

  return {
    createRoom,
    joinRoom,
    disconnect,
    sendVote,
    revealVotes,
  };
}
