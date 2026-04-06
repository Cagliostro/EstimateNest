import { WebSocketMessage } from '@estimatenest/shared';
import { config } from './config';

type MessageHandler = (message: WebSocketMessage) => void;
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionOptions {
  roomId: string;
  participantId: string;
  onMessage?: MessageHandler;
  onStateChange?: (state: ConnectionState) => void;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = {
      reconnectAttempts: 5,
      reconnectDelay: 1000,
      ...options,
    };
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') {
      return;
    }

    this.setState('connecting');
    this.reconnectCount = 0;

    const { roomId, participantId } = this.options;
    const wsUrl = new URL(config.websocketUrl);
    wsUrl.searchParams.set('roomId', roomId);
    wsUrl.searchParams.set('participantId', participantId);

    this.ws = new WebSocket(wsUrl.toString());

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.setState('connected');
      this.reconnectCount = 0;
      // Send join message to trigger participant list broadcast
      try {
        this.send({ type: 'join', payload: {} });
      } catch (error) {
        console.warn('Failed to send join message:', error);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage;
        this.options.onMessage?.(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error, event.data);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.setState('error');
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      this.setState('disconnected');
      this.attemptReconnect();
    };
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.setState('disconnected');
  }

  /**
   * Send a WebSocket message
   * Note: API Gateway WebSocket API uses the 'action' field to route messages
   */
  send(message: WebSocketMessage): void {
    if (this.state !== 'connected' || !this.ws) {
      throw new Error('WebSocket is not connected');
    }

    // Wrap message with action field for API Gateway routing
    const wrappedMessage = {
      action: message.type,
      ...message,
    };

    this.ws.send(JSON.stringify(wrappedMessage));
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.options.onStateChange?.(newState);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectCount >= this.options.reconnectAttempts!) {
      console.log('Max reconnect attempts reached');
      return;
    }

    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectCount++;
        console.log(`Reconnecting (attempt ${this.reconnectCount})...`);
        this.connect();
      },
      this.options.reconnectDelay! * Math.pow(1.5, this.reconnectCount - 1)
    );
  }
}
