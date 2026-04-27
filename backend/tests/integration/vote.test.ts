import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/vote.js';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { broadcastToRoom } from '../../src/utils/broadcast';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getParticipantsWithCache: vi.fn(),
      getActiveRoundWithCache: vi.fn(),
      getRoomWithCache: vi.fn(),
      invalidateActiveRound: vi.fn(),
      invalidateParticipants: vi.fn(),
    },
  };
});

// Mock the DynamoDB DocumentClient - hoisted before imports
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  GetCommand: vi.fn(),
  PutCommand: vi.fn(),
  QueryCommand: vi.fn(),
  TransactWriteCommand: vi.fn(),
  UpdateCommand: vi.fn(),
  DeleteCommand: vi.fn(),
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
  sendToConnection: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

describe('vote handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock send function completely
    mockDynamoDB.send.mockReset();
    // Default mock that throws if called unexpectedly
    mockDynamoDB.send.mockImplementation((command) => {
      console.error('Unexpected DynamoDB call:', command.constructor.name);
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });

    // Reset cache mocks
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.getActiveRoundWithCache.mockReset();
    mockCacheManager.getRoomWithCache.mockReset();
    mockCacheManager.invalidateActiveRound.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    // Default mock that returns empty array (participants)
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => Promise.resolve([]));
    mockCacheManager.getActiveRoundWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getActiveRoundWithCache - test should mock this call');
    });
    mockCacheManager.getRoomWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getRoomWithCache - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
    process.env.ROUNDS_TABLE = 'test-rounds-table';
    process.env.VOTES_TABLE = 'test-votes-table';
    process.env.ROOMS_TABLE = 'test-rooms-table';
    process.env.RATE_LIMIT_TABLE = 'test-rate-limit-table';

    mockEvent = {
      requestContext: {
        connectionId: 'test-connection-id',
        routeKey: 'vote',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
      body: JSON.stringify({
        type: 'vote',
        payload: { value: 5 },
      }),
    };
  });

  it('should record a vote successfully', async () => {
    // Valid UUIDs for participant and room
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';

    // Mock rate limit check (QueryCommand for count)
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 0,
    });
    // Mock rate limit record (PutCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query (by connectionId)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock active round cache (no active round)
    mockCacheManager.getActiveRoundWithCache.mockResolvedValueOnce(null);

    // Mock round creation - two PutCommands: ACTIVE coordination item and round item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Conditional Put for ACTIVE item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Put for round item

    // Mock transaction write
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock votes query for broadcast - will be called multiple times due to retry logic
    // Mock 4 attempts in the loop (MAX_ATTEMPTS) and 1 final attempt
    // Return a vote item matching the participant
    const voteItem = {
      id: 'vote-id-123',
      roundId: 'round-id-123', // dummy, will be ignored
      participantId: participantId,
      value: 5,
      createdAt: new Date().toISOString(),
    };
    for (let i = 0; i < 5; i++) {
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [voteItem],
      });
    }

    // Mock participants cache (for auto-reveal check)
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        participantId,
        roomId,
        isModerator: false,
        connectionId: 'test-connection-id',
        id: participantId,
        name: 'Test User',
        avatarSeed: 'test',
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ]);

    // Mock room cache (for deck validation)
    mockCacheManager.getRoomWithCache.mockImplementationOnce(async (roomId) => {
      return {
        id: roomId,
        shortCode: 'ABCDEF',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        allowAllParticipantsToReveal: false,
        deck: {
          id: 'fibonacci',
          name: 'Fibonacci',
          values: [0, 1, 2, 3, 5, 8, 13, 20, 40, 100, '?', '☕'],
        },
        autoRevealEnabled: true,
        autoRevealCountdownSeconds: 3,
        maxParticipants: 50,
      };
    });

    // Mock room cache (for auto-reveal settings check)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
      allowAllParticipantsToReveal: false,
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('Vote recorded');
    // Verify cache invalidation was called when new round created
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);
  });

  it('should reject duplicate vote with idempotency key', async () => {
    // Valid UUIDs for participant and room
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';

    // Mock rate limit check (QueryCommand for count)
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 0,
    });
    // Mock rate limit record (PutCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query (by connectionId)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock active round cache (no active round)
    mockCacheManager.getActiveRoundWithCache.mockResolvedValueOnce(null);

    // Mock round creation - two PutCommands: ACTIVE coordination item and round item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Conditional Put for ACTIVE item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Put for round item

    // Mock room cache (for deck validation)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      deck: {
        id: 'fibonacci',
        name: 'Fibonacci',
        values: [0, 1, 2, 3, 5, 8, 13, 20, 40, 100, '?', '☕'],
      },
    });

    // Mock room cache (for auto-reveal settings check)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
      allowAllParticipantsToReveal: false,
    });

    // Mock transaction write throwing ConditionalCheckFailedException
    const conditionalError = new Error('Conditional check failed');
    (conditionalError as Error & { name: string }).name = 'ConditionalCheckFailedException';
    mockDynamoDB.send.mockRejectedValueOnce(conditionalError);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.message).toBe('Already voted in this round');
    expect(body.payload.code).toBe('DUPLICATE_VOTE');
    // Verify cache invalidation was called when new round created
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);
  });

  it('should return 404 when participant not found', async () => {
    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query returning empty items
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.message).toBe('Participant not found');
    expect(body.payload.code).toBe('PARTICIPANT_NOT_FOUND');
  });

  it('should reject vote when rate limit exceeded', async () => {
    // Mock rate limit check returning count >= limit (20)
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 20,
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.message).toBe('Rate limit exceeded');
    expect(body.payload.code).toBe('RATE_LIMIT');
  });

  it('should return 400 for invalid JSON', async () => {
    const invalidEvent = {
      ...mockEvent,
      body: '{ invalid json',
    } as APIGatewayProxyEvent;

    const response = await handler(invalidEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid JSON message');
  });

  it('should return 400 for unsupported message type', async () => {
    const unsupportedEvent = {
      ...mockEvent,
      body: JSON.stringify({ type: 'unsupported', payload: {} }),
    } as APIGatewayProxyEvent;

    const response = await handler(unsupportedEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid message format');
    expect(body.details).toBeDefined();
    // Should mention invalid input
    expect(body.details[0]).toMatch(/Invalid input/);
  });

  it('should return 400 for missing message type', async () => {
    const missingTypeEvent = {
      ...mockEvent,
      body: JSON.stringify({ payload: {} }),
    } as APIGatewayProxyEvent;

    const response = await handler(missingTypeEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid message format');
    expect(body.details).toBeDefined();
    // Should mention missing type or invalid union
    expect(body.details[0]).toMatch(/type/);
  });

  it('should handle reveal message successfully', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const roundId = 'round-123';
    const connectionId = 'test-connection-id';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 }); // rate limit query
    mockDynamoDB.send.mockResolvedValueOnce({}); // rate limit put

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          id: participantId,
          roomId,
          isModerator: true,
          connectionId,
          name: 'Test Moderator',
          avatarSeed: 'seed',
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Mock round get
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        roomId,
        roundId,
        title: 'Test Round',
        description: '',
        startedAt: new Date().toISOString(),
        revealedAt: null,
        isRevealed: false,
        scheduledRevealAt: null,
      },
    });

    // Mock room cache
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      sk: 'META',
      allowAllParticipantsToReveal: false,
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
    });

    // Mock round update
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock delete ACTIVE coordination item
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock votes query
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'vote1',
          roundId,
          participantId,
          value: 5,
          votedAt: new Date().toISOString(),
        },
      ],
    });

    // Create reveal event
    const revealEvent = {
      ...mockEvent,
      body: JSON.stringify({ type: 'reveal', payload: { roundId } }),
    } as APIGatewayProxyEvent;

    const response = await handler(revealEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('Votes revealed');
    // Verify cache invalidation was called
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);
    // Verify broadcast was called
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.objectContaining({ requestContext: expect.anything() }),
      roomId,
      expect.objectContaining({
        type: 'roundUpdate',
        payload: { round: expect.anything(), votes: expect.anything() },
      })
    );
  });

  it('should return 404 when round not found for reveal', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const roundId = 'round-123';
    const connectionId = 'test-connection-id';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          id: participantId,
          roomId,
          isModerator: true,
          connectionId,
          name: 'Test Moderator',
          avatarSeed: 'seed',
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Mock round get returning empty (no item)
    mockDynamoDB.send.mockResolvedValueOnce({ Item: null });

    const revealEvent = {
      ...mockEvent,
      body: JSON.stringify({ type: 'reveal', payload: { roundId } }),
    } as APIGatewayProxyEvent;

    const response = await handler(revealEvent);

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.message).toBe('Round not found');
    expect(body.payload.code).toBe('ROUND_NOT_FOUND');
  });

  it('should return 400 when round already revealed', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const roundId = 'round-123';
    const connectionId = 'test-connection-id';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          id: participantId,
          roomId,
          isModerator: true,
          connectionId,
          name: 'Test Moderator',
          avatarSeed: 'seed',
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Mock round get with isRevealed true
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        roomId,
        roundId,
        title: 'Test Round',
        description: '',
        startedAt: new Date().toISOString(),
        revealedAt: new Date().toISOString(),
        isRevealed: true,
        scheduledRevealAt: null,
      },
    });

    // Mock room cache
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      sk: 'META',
      allowAllParticipantsToReveal: false,
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
    });

    const revealEvent = {
      ...mockEvent,
      body: JSON.stringify({ type: 'reveal', payload: { roundId } }),
    } as APIGatewayProxyEvent;

    const response = await handler(revealEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.message).toBe('Round is already revealed');
    expect(body.payload.code).toBe('ROUND_ALREADY_REVEALED');
  });

  it('should handle join message successfully', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const connectionId = 'test-connection-id';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 }); // rate limit query
    mockDynamoDB.send.mockResolvedValueOnce({}); // rate limit put

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          id: participantId,
          roomId,
          isModerator: false,
          connectionId,
          name: 'Test User',
          avatarSeed: 'seed',
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Mock participants query by roomId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          id: participantId,
          roomId,
          isModerator: false,
          connectionId,
          name: 'Test User',
          avatarSeed: 'seed',
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Create join event (payload can be empty)
    const joinEvent = {
      ...mockEvent,
      body: JSON.stringify({ type: 'join', payload: {} }),
    } as APIGatewayProxyEvent;

    const response = await handler(joinEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('Joined');
    // Verify broadcast was called with participantList
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.objectContaining({ requestContext: expect.anything() }),
      roomId,
      expect.objectContaining({
        type: 'participantList',
        payload: { participants: expect.any(Array) },
      })
    );
  });

  it('should handle updateParticipant message successfully', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const connectionId = 'test-connection-id';
    const newName = 'Updated Name';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          connectionId,
          name: 'Old Name',
          avatarSeed: 'old-seed',
          isModerator: false,
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    // Mock update participant
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock query all participants in room
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          connectionId,
          name: newName,
          avatarSeed: 'updated-seed',
          isModerator: false,
          joinedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    const updateEvent = {
      ...mockEvent,
      body: JSON.stringify({
        type: 'updateParticipant',
        payload: { name: newName },
      }),
    } as APIGatewayProxyEvent;

    const response = await handler(updateEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('Participant updated');
    // Verify broadcast was called with participantList
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.anything(),
      roomId,
      expect.objectContaining({
        type: 'participantList',
        payload: { participants: expect.any(Array) },
      })
    );
  });

  it('should handle newRound message successfully', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const connectionId = 'test-connection-id';
    const title = 'New Round Title';
    const description = 'New round description';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          connectionId,
          name: 'Test User',
          isModerator: true,
        },
      ],
    });

    // Mock query for existing unrevealed rounds (none)
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    // Mock PutCommand for new round
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock PutCommand for ACTIVE coordination item
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock cache invalidation
    mockCacheManager.invalidateActiveRound.mockResolvedValueOnce(undefined);

    // Mock query for votes (empty)
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    const newRoundEvent = {
      ...mockEvent,
      body: JSON.stringify({
        type: 'newRound',
        payload: { title, description },
      }),
    } as APIGatewayProxyEvent;

    const response = await handler(newRoundEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('New round created or updated');
    // Verify broadcast was called with roundUpdate
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.anything(),
      roomId,
      expect.objectContaining({
        type: 'roundUpdate',
        payload: { round: expect.any(Object), votes: expect.any(Array) },
      })
    );
    // Verify cache invalidation was called
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);
  });

  it('should handle updateRound message successfully', async () => {
    const participantId = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
    const roomId = '11111111-2222-3333-8444-555555555555';
    const connectionId = 'test-connection-id';
    const roundId = 'round-123';
    const title = 'Updated Title';
    const description = 'Updated description';

    // Mock rate limit check (allow)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId,
          roomId,
          connectionId,
          name: 'Test User',
          isModerator: false,
        },
      ],
    });

    // Mock GetCommand for round (verify belongs to room)
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        roomId,
        roundId,
        title: 'Old Title',
        description: 'Old description',
        startedAt: new Date().toISOString(),
        revealedAt: null,
        isRevealed: false,
      },
    });

    // Mock UpdateCommand for round
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock GetCommand for updated round
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        roomId,
        roundId,
        title,
        description,
        startedAt: new Date().toISOString(),
        revealedAt: null,
        isRevealed: false,
      },
    });

    // Mock query for votes (empty)
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    const updateRoundEvent = {
      ...mockEvent,
      body: JSON.stringify({
        type: 'updateRound',
        payload: { roundId, title, description },
      }),
    } as APIGatewayProxyEvent;

    const response = await handler(updateRoundEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('ack');
    expect(body.payload.message).toBe('Round updated');
    // Verify broadcast was called with roundUpdate
    expect(broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToRoom).toHaveBeenCalledWith(
      expect.anything(),
      roomId,
      expect.objectContaining({
        type: 'roundUpdate',
        payload: { round: expect.any(Object), votes: expect.any(Array) },
      })
    );
  });
});
