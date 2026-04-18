import { z } from 'zod';

// ====================
// Core Type Schemas
// ====================

export const cardDeckSchema = z.object({
  id: z.string(),
  name: z.string(),
  values: z.array(z.union([z.number(), z.string()])),
});

export const roomSchema = z.object({
  id: z.string(),
  shortCode: z.string(), // e.g., "ABC123"
  createdAt: z.string().datetime(), // ISO timestamp
  expiresAt: z.string().datetime(), // ISO timestamp (createdAt + 14 days)
  moderatorPassword: z.string().optional(), // hashed, optional
  allowAllParticipantsToReveal: z.boolean(),
  maxParticipants: z.number().optional(), // default 50
  deck: cardDeckSchema, // default deck for the room (can be overridden by user)
  autoRevealEnabled: z.boolean().optional(), // default: true
  autoRevealCountdownSeconds: z.number().int().positive().optional(), // default: 3
});

export const participantSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  connectionId: z.string(), // WebSocket connection ID
  name: z.string().min(1).max(100),
  avatarSeed: z.string(), // used to generate deterministic avatar
  joinedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  isModerator: z.boolean(),
});

export const roundSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  startedAt: z.string().datetime(),
  revealedAt: z.string().datetime().optional(),
  isRevealed: z.boolean(),
});

export const voteSchema = z.object({
  id: z.string(),
  roundId: z.string(),
  participantId: z.string(),
  value: z.union([z.number(), z.string()]), // numeric or custom string (e.g., "XS", "M", "L")
  votedAt: z.string().datetime(),
});

// ====================
// WebSocket Message Schemas
// ====================

export const webSocketMessageBaseSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

export const joinMessageSchema = z.object({
  type: z.literal('join'),
  payload: z
    .object({
      roomCode: z.string().optional(),
      name: z.string().min(1).max(100).optional(),
      avatarSeed: z.string().optional(),
    })
    .optional(),
});

export const updateParticipantMessageSchema = z.object({
  type: z.literal('updateParticipant'),
  payload: z.object({
    name: z.string().min(1).max(100),
  }),
});

export const leaveMessageSchema = z.object({
  type: z.literal('leave'),
  payload: z.object({
    participantId: z.string(),
  }),
});

export const voteMessageSchema = z.object({
  type: z.literal('vote'),
  payload: z.object({
    roundId: z.string().optional(),
    value: z.union([z.number(), z.string()]),
  }),
});

export const revealMessageSchema = z.object({
  type: z.literal('reveal'),
  payload: z.object({
    roundId: z.string(),
  }),
});

export const newRoundMessageSchema = z.object({
  type: z.literal('newRound'),
  payload: z.object({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  }),
});

export const updateRoundMessageSchema = z.object({
  type: z.literal('updateRound'),
  payload: z.object({
    roundId: z.string(),
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  }),
});

export const participantListMessageSchema = z.object({
  type: z.literal('participantList'),
  payload: z.object({
    participants: z.array(participantSchema),
  }),
});

export const roundUpdateMessageSchema = z.object({
  type: z.literal('roundUpdate'),
  payload: z.object({
    round: roundSchema,
    votes: z.array(voteSchema),
  }),
});

export const participantUpdatedMessageSchema = z.object({
  type: z.literal('participantUpdated'),
  payload: z.object({
    success: z.boolean(),
    name: z.string(),
  }),
});

export const autoRevealCountdownMessageSchema = z.object({
  type: z.literal('autoRevealCountdown'),
  payload: z.object({
    countdownSeconds: z.number().int().positive(),
  }),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  payload: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
});

export const ackMessageSchema = z.object({
  type: z.literal('ack'),
  payload: z.object({
    message: z.string(),
  }),
});

export const webSocketMessageSchema = z.discriminatedUnion('type', [
  joinMessageSchema,
  updateParticipantMessageSchema,
  leaveMessageSchema,
  voteMessageSchema,
  revealMessageSchema,
  newRoundMessageSchema,
  updateRoundMessageSchema,
  participantListMessageSchema,
  roundUpdateMessageSchema,
  participantUpdatedMessageSchema,
  ackMessageSchema,
  autoRevealCountdownMessageSchema,
  errorMessageSchema,
]);

// ====================
// API Request Schemas
// ====================

export const shortCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/, {
  message: 'Room code must be 6 uppercase alphanumeric characters',
});

export const roomIdSchema = z.string().uuid();
export const participantIdSchema = z.string().uuid();

export const createRoomRequestSchema = z.object({
  deck: z.enum(['fibonacci', 'tshirt', 'powersOfTwo']).optional(),
  allowAllParticipantsToReveal: z.boolean().optional(),
  maxParticipants: z.number().int().positive().optional(),
  autoRevealEnabled: z.boolean().optional(),
  autoRevealCountdownSeconds: z.number().int().positive().optional(),
});

export const joinRoomRequestSchema = z.object({
  code: shortCodeSchema,
  participantId: participantIdSchema.optional(),
  name: z.string().min(1).max(100).optional(),
});

export const updateRoomRequestSchema = z.object({
  allowAllParticipantsToReveal: z.boolean().optional(),
  maxParticipants: z.number().int().positive().optional(),
  autoRevealEnabled: z.boolean().optional(),
  autoRevealCountdownSeconds: z.number().int().positive().optional(),
});

export const roomCodePathSchema = z.object({
  code: shortCodeSchema,
});

// ====================
// Utility Functions
// ====================

/**
 * Parse and validate a WebSocket message
 * @throws {z.ZodError} if validation fails
 */
export function parseWebSocketMessage(data: unknown) {
  return webSocketMessageSchema.parse(data);
}

/**
 * Safe parse a WebSocket message (returns result instead of throwing)
 */
export function safeParseWebSocketMessage(data: unknown) {
  return webSocketMessageSchema.safeParse(data);
}

/**
 * Validate a room creation request
 */
export function validateCreateRoomRequest(data: unknown) {
  return createRoomRequestSchema.parse(data);
}

/**
 * Validate a join room request (path parameters + query string)
 */
export function validateJoinRoomRequest(data: {
  code?: string;
  participantId?: string;
  name?: string;
}) {
  return joinRoomRequestSchema.parse(data);
}

/**
 * Validate a room update request
 */
export function validateUpdateRoomRequest(data: unknown) {
  return updateRoomRequestSchema.parse(data);
}

/**
 * Validate a room code path parameter
 */
export function validateRoomCodePath(data: { code?: string }) {
  return roomCodePathSchema.parse(data);
}

/**
 * Validate room ID and participant ID for WebSocket connection
 */
export function validateWebSocketConnectionParams(data: {
  roomId?: string;
  participantId?: string;
}) {
  return z
    .object({
      roomId: roomIdSchema,
      participantId: participantIdSchema,
    })
    .parse(data);
}

// Type exports for convenience
export type RoomSchema = z.infer<typeof roomSchema>;
export type ParticipantSchema = z.infer<typeof participantSchema>;
export type RoundSchema = z.infer<typeof roundSchema>;
export type VoteSchema = z.infer<typeof voteSchema>;
export type WebSocketMessageSchema = z.infer<typeof webSocketMessageSchema>;
