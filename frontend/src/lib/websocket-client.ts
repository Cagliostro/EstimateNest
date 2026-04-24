import { WebSocketMessage } from '@estimatenest/shared';
import { config } from './config';

type MessageHandler = (message: WebSocketMessage) => void;
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionOptions {
  roomId: string;
  participantId: string;
  hookId?: string;
  onMessage?: MessageHandler;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (errorType: string, message: string, details?: Record<string, unknown>) => void;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCount = 0;
  private shouldReconnect = true;
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = {
      reconnectAttempts: 5,
      reconnectDelay: 1000,
      ...options,
    };
  }

  private log(message: string, ...args: unknown[]) {
    const prefix = this.options.hookId
      ? `[EstimateNest] [${this.options.hookId}]`
      : '[EstimateNest]';
    console.log(prefix, message, ...args);
  }

  private error(message: string, ...args: unknown[]) {
    const prefix = this.options.hookId
      ? `[EstimateNest] [${this.options.hookId}]`
      : '[EstimateNest]';
    console.error(prefix, message, ...args);
  }

  private warn(message: string, ...args: unknown[]) {
    const prefix = this.options.hookId
      ? `[EstimateNest] [${this.options.hookId}]`
      : '[EstimateNest]';
    console.warn(prefix, message, ...args);
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') {
      this.log('WebSocket already connecting or connected, state:', this.state);
      return;
    }

    this.setState('connecting');
    this.shouldReconnect = true;
    this.reconnectCount = 0;

    const { roomId, participantId } = this.options;
    const wsUrl = new URL(config.websocketUrl);
    wsUrl.searchParams.set('roomId', roomId);
    wsUrl.searchParams.set('participantId', participantId);

    this.log('Connecting to WebSocket:', wsUrl.toString());
    this.ws = new WebSocket(wsUrl.toString());

    this.ws.onopen = () => {
      this.log('WebSocket connected');
      this.setState('connected');
      this.reconnectCount = 0;
      // Send join message to trigger participant list broadcast
      try {
        this.log('Sending join message');
        this.send({ type: 'join', payload: {} });
      } catch (error) {
        this.warn('Failed to send join message:', error);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Check if this is an API Gateway Lambda response
        if (typeof data === 'object' && data !== null && 'statusCode' in data && 'body' in data) {
          // Handle HTTP error status codes (4xx, 5xx)
          if (data.statusCode >= 400) {
            const body = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
            const errorType = body?.type === 'error' ? body.payload?.error : 'HTTP_ERROR';
            const errorMessage = body?.payload?.error || body?.error || `HTTP ${data.statusCode}`;
            this.error('WebSocket Lambda error response:', errorType, errorMessage, data);
            this.options.onError?.(errorType, errorMessage, { statusCode: data.statusCode, body });
            // For 429 (rate limit), also set state to error to prevent reconnection
            if (data.statusCode === 429) {
              this.setState('error');
              // Close the connection after rate limit error
              this.ws?.close(1008, 'Rate limit exceeded');
            }
            // Still pass error messages to onMessage so UI can display them
            if (body && typeof body === 'object' && body.type === 'error') {
              this.options.onMessage?.(body);
            }
            return;
          }
          // It's a Lambda response, parse the body
          try {
            const body = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
            if (body && typeof body === 'object' && 'type' in body) {
              this.options.onMessage?.(body);
            } else {
              this.log('Lambda response body missing type:', body);
            }
          } catch (bodyError) {
            this.error('Failed to parse Lambda response body:', bodyError, data.body);
          }
        } else if (typeof data === 'object' && data !== null && 'type' in data) {
          // Normal WebSocket message
          this.options.onMessage?.(data);
        } else {
          this.error('Received malformed WebSocket message:', data);
        }
      } catch (error) {
        this.error('Failed to parse WebSocket message:', error, event.data);
      }
    };

    this.ws.onerror = (error) => {
      this.error('WebSocket error:', error);
      this.setState('error');
    };

    this.ws.onclose = (event) => {
      this.log('WebSocket closed:', event.code, event.reason);
      this.setState('disconnected');

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.ws = null;

      // Check if this is a rate limit closure (code 1008 or reason contains "rate limit")
      const isRateLimit =
        event.code === 1008 ||
        event.reason.includes('rate limit') ||
        event.reason.includes('Rate limit');
      if (isRateLimit) {
        this.shouldReconnect = false;
        this.options.onError?.(
          'RATE_LIMIT',
          'Rate limit exceeded, please wait before reconnecting',
          { code: event.code, reason: event.reason }
        );
      }

      // Only attempt reconnect if we should reconnect
      if (this.shouldReconnect) {
        this.attemptReconnect();
      } else {
        this.log('Not attempting reconnect due to rate limit');
      }
    };
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(): void {
    this.log('WebSocketClient.disconnect called');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.log('Closing WebSocket connection');
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
    console.log(
      '[EstimateNest] WebSocket send attempt:',
      message.type,
      'state:',
      this.state,
      'ws exists:',
      !!this.ws
    );
    if (this.state !== 'connected' || !this.ws) {
      console.error('[EstimateNest] WebSocket not connected, state:', this.state);
      throw new Error('WebSocket is not connected');
    }

    // Wrap message with action field for API Gateway routing
    const wrappedMessage = {
      action: message.type,
      ...message,
    };

    console.log(
      '[EstimateNest] Sending WebSocket message:',
      JSON.stringify(wrappedMessage, null, 2)
    );
    this.ws.send(JSON.stringify(wrappedMessage));
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Update the message handler
   */
  setOnMessage(handler: MessageHandler): void {
    this.options.onMessage = handler;
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.log('WebSocket state change:', this.state, '->', newState);
      this.state = newState;
      this.options.onStateChange?.(newState);
    }
  }

  private attemptReconnect(): void {
    // Don't reconnect if rate limit exceeded
    if (!this.shouldReconnect) {
      this.log('Not reconnecting due to rate limit');
      return;
    }

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
