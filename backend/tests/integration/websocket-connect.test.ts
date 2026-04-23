import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/websocket-connect.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
    mockCacheManager: {
      getRoomWithCache: vi.fn(),
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
  QueryCommand: vi.fn(),
  UpdateCommand: vi.fn(),
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

describe('websocket-connect handler', () => {
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
    mockCacheManager.getRoomWithCache.mockReset();
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();
    // Default mock that throws if called unexpectedly
    mockCacheManager.getRoomWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getRoomWithCache - test should mock this call');
    });
    mockCacheManager.getParticipantsWithCache.mockImplementation(() => {
      throw new Error('Unexpected call to getParticipantsWithCache - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';

    mockEvent = {
      requestContext: {
        connectionId: 'test-connection-id',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
      queryStringParameters: {
        roomId: '11111111-2222-4333-8444-555555555555',
        participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      },
    };
  });

  it('should successfully connect WebSocket and update participant', async () => {
    // Mock room fetch (getRoomWithCache) - with maxParticipants
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Mock connection limit check (QueryCommand for count) - under limit
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 50, // under 100 limit
    });

    // Mock participant update (UpdateCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participants cache
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'Test User',
        connectionId: 'test-connection-id',
        isModerator: false,
      },
      {
        id: 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff',
        name: 'Another User',
        connectionId: 'other-connection-id',
        isModerator: true,
      },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('connected');
    expect(body.payload.message).toBe('Connected');
    // Verify cache invalidation was called
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(
      '11111111-2222-4333-8444-555555555555'
    );
  });

  it('should reject connection when room connection limit exceeded', async () => {
    // Mock room fetch (getRoomWithCache) - with maxParticipants
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Mock connection limit check (QueryCommand for count) - over limit
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 120, // over 100 limit
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);
    console.log('Response:', response.statusCode, response.body);

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Connection limit exceeded (max 100 connections per room)');
  });

  it('should return 400 for invalid roomId format', async () => {
    // Invalid roomId (not a UUID)
    mockEvent.queryStringParameters = {
      roomId: 'invalid-room-id',
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('should return 400 for invalid participantId format', async () => {
    // Invalid participantId (not a UUID)
    mockEvent.queryStringParameters = {
      roomId: '11111111-2222-4333-8444-555555555555',
      participantId: 'invalid-participant-id',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('should return 400 for missing roomId or participantId', async () => {
    // Missing roomId
    mockEvent.queryStringParameters = {
      participantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Invalid roomId or participantId format');
  });

  it('should handle DynamoDB update error and return 500', async () => {
    // Mock room fetch (getRoomWithCache)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: '11111111-2222-4333-8444-555555555555',
      maxParticipants: 100,
    });

    // Mock connection limit check
    mockDynamoDB.send.mockResolvedValueOnce({
      Count: 50,
    });

    // Mock participant update to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });
});
