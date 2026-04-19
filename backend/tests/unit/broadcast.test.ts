import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { WebSocketMessage } from '@estimatenest/shared';

// Create mocks using vi.hoisted to ensure they're available before imports
const {
  mockSend,
  mockDocClientSend,
  mockCacheManager,
  mockPostToConnectionCommand,
  mockUpdateCommand,
  mockConsoleLog,
  mockConsoleWarn,
  mockConsoleError,
} = vi.hoisted(() => {
  return {
    mockSend: vi.fn(),
    mockDocClientSend: vi.fn(),
    mockCacheManager: {
      getParticipantsWithCache: vi.fn(),
      invalidateParticipants: vi.fn(),
    },
    mockPostToConnectionCommand: vi.fn((params) => ({ input: params })),
    mockUpdateCommand: vi.fn((params) => ({ input: params })),
    mockConsoleLog: vi.fn(),
    mockConsoleWarn: vi.fn(),
    mockConsoleError: vi.fn(),
  };
});

// Mock dependencies - these are hoisted by vitest and run before imports
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: vi.fn(() => ({ send: mockSend })),
  PostToConnectionCommand: mockPostToConnectionCommand,
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDocClientSend })),
  },
  UpdateCommand: mockUpdateCommand,
}));

vi.mock('../../src/utils/cache', () => ({
  default: vi.fn(() => mockCacheManager),
}));

// Import after mocks are set up
import { broadcastToRoom, sendToConnection } from '../../src/utils/broadcast.js';

