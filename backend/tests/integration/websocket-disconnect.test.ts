import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/websocket-disconnect.js';
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
  QueryCommand: vi.fn(),
  UpdateCommand: vi.fn(),
  TransactWriteCommand: vi.fn(),
}));

// Mock the broadcast utilities
vi.mock('../../src/utils/broadcast', () => ({
  broadcastToRoom: vi.fn(() => Promise.resolve()),
}));

// Mock the cache module
vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

describe('websocket-disconnect handler', () => {
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
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';

    mockEvent = {
      requestContext: {
        connectionId: 'test-connection-id',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
    };
  });

  it('should successfully disconnect WebSocket and update participant', async () => {
    const roomId = '11111111-2222-4333-8444-555555555555';
    const participantId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    // Mock participant query by connectionId (QueryCommand on GSI)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          roomId,
          participantId,
          name: 'Test User',
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock room connection count decrement (UpdateCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant update (UpdateCommand to remove connectionId)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participants cache
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        id: 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff',
        name: 'Another User',
        connectionId: 'other-connection-id',
        isModerator: true,
      },
      // Disconnected participant should not be in the list (no connectionId)
      {
        id: participantId,
        name: 'Test User',
        connectionId: null,
        isModerator: false,
      },
    ]);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('disconnected');
    expect(body.payload.message).toBe('Disconnected');
    // Verify cache invalidation was called
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(roomId);
  });

  it('should return success when no participant found with connectionId', async () => {
    // Mock participant query returns no items
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('disconnected');
    expect(body.payload.message).toBe('Disconnected');
    // Should not call cache invalidation when no participant found
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
  });

  it('should handle DynamoDB query error and return 500', async () => {
    // Mock participant query to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB query error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });

  it('should handle DynamoDB update error and return 500', async () => {
    const roomId = '11111111-2222-4333-8444-555555555555';
    const participantId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          roomId,
          participantId,
          name: 'Test User',
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock participant update to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB update error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('error');
    expect(body.payload.error).toBe('Internal server error');
  });

  it('should handle broadcast error but still return success', async () => {
    const roomId = '11111111-2222-4333-8444-555555555555';
    const participantId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    // Mock participant query by connectionId
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          roomId,
          participantId,
          name: 'Test User',
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock room connection count decrement (UpdateCommand)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participant update
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock participants cache
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        id: participantId,
        name: 'Test User',
        connectionId: null,
        isModerator: false,
      },
    ]);

    // Mock broadcast to throw error (handler should still return success)
    const { broadcastToRoom } = await import('../../src/utils/broadcast.js');
    (broadcastToRoom as vi.Mock).mockRejectedValueOnce(new Error('Broadcast error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    // Handler should still return 200 even if broadcast fails
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.type).toBe('disconnected');
    expect(body.payload.message).toBe('Disconnected');
  });
});
