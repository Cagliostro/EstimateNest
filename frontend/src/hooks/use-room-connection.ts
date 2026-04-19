import { useEffect, useRef, useCallback, useState } from 'react';
import { apiClient } from '../lib/api-client';
import { WebSocketService } from '../lib/websocket-service';
import { WebSocketMessage } from '@estimatenest/shared';
import { useRoomStore } from '../store/room-store';
import { useParticipantStore } from '../store/participant-store';
import { useConnectionStore } from '../store/connection-store';
import { useInterval } from './use-interval';

export interface UseRoomConnectionOptions {
  autoReconnect?: boolean;
}

export function useRoomConnection() {
  const hookIdRef = useRef(Math.random().toString(36).substr(2, 9));
  const hookId = hookIdRef.current;
  const serviceRef = useRef(WebSocketService.getInstance());
  const service = serviceRef.current;

  console.log(`[EstimateNest] [${hookId}] useRoomConnection hook created`);

  // Store states accessed via getState() to avoid dependency changes

  // Polling state
  const [pollingDelay, setPollingDelay] = useState<number | null>(null);
  const pollingRoomCodeRef = useRef<string | null>(null);
  const pollingParticipantIdRef = useRef<string | null>(null);

  // Countdown will be handled by useInterval

  /**
   * Handle incoming WebSocket messages
   */
  const handleWebSocketMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case 'participantList': {
          console.log(`[EstimateNest] [${hookId}] participantList received:`, {
            participants: message.payload.participants,
            count: message.payload.participants.length,
          });
          useRoomStore.getState().setParticipants(message.payload.participants);

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
              useParticipantStore
                .getState()
                .setParticipant(currentParticipantId, name, avatarSeed, isModerator);
            }
          }
          break;
        }

        case 'roundUpdate':
          console.log(`[EstimateNest] [${hookId}] roundUpdate received:`, {
            roundId: message.payload.round.id,
            votesCount: message.payload.votes.length,
            isRevealed: message.payload.round.isRevealed,
            participantIds: message.payload.votes.map((v) => v.participantId),
          });
          useRoomStore.getState().setCurrentRound(message.payload.round);
          useRoomStore.getState().setVotes(message.payload.votes);
          if (message.payload.round.isRevealed) {
            console.log(`[EstimateNest] [${hookId}] Calling revealVotes`);
            useRoomStore.getState().revealVotes();
            useRoomStore.getState().stopCountdown();
          }
          break;

        case 'leave':
          useRoomStore.getState().removeParticipant(message.payload.participantId);
          break;

        case 'participantUpdated':
          console.log(`[EstimateNest] [${hookId}] participantUpdated received:`, message.payload);
          // Optionally show a success message to user
          break;

        case 'autoRevealCountdown':
          console.log(`[EstimateNest] [${hookId}] autoRevealCountdown received:`, message.payload);
          useRoomStore.getState().startCountdown(message.payload.countdownSeconds);
          break;

        case 'error':
          console.error(`[EstimateNest] [${hookId}] WebSocket error:`, message.payload);
          useConnectionStore.getState().setError(message.payload.message);
          break;

        default: {
          // Silently ignore 'ack' and undefined message types
          {
            const msg = message as { type?: string };
            if (msg.type !== 'ack' && msg.type !== undefined) {
              console.log(`[EstimateNest] [${hookId}] Unhandled message type:`, msg.type);
            }
          }
          break;
        }
      }
    },
    [hookId]
  );

  /**
   * Start polling for room state updates
   */
  const startPolling = useCallback((roomCode: string, participantId: string) => {
    pollingRoomCodeRef.current = roomCode;
    pollingParticipantIdRef.current = participantId;
    setPollingDelay(5000);
  }, []);

  /**
   * Stop polling
   */
  const stopPolling = useCallback(() => {
    setPollingDelay(null);
  }, []);

  // Polling callback
  const pollRoomState = useCallback(async () => {
    const roomCode = pollingRoomCodeRef.current;
    const participantId = pollingParticipantIdRef.current;

    if (!roomCode || !participantId) {
      return;
    }

    try {
      const response = await apiClient.joinRoom(roomCode, undefined, participantId);
      // Update store with latest state
      if (response.participants) {
        useRoomStore.getState().setParticipants(response.participants);
      }
      if (response.round) {
        useRoomStore.getState().setCurrentRound(response.round);
      }
      if (response.votes) {
        useRoomStore.getState().setVotes(response.votes);
      }
    } catch (error) {
      console.warn('Polling failed:', error);
      // Don't stop polling on transient errors
    }
  }, []);

  // Polling interval
  useInterval(pollRoomState, pollingDelay);

  /**
   * Create a new room
   */
  const createRoom = useCallback(async (options?: { deck?: string }) => {
    try {
      const response = await apiClient.createRoom({
        deck: options?.deck || 'fibonacci',
      });

      // Room created, but participant still needs to join via joinRoom
      return response;
    } catch (error) {
      useConnectionStore
        .getState()
        .setError(error instanceof Error ? error.message : 'Failed to create room');
      throw error;
    }
  }, []);

  /**
   * Join an existing room
   */
  const joinRoom = useCallback(
    async (roomCode: string, name: string) => {
      try {
        console.log(`[EstimateNest] [${hookId}] Joining room:`, roomCode, 'as', name);
        useConnectionStore.getState().setConnecting();

        // 1. Join via REST API
        const joinResponse = await apiClient.joinRoom(roomCode, name);
        console.log(
          `[EstimateNest] [${hookId}] Joined room:`,
          joinResponse.roomId,
          'participant:',
          joinResponse.participantId
        );

        // 2. Store participant info
        let isModerator = false;
        if (joinResponse.participants) {
          const participant = joinResponse.participants.find(
            (p) => p.id === joinResponse.participantId
          );
          isModerator = participant?.isModerator || false;
        }
        useParticipantStore
          .getState()
          .setParticipant(
            joinResponse.participantId,
            joinResponse.name,
            joinResponse.avatarSeed,
            isModerator
          );

        // 3. Set room info
        useRoomStore.getState().setRoom(joinResponse.roomId, roomCode.toUpperCase());

        // 4. Update room state with initial data from join response
        if (joinResponse.participants) {
          useRoomStore.getState().setParticipants(joinResponse.participants);
        }
        if (joinResponse.round) {
          useRoomStore.getState().setCurrentRound(joinResponse.round);
        }
        if (joinResponse.votes) {
          useRoomStore.getState().setVotes(joinResponse.votes);
        }

        // 5. Connect WebSocket via service
        service.connect(joinResponse.roomId, joinResponse.participantId);

        // 6. Start polling for room state updates (fallback for WebSocket issues)
        startPolling(roomCode, joinResponse.participantId);

        return joinResponse;
      } catch (error) {
        console.error(`[EstimateNest] [${hookId}] Failed to join room:`, error);
        useConnectionStore
          .getState()
          .setError(error instanceof Error ? error.message : 'Failed to join room');
        useConnectionStore.getState().setDisconnected();
        throw error;
      }
    },
    [startPolling, hookId, service]
  );

  /**
   * Disconnect from room
   */
  const disconnect = useCallback(() => {
    console.log(`[EstimateNest] [${hookId}] disconnect called`);
    service.disconnect();
    stopPolling();
    useRoomStore.getState().clearRoom();
    useParticipantStore.getState().clearParticipant();
    useConnectionStore.getState().setDisconnected();
  }, [stopPolling, hookId, service]);

  // Track if a vote is currently being sent to prevent duplicates
  const isSendingVoteRef = useRef(false);

  /**
   * Send a vote
   */
  const sendVote = useCallback(
    (value: number | string) => {
      if (isSendingVoteRef.current) {
        console.log(`[EstimateNest] [${hookId}] Vote already being sent, skipping duplicate`);
        return;
      }

      console.log(`[EstimateNest] [${hookId}] sendVote called, value:`, value);
      if (!service.isConnected()) {
        throw new Error('Not connected');
      }

      isSendingVoteRef.current = true;
      try {
        service.sendVote(value);
      } catch (error) {
        isSendingVoteRef.current = false;
        throw error;
      }

      // Reset after a short delay to allow response but prevent rapid duplicates
      setTimeout(() => {
        isSendingVoteRef.current = false;
      }, 1000);
    },
    [hookId, service]
  );

  /**
   * Reveal votes (moderator only)
   */
  const revealVotes = useCallback(() => {
    console.log(`[EstimateNest] [${hookId}] revealVotes called`);
    if (!service.isConnected()) {
      throw new Error('Not connected');
    }

    // Get current round ID from store
    const { currentRound } = useRoomStore.getState();
    if (!currentRound) {
      throw new Error('No active round');
    }

    service.revealVotes(currentRound.id);
  }, [hookId, service]);

  /**
   * Update participant name
   */
  const updateParticipant = useCallback(
    (name: string) => {
      console.log(`[EstimateNest] [${hookId}] updateParticipant called, name:`, name);
      if (!service.isConnected()) {
        throw new Error('Not connected');
      }
      service.updateParticipant(name);
    },
    [hookId, service]
  );

  /**
   * Create a new round
   */
  const createNewRound = useCallback(
    (title?: string, description?: string) => {
      console.log(`[EstimateNest] [${hookId}] createNewRound called, title:`, title);
      if (!service.isConnected()) {
        throw new Error('Not connected');
      }
      service.createNewRound(title, description);
    },
    [hookId, service]
  );

  /**
   * Update round details
   */
  const updateRound = useCallback(
    (roundId: string, title?: string, description?: string) => {
      console.log(`[EstimateNest] [${hookId}] updateRound called, roundId:`, roundId);
      if (!service.isConnected()) {
        throw new Error('Not connected');
      }
      service.updateRound(roundId, title, description);
    },
    [hookId, service]
  );

  // Track if handlers are already registered to prevent duplicates during re-renders
  const handlersRegisteredRef = useRef(false);

  // Register message handler on mount and unregister on unmount
  useEffect(() => {
    if (handlersRegisteredRef.current) {
      console.log(`[EstimateNest] [${hookId}] Handlers already registered, skipping`);
      return;
    }

    console.log(`[EstimateNest] [${hookId}] Registering message handler`);
    service.addMessageHandler(handleWebSocketMessage);
    handlersRegisteredRef.current = true;

    return () => {
      console.log(`[EstimateNest] [${hookId}] Unregistering message handler`);
      service.removeMessageHandler(handleWebSocketMessage);
      handlersRegisteredRef.current = false;
      // Clear polling interval on unmount
      stopPolling();
    };
  }, [handleWebSocketMessage, hookId, service, stopPolling]);

  // Track if state change callback is already registered
  const stateCallbackRegisteredRef = useRef(false);

  // Sync connection state with store
  useEffect(() => {
    if (stateCallbackRegisteredRef.current) {
      console.log(`[EstimateNest] [${hookId}] State change callback already registered, skipping`);
      return;
    }

    const handleStateChange = (state: string) => {
      console.log(`[EstimateNest] [${hookId}] State change callback:`, state);
      if (state === 'connected') {
        useConnectionStore.getState().setConnected();
      } else if (state === 'disconnected' || state === 'error') {
        useConnectionStore.getState().setDisconnected();
      } else if (state === 'connecting') {
        useConnectionStore.getState().setConnecting();
      }
    };

    console.log(`[EstimateNest] [${hookId}] Registering state change callback`);
    service.addStateChangeCallback(handleStateChange);
    stateCallbackRegisteredRef.current = true;

    // Initialize current state
    const currentState = service.getState();
    handleStateChange(currentState);

    return () => {
      console.log(`[EstimateNest] [${hookId}] Removing state change callback`);
      service.removeStateChangeCallback(handleStateChange);
      stateCallbackRegisteredRef.current = false;
    };
  }, [hookId, service]);

  // Countdown function ref to access latest revealVotes
  const triggerReveal = useCallback(() => {
    const { currentRound } = useRoomStore.getState();
    const { isModerator } = useParticipantStore.getState();

    if (!currentRound) {
      console.error('Auto-reveal failed: No active round');
      return;
    }

    if (!isModerator) {
      console.log(`[EstimateNest] Non-moderator skipping auto-reveal, waiting for moderator`);
      return;
    }

    console.log(`[EstimateNest] Auto-reveal triggered, revealing round:`, currentRound.id);
    service.revealVotes(currentRound.id);
  }, [service]);

  // Get countdownSeconds from store
  const countdownSeconds = useRoomStore((state) => state.countdownSeconds);

  // Countdown handler
  const handleCountdownTick = useCallback(() => {
    const current = useRoomStore.getState().countdownSeconds;
    console.log(`[EstimateNest] Countdown tick, current:`, current);

    if (current === null || current <= 0) {
      // Countdown not active or already completed
      return;
    }

    if (current <= 1) {
      // Countdown complete - reveal votes
      console.log(`[EstimateNest] Countdown complete, triggering reveal`);
      useRoomStore.getState().stopCountdown();
      triggerReveal();
    } else {
      // Decrement countdown
      console.log(`[EstimateNest] Decrementing countdown to`, current - 1);
      useRoomStore.setState({ countdownSeconds: current - 1 });
    }
  }, [triggerReveal]);

  // Countdown interval - runs every second when countdown is active
  useInterval(handleCountdownTick, countdownSeconds !== null && countdownSeconds > 0 ? 1000 : null);

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
