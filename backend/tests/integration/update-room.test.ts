import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from '../../src/handlers/update-room.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB } = vi.hoisted(() => {
  return {
    mockDynamoDB: {
      send: vi.fn(),
    },
  };
});

// Mock the DynamoDB DocumentClient
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  GetCommand: vi.fn(),
  UpdateCommand: vi.fn(),
  QueryCommand: vi.fn(),
}));

describe('update-room handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock that throws if called unexpectedly
    mockDynamoDB.send.mockImplementation(() => {
      throw new Error('Unexpected call to DynamoDB - test should mock this call');
    });

    // Set environment variables
    process.env.ROOMS_TABLE = 'test-rooms-table';
    process.env.ROOM_CODES_TABLE = 'test-room-codes-table';
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';

    mockEvent = {
      pathParameters: { code: 'ABCDEF' },
      headers: { origin: 'http://localhost:5173' },
      body: JSON.stringify({
        autoRevealEnabled: false,
        autoRevealCountdownSeconds: 5,
      }),
      requestContext: {
        connectionId: 'conn-123',
      } as unknown as APIGatewayProxyEvent['requestContext'],
    };
  });

  afterEach(() => {
    // Ensure mock is completely reset between tests
    mockDynamoDB.send.mockReset();
  });

  it('should update room settings as moderator', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
      },
    });

    // Mock participant query (moderator)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'participant-1',
          roomId: 'room-123',
          connectionId: 'conn-123',
          isModerator: true,
        },
      ],
    });

    // Mock room update
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock fetch updated room
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'room-123',
        shortCode: 'ABCDEF',
        autoRevealEnabled: false,
        autoRevealCountdownSeconds: 5,
        allowAllParticipantsToReveal: true,
        maxParticipants: 50,
      },
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.room.id).toBe('room-123');
    expect(body.room.shortCode).toBe('ABCDEF');
    expect(body.room.autoRevealEnabled).toBe(false);
    expect(body.room.autoRevealCountdownSeconds).toBe(5);
  });

  it('should return 403 for non-moderator participant', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
      },
    });

    // Mock participant query (non-moderator)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'participant-1',
          roomId: 'room-123',
          connectionId: 'conn-123',
          isModerator: false,
        },
      ],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Only moderators can update room settings');
  });

  it('should return 403 when participant not found', async () => {
    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
      },
    });

    // Mock participant query (empty)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Only moderators can update room settings');
  });

  it('should return 404 for invalid room code', async () => {
    // Mock room code lookup (not found)
    mockDynamoDB.send.mockResolvedValueOnce({ Item: null });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Room not found');
  });

  it('should return 400 for invalid request body', async () => {
    // Invalid body (missing fields)
    mockEvent.body = JSON.stringify({ autoRevealEnabled: 'not-a-boolean' });

    // Mock all possible DynamoDB calls in case validation passes (it shouldn't)
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
      },
    });
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'participant-1',
          roomId: 'room-123',
          connectionId: 'conn-123',
          isModerator: true,
        },
      ],
    });
    // Room update
    mockDynamoDB.send.mockResolvedValueOnce({});
    // Fetch updated room
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'room-123',
        shortCode: 'ABCDEF',
        autoRevealEnabled: false,
        autoRevealCountdownSeconds: 5,
      },
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    // Log for debugging
    console.log('Response status:', response.statusCode);
    console.log('Response body:', response.body);
    console.log('Number of DynamoDB calls:', mockDynamoDB.send.mock.calls.length);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid request parameters');
  });

  it('should return 400 for empty update fields', async () => {
    // Empty body
    mockEvent.body = JSON.stringify({});

    // Mock room code lookup
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
      },
    });

    // Mock participant query (moderator)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'participant-1',
          roomId: 'room-123',
          connectionId: 'conn-123',
          isModerator: true,
        },
      ],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('No valid fields to update');
  });

  it('should return 400 for invalid room code format', async () => {
    // Invalid code (too short)
    mockEvent.pathParameters = { code: 'ABC' };

    // Override default mock to track calls without throwing
    const mockSend = vi.fn();
    mockDynamoDB.send.mockImplementation(mockSend);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid request parameters');
    // Ensure DynamoDB wasn't called (validation should fail before DB)
    expect(mockSend).not.toHaveBeenCalled();
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
      },
    });

    // Mock participant query (moderator)
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          id: 'participant-1',
          roomId: 'room-123',
          connectionId: 'conn-123',
          isModerator: true,
        },
      ],
    });

    // Mock room update
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Mock fetch updated room
    mockDynamoDB.send.mockResolvedValueOnce({
      Item: {
        id: 'room-123',
        shortCode: 'ABCDEF',
        autoRevealEnabled: false,
        autoRevealCountdownSeconds: 5,
        allowAllParticipantsToReveal: true,
        maxParticipants: 50,
      },
    });

    // Add extra mock in case there are more calls (e.g., error handling)
    mockDynamoDB.send.mockResolvedValueOnce({});

    mockEvent.headers = {};
    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
