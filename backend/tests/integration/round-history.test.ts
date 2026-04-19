import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/round-history.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
  };
});

// Mock the DynamoDB DocumentClient - hoisted before imports
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  GetCommand: vi.fn(),
  QueryCommand: vi.fn(),
}));

describe('round-history handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock that throws if called unexpectedly
    mockDynamoDB.send.mockImplementation(() => {
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });

    // Set environment variables required by the handler
    process.env.ROOM_CODES_TABLE = 'test-room-codes-table';
    process.env.ROUNDS_TABLE = 'test-rounds-table';
    process.env.VOTES_TABLE = 'test-votes-table';

    mockEvent = {
      pathParameters: { code: 'ABCDEF' },
      headers: { origin: 'http://localhost:5173' },
    };
  });

  it('should return round history for a room', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock rounds query (two revealed rounds)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'round-1',
          roomId: 'room-123',
          title: 'Feature A',
          startedAt: '2024-01-01T10:00:00Z',
          revealedAt: '2024-01-01T10:05:00Z',
          isRevealed: true,
        },
        {
          id: 'round-2',
          roomId: 'room-123',
          title: 'Feature B',
          startedAt: '2024-01-01T11:00:00Z',
          revealedAt: '2024-01-01T11:05:00Z',
          isRevealed: true,
        },
      ],
    });

    // Mock votes queries (two rounds)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'vote-1',
          roundId: 'round-1',
          participantId: 'user-1',
          value: 5,
          votedAt: '2024-01-01T10:01:00Z',
        },
        {
          id: 'vote-2',
          roundId: 'round-1',
          participantId: 'user-2',
          value: 8,
          votedAt: '2024-01-01T10:02:00Z',
        },
      ],
    });

    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'vote-3',
          roundId: 'round-2',
          participantId: 'user-1',
          value: 3,
          votedAt: '2024-01-01T11:01:00Z',
        },
        {
          id: 'vote-4',
          roundId: 'round-2',
          participantId: 'user-2',
          value: '?',
          votedAt: '2024-01-01T11:02:00Z',
        },
        {
          id: 'vote-5',
          roundId: 'round-2',
          participantId: 'user-3',
          value: '☕',
          votedAt: '2024-01-01T11:03:00Z',
        },
      ],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(2);

    // Check first round stats
    expect(body[0].id).toBe('round-1');
    expect(body[0].voteCount).toBe(2);
    expect(body[0].average).toBe(6.5); // (5 + 8) / 2

    // Check second round stats (non-numeric votes filtered out)
    expect(body[1].id).toBe('round-2');
    expect(body[1].voteCount).toBe(3);
    expect(body[1].average).toBe(3); // only numeric vote is 3
  });

  it('should return empty array when no revealed rounds', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock rounds query (empty)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual([]);
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

  it('should return 400 for invalid room code format', async () => {
    // Invalid code (too short)
    mockEvent.pathParameters = { code: 'ABC' };

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid room code format');
  });

  it('should return 500 for DynamoDB error', async () => {
    // Mock room code lookup to throw error
    mockDynamoDB.send.mockRejectedValueOnce(new Error('DynamoDB error'));

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Internal server error');
  });

  it('should handle missing origin header', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock rounds query (empty)
    mockDynamoDB.send.mockResolvedValueOnce({ Items: [] });

    mockEvent.headers = {};
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
