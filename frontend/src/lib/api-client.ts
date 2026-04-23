import { config } from './config';
import { Participant, Round, Vote, CardDeck } from '@estimatenest/shared';

export interface CreateRoomRequest {
  moderatorPassword?: string;
  allowAllParticipantsToReveal?: boolean;
  maxParticipants?: number;
  deck?: string;
}

export interface CreateRoomResponse {
  roomId: string;
  shortCode: string;
  joinUrl: string;
  expiresAt: string;
}

export interface RoomSettings {
  deck: CardDeck;
  allowAllParticipantsToReveal: boolean;
  autoRevealEnabled?: boolean;
  autoRevealCountdownSeconds?: number;
  maxParticipants?: number;
}

export interface JoinRoomResponse {
  roomId: string;
  participantId: string;
  name: string;
  avatarSeed: string;
  webSocketUrl: string;
  participants?: Participant[];
  round?: Round | null;
  votes?: Vote[];
  isNewParticipant?: boolean;
  room?: RoomSettings;
}

export interface RoundHistoryItem extends Round {
  voteCount: number;
  average?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * REST API client for EstimateNest backend
 */
export const apiClient = {
  /**
   * Create a new planning poker room
   */
  async createRoom(request: CreateRoomRequest): Promise<CreateRoomResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }

    const response = await fetch(`${config.apiUrl}/rooms`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      let errorMessage = `Failed to create room: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      throw new ApiError(errorMessage, response.status);
    }

    return response.json();
  },

  /**
   * Join an existing room
   * @param code Room short code (e.g., "ABC123")
   * @param name Participant display name
   * @param participantId Optional participant ID for polling (skip creating new participant)
   */
  async joinRoom(code: string, name?: string, participantId?: string): Promise<JoinRoomResponse> {
    const url = new URL(`${config.apiUrl}/rooms/${code}`);
    if (name) {
      url.searchParams.set('name', name);
    }
    if (participantId) {
      url.searchParams.set('participantId', participantId);
    }

    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }

    const response = await fetch(url.toString(), {
      headers,
    });

    if (!response.ok) {
      let errorMessage = `Failed to join room: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      throw new ApiError(errorMessage, response.status);
    }

    return response.json();
  },

  /**
   * Fetch round history for a room
   * @param code Room short code
   */
  async fetchRoundHistory(code: string): Promise<RoundHistoryItem[]> {
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }

    const response = await fetch(`${config.apiUrl}/rooms/${code}/history`, {
      headers,
    });

    if (!response.ok) {
      let errorMessage = `Failed to fetch round history: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // Ignore JSON parse errors
      }
      throw new ApiError(errorMessage, response.status);
    }

    return response.json();
  },
};
