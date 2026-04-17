import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/join-room.js';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Mock the DynamoDB DocumentClient
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({
      send: vi.fn(),
    })),
  },
  GetCommand: vi.fn(),
  PutCommand: vi.fn(),
  QueryCommand: vi.fn(),
  UpdateCommand: vi.fn(),
}));

describe('join-room handler', () => {
  const mockSend = vi.fn();
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    (DynamoDBDocumentClient.from as vi.Mock).mockReturnValue({ send: mockSend });

    mockEvent = {
      pathParameters: { code: 'ABCDEF' },
      queryStringParameters: {},
      headers: { origin: 'http://localhost:5173' },
    };
  });

  it('should create new participant when joining new room', async () => {
    // Mock room code lookup
    mockSend.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock participants query (empty room)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock participant creation (PutCommand)
    mockSend.mockResolvedValueOnce({});

    // Mock rounds query (no rounds)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock votes query (none)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.roomId).toBe('room-123');
    expect(body.isNewParticipant).toBe(true);
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0].isModerator).toBe(true); // First participant is moderator
  });

  it('should return existing participant when participantId provided', async () => {
    mockEvent.queryStringParameters = { participantId: 'existing-123' };

    // Mock room code lookup
    mockSend.mockResolvedValueOnce({
      Item: {
        shortCode: 'ABCDEF',
        roomId: 'room-123',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });

    // Mock participants query (one existing participant)
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          id: 'existing-123',
          participantId: 'existing-123',
          roomId: 'room-123',
          name: 'Existing User',
          avatarSeed: 'existing-user',
          isModerator: true,
          connectionId: 'REST',
          joinedAt: '2024-01-01T00:00:00Z',
          lastSeenAt: '2024-01-01T00:00:00Z',
        },
      ],
    });

    // Mock participant update (lastSeenAt)
    mockSend.mockResolvedValueOnce({});

    // Mock rounds query (no rounds)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock votes query (none)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.participantId).toBe('existing-123');
    expect(body.isNewParticipant).toBe(false);
    expect(body.participants).toHaveLength(1);
  });

  it('should return 404 for invalid room code', async () => {
    // Mock room code lookup (not found)
    mockSend.mockResolvedValueOnce({ Item: null });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Room not found');
  });

  it('should return 410 for expired room', async () => {
    // Mock room code lookup with expired date
    mockSend.mockResolvedValueOnce({
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
});
