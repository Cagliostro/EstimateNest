import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/join-room.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getParticipantsWithCache: vi.fn(),
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
  UpdateCommand: vi.fn(),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

describe('join-room handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock send function completely
    mockDynamoDB.send.mockReset();
    // Default mock that throws if called unexpectedly
    mockDynamoDB.send.mockImplementation(() => {
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });

    // Reset cache mocks
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    // Default mock that throws if called unexpectedly
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getParticipantsWithCache - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.ROOM_CODES_TABLE = 'test-room-codes-table';
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
    process.env.ROUNDS_TABLE = 'test-rounds-table';
    process.env.VOTES_TABLE = 'test-votes-table';
    process.env.WEBSOCKET_URL = 'wss://test.example.com';

    mockEvent = {
      pathParameters: { code: 'ABCDEF' },
      queryStringParameters: {},
      headers: { origin: 'http://localhost:5173' },
    };
  });

  it('should create new participant when joining new room', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock participants cache (empty room)
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([]);

    // Mock participant creation (PutCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock rounds query (no rounds)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    // Mock votes query (none)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.roomId).toBe('room-123');
    expect(body.isNewParticipant).toBe(true);
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0].isModerator).toBe(true); // First participant is moderator
    // Verify cache invalidation was called when new participant created
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith('room-123');
  });

  it('should return existing participant when participantId provided', async () => {
    mockEvent.queryStringParameters = { participantId: '12345678-1234-1234-8234-123456789abc' };

    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock GetCommand for participant lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: '12345678-1234-1234-8234-123456789abc',
        participantId: '12345678-1234-1234-8234-123456789abc',
        roomId: 'room-123',
        name: 'Existing User',
        avatarSeed: 'existing-user',
        isModerator: true,
        connectionId: 'REST',
        joinedAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
      },
    });

    // Mock participants cache (one existing participant)
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        id: '12345678-1234-1234-8234-123456789abc',
        participantId: '12345678-1234-1234-8234-123456789abc',
        roomId: 'room-123',
        name: 'Existing User',
        avatarSeed: 'existing-user',
        isModerator: true,
        connectionId: 'REST',
        joinedAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
      },
    ]);

    // Mock participant update (lastSeenAt)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock rounds query (no rounds)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    // Mock votes query (none)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.participantId).toBe('12345678-1234-1234-8234-123456789abc');
    expect(body.isNewParticipant).toBe(false);
    expect(body.participants).toHaveLength(1);
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
  });

  it('should return 404 for invalid room code', async () => {
    // Mock room code lookup (not found)
    mockDynamoDB.send.mockResolvedValueOnce({ Item: null });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Room not found');
  });

  it('should return 410 for expired room', async () => {
    // Mock room code lookup with expired date
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() - 3600000).toISOString(),
      },
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(410);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Room has expired');
  });

  it('should return 400 for invalid request (missing code)', async () => {
    // No code in path parameters
    mockEvent.pathParameters = {};

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid request parameters');
  });

  it('should return 500 for DynamoDB error', async () => {
    // Mock room code lookup to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Internal server error');
  });
});