describe('broadcast utility', () => {
  const mockEvent: APIGatewayProxyEvent = {
    requestContext: {
      domainName: 'test.execute-api.eu-central-1.amazonaws.com',
      stage: 'test',
      apiId: 'test-api-id',
      connectionId: 'sender-conn',
    } as APIGatewayProxyEvent['requestContext'],
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    path: '/',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    body: null,
    isBase64Encoded: false,
    resource: '',
  };

  const roomId = 'test-room-id';
  const message: WebSocketMessage = { type: 'roundUpdate', payload: { round: { id: 'round-1' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockDocClientSend.mockReset();
    mockCacheManager.getParticipantsWithCache.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();

    // Default successful mocks
    mockSend.mockResolvedValue({});
    mockDocClientSend.mockResolvedValue({});

    // Mock console to reduce test output noise
    vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
    vi.spyOn(console, 'warn').mockImplementation(mockConsoleWarn);
    vi.spyOn(console, 'error').mockImplementation(mockConsoleError);
  });

  describe('broadcastToRoom', () => {
    it('should broadcast message to all participants in room', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
        {
          id: 'p2',
          roomId,
          connectionId: 'conn2',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      await broadcastToRoom(mockEvent, roomId, message);

      expect(mockCacheManager.getParticipantsWithCache).toHaveBeenCalledWith(roomId);
      expect(mockSend).toHaveBeenCalledTimes(2); // Two participants
      // Verify messages sent to both connections
      expect(mockSend.mock.calls[0][0].input.ConnectionId).toBe('conn1');
      expect(mockSend.mock.calls[1][0].input.ConnectionId).toBe('conn2');
    });

    it('should exclude sender connection when excludeConnectionId provided', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
        {
          id: 'p2',
          roomId,
          connectionId: 'conn2',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        },
        {
          id: 'p3',
          roomId,
          connectionId: 'sender-conn',
          name: 'Sender',
          avatarSeed: 'seed3',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      await broadcastToRoom(mockEvent, roomId, message, 'sender-conn');

      expect(mockSend).toHaveBeenCalledTimes(2); // Only conn1 and conn2, not sender-conn
      const sentConnections = mockSend.mock.calls.map((call) => call[0].input.ConnectionId);
      expect(sentConnections).toEqual(['conn1', 'conn2']);
      expect(sentConnections).not.toContain('sender-conn');
    });

    it('should filter out participants without connectionId', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
        {
          id: 'p2',
          roomId,
          connectionId: '',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        }, // empty connectionId
        {
          id: 'p3',
          roomId,
          connectionId: undefined,
          name: 'Charlie',
          avatarSeed: 'seed3',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        }, // undefined
        {
          id: 'p4',
          roomId,
          connectionId: 'REST',
          name: 'REST',
          avatarSeed: 'seed4',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        }, // 'REST'
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      await broadcastToRoom(mockEvent, roomId, message);

      expect(mockSend).toHaveBeenCalledTimes(1); // Only conn1
      expect(mockSend.mock.calls[0][0].input.ConnectionId).toBe('conn1');
    });

    it('should clean up stale connections (410 status)', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          participantId: 'part1',
          connectionId: 'stale-conn',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
        {
          id: 'p2',
          roomId,
          participantId: 'part2',
          connectionId: 'good-conn',
          name: 'Bob',
          avatarSeed: 'seed2',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: true,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      // First call fails with 410 (GoneException), second succeeds
      const goneError = { $metadata: { httpStatusCode: 410 } };
      mockSend.mockRejectedValueOnce(goneError).mockResolvedValueOnce({});

      await broadcastToRoom(mockEvent, roomId, message);

      expect(mockSend).toHaveBeenCalledTimes(2);
      // Should have attempted to clean up stale connection
      expect(mockDocClientSend).toHaveBeenCalledTimes(1);
      expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(roomId);
    });

    it('should clean up stale connections (403 status)', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          participantId: 'part1',
          connectionId: 'forbidden-conn',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      const forbiddenError = { $metadata: { httpStatusCode: 403 } };
      mockSend.mockRejectedValueOnce(forbiddenError);

      await broadcastToRoom(mockEvent, roomId, message);

      expect(mockDocClientSend).toHaveBeenCalledTimes(1);
      expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(roomId);
    });

    it('should not clean up connection on other errors', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          participantId: 'part1',
          connectionId: 'conn1',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      const otherError = new Error('Network error');
      mockSend.mockRejectedValueOnce(otherError);

      await broadcastToRoom(mockEvent, roomId, message);

      expect(mockDocClientSend).not.toHaveBeenCalled();
      expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    });

    it('should handle cleanup failure gracefully', async () => {
      const participants = [
        {
          id: 'p1',
          roomId,
          participantId: 'part1',
          connectionId: 'stale-conn',
          name: 'Alice',
          avatarSeed: 'seed1',
          joinedAt: '2025-01-01T00:00:00Z',
          lastSeenAt: '2025-01-01T00:00:00Z',
          isModerator: false,
        },
      ];
      mockCacheManager.getParticipantsWithCache.mockResolvedValue(participants);

      const goneError = { $metadata: { httpStatusCode: 410 } };
      mockSend.mockRejectedValueOnce(goneError);
      mockDocClientSend.mockRejectedValueOnce(new Error('DynamoDB error'));

      // Should not throw
      await expect(broadcastToRoom(mockEvent, roomId, message)).resolves.not.toThrow();
    });
  });

  describe('sendToConnection', () => {
    it('should send message to connection successfully', async () => {
      const connectionId = 'test-conn';
      const message: WebSocketMessage = { type: 'ack', payload: { message: 'Success' } };

      await sendToConnection(mockEvent, connectionId, message);

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].input.ConnectionId).toBe(connectionId);
    });

    it('should retry on 410 error with exponential backoff', async () => {
      const connectionId = 'test-conn';
      const message: WebSocketMessage = { type: 'ack', payload: { message: 'Success' } };

      const goneError = { $metadata: { httpStatusCode: 410 } };
      mockSend
        .mockRejectedValueOnce(goneError) // First attempt fails
        .mockResolvedValueOnce({}); // Second succeeds

      await sendToConnection(mockEvent, connectionId, message);

      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should give up after max retries', async () => {
      const connectionId = 'test-conn';
      const message: WebSocketMessage = { type: 'ack', payload: { message: 'Success' } };

      const goneError = { $metadata: { httpStatusCode: 410 } };
      mockSend.mockRejectedValue(goneError); // All attempts fail

      await expect(sendToConnection(mockEvent, connectionId, message)).rejects.toEqual(goneError);
      expect(mockSend).toHaveBeenCalledTimes(3); // maxRetries = 3
    });

    it('should not retry on non-410 errors', async () => {
      const connectionId = 'test-conn';
      const message: WebSocketMessage = { type: 'ack', payload: { message: 'Success' } };

      const otherError = new Error('Network error');
      mockSend.mockRejectedValueOnce(otherError);

      await expect(sendToConnection(mockEvent, connectionId, message)).rejects.toEqual(otherError);
      expect(mockSend).toHaveBeenCalledTimes(1); // No retry
    });
  });
});
