import { WebSocketMessage } from '@estimatenest/shared';
import { WebSocketClient } from './websocket-client';

type MessageHandler = (message: WebSocketMessage) => void;
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WebSocketServiceOptions {
  onStateChange?: (state: ConnectionState) => void;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export class WebSocketService {
  private static instance: WebSocketService | null = null;
  private client: WebSocketClient | null = null;
  private messageHandlers: Set<MessageHandler> = new Set();
  private state: ConnectionState = 'disconnected';
  private stateChangeCallbacks: Set<(state: ConnectionState) => void> = new Set();
  private currentRoomId: string | null = null;
  private currentParticipantId: string | null = null;

  private constructor() {}

  static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  static resetInstance(): void {
    if (WebSocketService.instance) {
      WebSocketService.instance.disconnect();
      WebSocketService.instance = null;
    }
  }

  private log(message: string, ...args: unknown[]) {
    console.log('[WebSocketService]', message, ...args);
  }

  private error(message: string, ...args: unknown[]) {
    console.error('[WebSocketService]', message, ...args);
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.log('State change:', this.state, '->', newState);
      this.state = newState;
      this.stateChangeCallbacks.forEach((callback) => callback(newState));
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }

  getCurrentParticipantId(): string | null {
    return this.currentParticipantId;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  connect(roomId: string, participantId: string, options?: WebSocketServiceOptions): void {
    this.log('connect called', { roomId, participantId, existingClient: !!this.client });

    // If already connected to same room/participant, do nothing
    if (
      this.client &&
      this.currentRoomId === roomId &&
      this.currentParticipantId === participantId &&
      this.state === 'connected'
    ) {
      this.log('Already connected to same room/participant');
      return;
    }

    // Disconnect existing connection if any
    this.disconnect();

    this.currentRoomId = roomId;
    this.currentParticipantId = participantId;

    this.setState('connecting');

    this.client = new WebSocketClient({
      roomId,
      participantId,
      hookId: 'websocket-service',
      onMessage: (message) => this.handleMessage(message),
      onStateChange: (state) => {
        this.log('Client state change:', state);
        this.setState(state);
      },
      reconnectAttempts: options?.reconnectAttempts,
      reconnectDelay: options?.reconnectDelay,
    });

    this.client.connect();
  }

  disconnect(): void {
    this.log('disconnect called, client exists:', !!this.client);
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.currentRoomId = null;
    this.currentParticipantId = null;
    this.setState('disconnected');
  }

  send(message: WebSocketMessage): void {
    if (!this.client || this.state !== 'connected') {
      throw new Error('WebSocket is not connected');
    }
    this.client.send(message);
  }

  addMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
    this.log('Message handler added, total:', this.messageHandlers.size);
  }

  removeMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
    this.log('Message handler removed, total:', this.messageHandlers.size);
  }

  addStateChangeCallback(callback: (state: ConnectionState) => void): void {
    this.stateChangeCallbacks.add(callback);
  }

  removeStateChangeCallback(callback: (state: ConnectionState) => void): void {
    this.stateChangeCallbacks.delete(callback);
  }

  private handleMessage(message: WebSocketMessage): void {
    this.log('Handling message:', message.type);
    this.messageHandlers.forEach((handler) => {
      try {
        handler(message);
      } catch (error) {
        this.error('Error in message handler:', error);
      }
    });
  }

  // Convenience methods for common operations
  updateParticipant(name: string): void {
    this.send({
      type: 'updateParticipant',
      payload: { name },
    });
  }

  createNewRound(title?: string, description?: string): void {
    this.send({
      type: 'newRound',
      payload: { title, description },
    });
  }

  updateRound(roundId: string, title?: string, description?: string): void {
    this.send({
      type: 'updateRound',
      payload: { roundId, title, description },
    });
  }

  sendVote(value: number | string, roundId?: string): void {
    this.send({
      type: 'vote',
      payload: { roundId: roundId || '', value },
    });
  }

  revealVotes(roundId: string): void {
    this.send({
      type: 'reveal',
      payload: { roundId },
    });
  }

  join(): void {
    this.send({
      type: 'join',
      payload: {},
    });
  }
}
