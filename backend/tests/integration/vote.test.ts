import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/vote.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

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
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
  sendToConnection: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  default: vi.fn(() => mockCacheManager),
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
    // Default mock that throws if called unexpectedly
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getParticipantsWithCache - test should mock this call');
    });
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

    // Mock room cache (for auto-reveal settings)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      sk: 'META',
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
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
});
