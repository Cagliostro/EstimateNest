import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/vote.js';
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
  TransactWriteCommand: vi.fn(),
  UpdateCommand: vi.fn(),
}));

describe('vote handler', () => {
  const mockSend = vi.fn();
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock
    (DynamoDBDocumentClient.from as vi.Mock).mockReturnValue({ send: mockSend });

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
    // Mock participant query
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          participantId: 'participant-123',
          roomId: 'room-123',
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock active round query (no active round)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock round creation (PutCommand)
    mockSend.mockResolvedValueOnce({});

    // Mock transaction write
    mockSend.mockResolvedValueOnce({});

    // Mock votes query for broadcast
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock participants query for auto-reveal check
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          participantId: 'participant-123',
          roomId: 'room-123',
        },
      ],
    });

    // Mock room settings fetch
    mockSend.mockResolvedValueOnce({
      Item: {
        id: 'room-123',
        sk: 'META',
        autoRevealEnabled: true,
        autoRevealCountdownSeconds: 3,
      },
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Vote recorded');
  });

  it('should reject duplicate vote with idempotency key', async () => {
    // Mock participant query
    mockSend.mockResolvedValueOnce({
      Items: [
        {
          participantId: 'participant-123',
          roomId: 'room-123',
          isModerator: false,
          connectionId: 'test-connection-id',
        },
      ],
    });

    // Mock active round query (no active round)
    mockSend.mockResolvedValueOnce({
      Items: [],
    });

    // Mock round creation
    mockSend.mockResolvedValueOnce({});

    // Mock transaction write throwing ConditionalCheckFailedException
    const conditionalError = new Error('Conditional check failed');
    (conditionalError as Error & { name: string }).name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(conditionalError);

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Already voted in this round');
  });
});
