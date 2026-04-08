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
  const hookIdRef = useRef(Math.random().toString(36).substr(2, 9));
  const hookId = hookIdRef.current;

  const storeWsClient = useConnectionStore.getState().wsClient;
  console.log(
    `[EstimateNest] useRoomConnection hook created, id: ${hookId}, wsClientRef.current:`,
    wsClientRef.current,
    'store wsClient:',
    storeWsClient
  );

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
  const { setConnecting, setConnected, setDisconnected, setError, setWsClient } =
    useConnectionStore();

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
    const wsClient = useConnectionStore.getState().wsClient;
    console.log(`[EstimateNest] [${hookId}] revealVotes called, wsClient from store:`, wsClient);
    if (!wsClient) {
      console.error(`[EstimateNest] [${hookId}] wsClient is null, throwing Not connected`);
      throw new Error('Not connected');
    }

    // Get current round ID from store
    const { currentRound } = useRoomStore.getState();
    console.log(`[EstimateNest] [${hookId}] currentRound:`, currentRound);
    if (!currentRound) {
      throw new Error('No active round');
    }

    console.log(`[EstimateNest] [${hookId}] Calling wsClient.send for reveal`);
    wsClient.send({
      type: 'reveal',
      payload: { roundId: currentRound.id },
    });
  }, [hookId]);

  /**
   * Update participant name
   */
  const updateParticipant = useCallback(
    (name: string) => {
      const wsClient = useConnectionStore.getState().wsClient;
      console.log(
        `[EstimateNest] [${hookId}] updateParticipant called, wsClient from store:`,
        wsClient
      );
      if (!wsClient) {
        console.error(`[EstimateNest] [${hookId}] wsClient is null, throwing Not connected`);
        throw new Error('Not connected');
      }

      console.log(`[EstimateNest] [${hookId}] Calling wsClient.send for updateParticipant`);
      wsClient.send({
        type: 'updateParticipant',
        payload: { name },
      });
    },
    [hookId]
  );

  /**
   * Create a new round
   */
  const createNewRound = useCallback(
    (title?: string, description?: string) => {
      const wsClient = useConnectionStore.getState().wsClient;
      console.log(
        `[EstimateNest] [${hookId}] createNewRound called, wsClient from store:`,
        wsClient
      );
      if (!wsClient) {
        console.error(`[EstimateNest] [${hookId}] wsClient is null, throwing Not connected`);
        throw new Error('Not connected');
      }

      console.log(`[EstimateNest] [${hookId}] Calling wsClient.send for newRound`);
      wsClient.send({
        type: 'newRound',
        payload: { title, description },
      });
    },
    [hookId]
  );

  /**
   * Update round details
   */
  const updateRound = useCallback(
    (roundId: string, title?: string, description?: string) => {
      const wsClient = useConnectionStore.getState().wsClient;
      console.log(`[EstimateNest] [${hookId}] updateRound called, wsClient from store:`, wsClient);
      if (!wsClient) {
        console.error(`[EstimateNest] [${hookId}] wsClient is null, throwing Not connected`);
        throw new Error('Not connected');
      }

      console.log(`[EstimateNest] [${hookId}] Calling wsClient.send for updateRound`);
      wsClient.send({
        type: 'updateRound',
        payload: { roundId, title, description },
      });
    },
    [hookId]
  );

  /**
   * Handle incoming WebSocket messages
   */
  const handleWebSocketMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case 'participantList': {
          setParticipants(message.payload.participants);
          // Update participant store if current participant is in the list
          const { participantId: currentParticipantId } = useParticipantStore.getState();
          if (currentParticipantId) {
            const updatedParticipant = message.payload.participants.find(
              (p) => p.id === currentParticipantId
            );
            if (updatedParticipant) {
              const { name, avatarSeed, isModerator } = updatedParticipant;
              console.log(
                `[EstimateNest] [${hookId}] Updating participant store with new name:`,
                name
              );
              setParticipant(currentParticipantId, name, avatarSeed, isModerator);
            }
          }
          break;
        }

        case 'roundUpdate':
          console.log(`[EstimateNest] [${hookId}] roundUpdate received:`, {
            round: message.payload.round,
            votesCount: message.payload.votes.length,
            isRevealed: message.payload.round.isRevealed,
          });
          setCurrentRound(message.payload.round);
          setVotes(message.payload.votes);
          if (message.payload.round.isRevealed) {
            console.log(`[EstimateNest] [${hookId}] Calling revealVotesInStore`);
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
    [
      setParticipants,
      setCurrentRound,
      setVotes,
      removeParticipant,
      revealVotesInStore,
      setParticipant,
      hookId,
    ]
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
        console.log(`[EstimateNest] [${hookId}] Joining room:`, roomCode, 'as', name);
        setConnecting();

        // 1. Join via REST API
        const joinResponse = await apiClient.joinRoom(roomCode, name);
        console.log(
          `[EstimateNest] [${hookId}] Joined room:`,
          joinResponse.roomId,
          'participant:',
          joinResponse.participantId
        );
        console.log(`[EstimateNest] [${hookId}] WebSocket URL:`, joinResponse.webSocketUrl);
        console.log(`[EstimateNest] [${hookId}] Join response:`, joinResponse);

        // 2. Store participant info
        // Determine if participant is moderator by checking the participants array
        let isModerator = false;
        if (joinResponse.participants) {
          const participant = joinResponse.participants.find(
            (p) => p.id === joinResponse.participantId
          );
          isModerator = participant?.isModerator || false;
        }
        setParticipant(
          joinResponse.participantId,
          joinResponse.name,
          joinResponse.avatarSeed,
          isModerator
        );

        // 3. Extract room ID from response (we don't have short code yet)
        // The roomId is in response, but short code is the input roomCode
        setRoom(joinResponse.roomId, roomCode.toUpperCase());

        // 4. Update room state with initial data from join response
        if (joinResponse.participants) {
          setParticipants(joinResponse.participants);
        }
        if (joinResponse.round) {
          setCurrentRound(joinResponse.round);
        }
        if (joinResponse.votes) {
          setVotes(joinResponse.votes);
        }

        // 5. Connect WebSocket
        const wsClient = new WebSocketClient({
          roomId: joinResponse.roomId,
          participantId: joinResponse.participantId,
          hookId,
          onMessage: handleWebSocketMessage,
          onStateChange: (state) => {
            console.log(`[EstimateNest] [${hookId}] WebSocket state change:`, state);
            if (state === 'connected') {
              setConnected();
            } else if (state === 'disconnected' || state === 'error') {
              setDisconnected();
            }
          },
        });

        wsClientRef.current = wsClient;
        setWsClient(wsClient);
        console.log(
          `[EstimateNest] [${hookId}] WebSocket client created, ref set:`,
          !!wsClientRef.current,
          'wsClient:',
          wsClient
        );
        wsClient.connect();

        // Start polling for room state updates (fallback for WebSocket issues)
        startPolling(roomCode, joinResponse.participantId);

        return joinResponse;
      } catch (error) {
        console.error(`[EstimateNest] [${hookId}] Failed to join room:`, error);
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
      setWsClient,
      setParticipant,
      setRoom,
      setParticipants,
      setCurrentRound,
      setVotes,
      handleWebSocketMessage,
      startPolling,
      hookId,
    ]
  );

  /**
   * Disconnect from room
   */
  const disconnect = useCallback(() => {
    const wsClient = useConnectionStore.getState().wsClient;
    console.log(`[EstimateNest] [${hookId}] disconnect called, wsClient from store:`, wsClient);
    console.trace(`[EstimateNest] [${hookId}] Disconnect stack trace`);
    if (wsClient) {
      console.log(`[EstimateNest] [${hookId}] Disconnecting WebSocket`);
      wsClient.disconnect();
    } else {
      console.log(`[EstimateNest] [${hookId}] wsClient already null`);
    }
    wsClientRef.current = null;
    setWsClient(null);
    stopPolling();
    clearRoom();
    clearParticipant();
    setDisconnected();
  }, [clearRoom, clearParticipant, setDisconnected, setWsClient, stopPolling, hookId]);

  /**
   * Send a vote
   */
  const sendVote = useCallback(
    (value: number | string) => {
      const wsClient = useConnectionStore.getState().wsClient;
      console.log(
        `[EstimateNest] [${hookId}] sendVote called, wsClient from store:`,
        wsClient,
        'value:',
        value,
        'hookId:',
        hookId
      );
      if (!wsClient) {
        console.error(`[EstimateNest] [${hookId}] wsClient is null, throwing Not connected.`);
        throw new Error('Not connected');
      }

      // In Phase 1, we don't specify roundId - backend will use active round
      console.log(`[EstimateNest] [${hookId}] Calling wsClient.send`);
      wsClient.send({
        type: 'vote',
        payload: { roundId: '', value },
      });
    },
    [hookId]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log(
        `[EstimateNest] [${hookId}] Cleanup effect running, wsClientRef.current:`,
        wsClientRef.current
      );
      console.trace(`[EstimateNest] [${hookId}] Cleanup stack trace`);
      // Note: We don't disconnect or clear wsClient here because
      // component might be re-rendering. Disconnect only happens
      // via explicit disconnect() call when leaving room.
    };
  }, [hookId]);

  // Sync ref with store wsClient on mount
  useEffect(() => {
    const storeWsClient = useConnectionStore.getState().wsClient;
    if (storeWsClient && !wsClientRef.current) {
      console.log(`[EstimateNest] [${hookId}] Syncing ref with store wsClient`);
      wsClientRef.current = storeWsClient;
    }
  }, [hookId]);

  return {
    createRoom,
    joinRoom,
    disconnect,
    sendVote,
    revealVotes,
    updateParticipant,
    createNewRound,
    updateRound,
  };
}
