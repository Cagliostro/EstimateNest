// Shared types and utilities for EstimateNest

// ====================
// Core Types
// ====================

export interface Room {
  id: string;
  shortCode: string; // e.g., "ABC123"
  createdAt: string; // ISO timestamp
  expiresAt: string; // ISO timestamp (createdAt + 14 days)
  moderatorPassword?: string; // hashed, optional
  allowAllParticipantsToReveal: boolean;
  maxParticipants?: number; // default 50
  deck: CardDeck; // default deck for the room (can be overridden by user)
  autoRevealEnabled?: boolean; // default: true
  autoRevealCountdownSeconds?: number; // default: 3
}

export interface Participant {
  id: string;
  roomId: string;
  connectionId: string; // WebSocket connection ID
  name: string;
  avatarSeed: string; // used to generate deterministic avatar
  joinedAt: string;
  lastSeenAt: string;
  isModerator: boolean;
}

export interface Round {
  id: string;
  roomId: string;
  title?: string;
  description?: string;
  startedAt: string;
  revealedAt?: string;
  isRevealed: boolean;
  scheduledRevealAt?: string;
}

export interface Vote {
  id: string;
  roundId: string;
  participantId: string;
  value: number | string; // numeric or custom string (e.g., "XS", "M", "L")
  votedAt: string;
  roomId?: string;
}

export type CardDeck = {
  id: string;
  name: string;
  values: (number | string)[];
};

// ====================
// Default Decks
// ====================

export const DEFAULT_DECKS: CardDeck[] = [
  {
    id: 'fibonacci',
    name: 'Fibonacci',
    values: [0, 1, 2, 3, 5, 8, 13, 20, 40, 100, '?', '☕'],
  },
  {
    id: 'tshirt',
    name: 'T‑Shirt Sizes',
    values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'],
  },
  {
    id: 'powersOfTwo',
    name: 'Powers of Two',
    values: [0, 1, 2, 4, 8, 16, 32, 64, '?', '☕'],
  },
];

/**
 * Get a deck by its ID from the default decks.
 * Returns the Fibonacci deck as default if not found.
 */
export function getDeckById(deckId: string): CardDeck {
  const deck = DEFAULT_DECKS.find((d) => d.id === deckId);
  if (!deck) {
    console.warn(`Deck with ID "${deckId}" not found, defaulting to Fibonacci`);
    return DEFAULT_DECKS[0]; // Fibonacci as default
  }
  return deck;
}

/**
 * Parse a deck input string into a CardDeck object.
 * Accepts a preset ID ('fibonacci', 'tshirt', 'powersOfTwo') or
 * a comma-separated custom string (e.g., '1, 2, 3, 5, 8').
 * Custom decks must have between 2 and 15 values.
 */
export function parseDeckInput(deckInput: string): CardDeck {
  const trimmed = deckInput.trim();

  if (['fibonacci', 'tshirt', 'powersOfTwo'].includes(trimmed)) {
    return getDeckById(trimmed);
  }

  const rawValues = trimmed
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  if (rawValues.length < 2 || rawValues.length > 15) {
    throw new Error(`Custom deck must have between 2 and 15 values, got ${rawValues.length}`);
  }

  const parsedValues = rawValues.map((v) => {
    const num = Number(v);
    return !isNaN(num) && v !== '' ? num : v;
  });

  return {
    id: 'custom',
    name: `Custom (${rawValues.join(', ')})`,
    values: parsedValues,
  };
}

// ====================
// WebSocket Messages
// ====================

export type WebSocketMessage =
  | { type: 'join'; payload?: { roomCode?: string; name?: string; avatarSeed?: string } }
  | { type: 'updateParticipant'; payload: { name: string } }
  | { type: 'leave'; payload: { participantId: string } }
  | { type: 'vote'; payload: { roundId: string; value: number | string } }
  | { type: 'reveal'; payload: { roundId: string } }
  | { type: 'newRound'; payload: { title?: string; description?: string } }
  | { type: 'updateRound'; payload: { roundId: string; title?: string; description?: string } }
  | { type: 'participantList'; payload: { participants: Participant[] } }
  | { type: 'roundUpdate'; payload: { round: Round; votes: Vote[] } }
  | { type: 'participantUpdated'; payload: { success: boolean; name: string } }
  | { type: 'autoRevealCountdown'; payload: { countdownSeconds: number } }
  | { type: 'error'; payload: { message: string; code?: string } }
  | { type: 'ack'; payload: { message: string } };

// ====================
// Utilities
// ====================

/**
 * Generate a short alphanumeric code (6 characters).
 * Collisions are handled by the database layer.
 */
export function generateShortCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // removed ambiguous chars
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Create a deterministic avatar seed from a participant name.
 * Falls back to a random string if no name provided.
 */
export function createAvatarSeed(name?: string): string {
  if (name && name.trim().length > 0) {
    return name.trim().toLowerCase().replace(/\s+/g, '-');
  }
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Calculate TTL in seconds (14 days).
 */
export function getRoomTTL(): number {
  return 14 * 24 * 60 * 60; // seconds
}

/**
 * Check if a room is expired.
 */
export function isRoomExpired(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date();
}

// ====================
// Zod Schemas (Runtime Validation)
// ====================

export * from './schemas';
