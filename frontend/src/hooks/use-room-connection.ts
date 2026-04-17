import { useEffect, useRef, useCallback } from 'react';
import { apiClient } from '../lib/api-client';
import { WebSocketService } from '../lib/websocket-service';
import { WebSocketMessage } from '@estimatenest/shared';
import { useRoomStore } from '../store/room-store';
import { useParticipantStore } from '../store/participant-store';
import { useConnectionStore } from '../store/connection-store';

export interface UseRoomConnectionOptions {
  autoReconnect?: boolean;
}

export function useRoomConnection() {
  const hookIdRef = useRef(Math.random().toString(36).substr(2, 9));
  const hookId = hookIdRef.current;
  const serviceRef = useRef(WebSocketService.getInstance());
  const service = serviceRef.current;
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  console.log(`[EstimateNest] [${hookId}] useRoomConnection hook created`);

  // Store states
  const {
    setRoom,
    setParticipants,
    removeParticipant,
    setCurrentRound,
    setVotes,
    revealVotes: revealVotesInStore,
    startCountdown,
    stopCountdown,
    clearRoom,
  } = useRoomStore();
  const { setParticipant, clearParticipant } = useParticipantStore();
  const { setConnecting, setConnected, setDisconnected, setError } = useConnectionStore();

  // Countdown interval ref
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
            stopCountdown();
          }
          break;

        case 'leave':
          removeParticipant(message.payload.participantId);
          break;

        case 'participantUpdated':
          console.log(`[EstimateNest] [${hookId}] participantUpdated received:`, message.payload);
          // Optionally show a success message to user
          break;

        case 'autoRevealCountdown':
          console.log(`[EstimateNest] [${hookId}] autoRevealCountdown received:`, message.payload);
          startCountdown(message.payload.countdownSeconds);
          break;

        case 'error':
          console.error(`[EstimateNest] [${hookId}] WebSocket error:`, message.payload);
          setError(message.payload.message);
          break;

        default: {
          // Silently ignore 'ack' and undefined message types
          const msgType = message.type as string;
          if (msgType !== 'ack' && msgType !== undefined) {
            console.log(`[EstimateNest] [${hookId}] Unhandled message type:`, message.type);
          }
          break;
        }
      }
    },
    [
      setParticipants,
      setCurrentRound,
      setVotes,
      removeParticipant,
      revealVotesInStore,
      setParticipant,
      setError,
      startCountdown,
      stopCountdown,
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

        // 2. Store participant info
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

        // 3. Set room info
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

        // 5. Connect WebSocket via service
        service.connect(joinResponse.roomId, joinResponse.participantId);

        // 6. Start polling for room state updates (fallback for WebSocket issues)
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
      setDisconnected,
      setError,
      setParticipant,
      setRoom,
      setParticipants,
      setCurrentRound,
      setVotes,
      startPolling,
      hookId,
      service,
    ]
  );

  /**
   * Disconnect from room
   */
  const disconnect = useCallback(() => {
    console.log(`[EstimateNest] [${hookId}] disconnect called`);
    service.disconnect();
    stopPolling();
    clearRoom();
    clearParticipant();
    setDisconnected();
  }, [clearRoom, clearParticipant, setDisconnected, stopPolling, hookId, service]);

  /**
   * Send a vote
   */
  const sendVote = useCallback(
    (value: number | string) => {
      console.log(`[EstimateNest] [${hookId}] sendVote called, value:`, value);
      if (!service.isConnected()) {
        throw new Error('Not connected');
      }
      service.sendVote(value);
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

  // Register message handler on mount and unregister on unmount
  useEffect(() => {
    console.log(`[EstimateNest] [${hookId}] Registering message handler`);
    service.addMessageHandler(handleWebSocketMessage);

    return () => {
      console.log(`[EstimateNest] [${hookId}] Unregistering message handler`);
      service.removeMessageHandler(handleWebSocketMessage);
      // Clear countdown interval on unmount
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      // Clear polling interval on unmount
      stopPolling();
    };
  }, [handleWebSocketMessage, hookId, service, stopPolling]);

  // Sync connection state with store
  useEffect(() => {
    const handleStateChange = (state: string) => {
      console.log(`[EstimateNest] [${hookId}] State change callback:`, state);
      if (state === 'connected') {
        setConnected();
      } else if (state === 'disconnected' || state === 'error') {
        setDisconnected();
      } else if (state === 'connecting') {
        setConnecting();
      }
    };

    console.log(`[EstimateNest] [${hookId}] Registering state change callback`);
    service.addStateChangeCallback(handleStateChange);

    // Initialize current state
    const currentState = service.getState();
    handleStateChange(currentState);

    return () => {
      console.log(`[EstimateNest] [${hookId}] Removing state change callback`);
      service.removeStateChangeCallback(handleStateChange);
    };
  }, [setConnecting, setConnected, setDisconnected, hookId, service]);

  // Countdown function ref to access latest revealVotes
  const triggerReveal = useCallback(() => {
    const { currentRound } = useRoomStore.getState();
    if (!currentRound) {
      console.error('Auto-reveal failed: No active round');
      return;
    }
    console.log(`[EstimateNest] Auto-reveal triggered, revealing round:`, currentRound.id);
    service.revealVotes(currentRound.id);
  }, [service]);

  // Get countdownSeconds from store
  const countdownSeconds = useRoomStore((state) => state.countdownSeconds);
  const prevCountdownRef = useRef<number | null>(null);

  // Handle countdown logic - runs when countdownSeconds changes
  useEffect(() => {
    console.log(
      `[EstimateNest] Countdown effect triggered:`,
      countdownSeconds,
      `previous:`,
      prevCountdownRef.current
    );

    // If countdown is being cleared (e.g., after reveal)
    if (countdownSeconds === null || countdownSeconds <= 0) {
      if (countdownIntervalRef.current) {
        console.log(`[EstimateNest] Clearing countdown interval (countdown cleared)`);
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      prevCountdownRef.current = countdownSeconds;
      return;
    }

    // Determine if this is a decrement from the interval's own tick
    const isDecrementing =
      prevCountdownRef.current !== null &&
      prevCountdownRef.current > 0 &&
      countdownSeconds < prevCountdownRef.current;

    // If we're already in a countdown and the value is just decrementing (N → N-1), don't restart
    if (isDecrementing) {
      console.log(
        `[EstimateNest] Countdown decrementing from ${prevCountdownRef.current} to ${countdownSeconds}, not restarting`
      );
      prevCountdownRef.current = countdownSeconds;
      return;
    }

    // Otherwise, we need to start a new countdown (either initial start or a reset)
    // Clear existing interval if any
    if (countdownIntervalRef.current) {
      console.log(`[EstimateNest] Clearing existing countdown interval for new countdown`);
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    console.log(`[EstimateNest] Starting countdown from`, countdownSeconds);
    prevCountdownRef.current = countdownSeconds;

    // Start countdown interval
    countdownIntervalRef.current = setInterval(() => {
      const { countdownSeconds: current } = useRoomStore.getState();
      console.log(`[EstimateNest] Countdown tick, current:`, current);

      if (current === null || current <= 1) {
        // Countdown complete - reveal votes
        console.log(`[EstimateNest] Countdown complete, triggering reveal`);
        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }
        prevCountdownRef.current = null;
        stopCountdown();
        triggerReveal();
      } else {
        // Decrement countdown
        console.log(`[EstimateNest] Decrementing countdown to`, current - 1);
        useRoomStore.setState({ countdownSeconds: current - 1 });
      }
    }, 1000);

    return () => {
      // Only clear interval on unmount if we haven't already cleared it
      if (countdownIntervalRef.current) {
        console.log(`[EstimateNest] Cleanup: clearing countdown interval on unmount`);
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
        // DO NOT reset prevCountdownRef here - it's used to detect decrementing between effect runs
      }
    };
  }, [countdownSeconds, stopCountdown, triggerReveal]);

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
