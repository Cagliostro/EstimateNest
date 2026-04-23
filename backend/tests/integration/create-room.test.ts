import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/create-room.js';
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

describe('create-room handler', () => {
  const mockSend = vi.fn();
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    vi.clearAllMocks();
    (DynamoDBDocumentClient.from as vi.Mock).mockReturnValue({ send: mockSend });

    mockEvent = {
      body: JSON.stringify({}),
      headers: { origin: 'http://localhost:5173' },
    };
  });

  it('should create a new room with default settings', async () => {
    // Mock first PutCommand (room record)
    mockSend.mockResolvedValueOnce({});
    // Mock second PutCommand (room code mapping)
    mockSend.mockResolvedValueOnce({});

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.roomId).toBeDefined();
    expect(body.shortCode).toBeDefined();
    expect(body.shortCode.length).toBe(6);
    expect(body.expiresAt).toBeDefined();
    expect(body.joinUrl).toBeDefined();
  });

  it('should create room with custom settings', async () => {
    mockEvent.body = JSON.stringify({
      allowAllParticipantsToReveal: true,
      maxParticipants: 20,
      deck: 'tshirt',
      autoRevealEnabled: false,
      autoRevealCountdownSeconds: 5,
    });

    // Mock PutCommand calls
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(201);
  });

  it('should create room with custom deck string', async () => {
    mockEvent.body = JSON.stringify({
      deck: '1, 2, 3, 5, 8',
    });

    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(201);
  });

  it('should return 400 for custom deck with single value', async () => {
    mockEvent.body = JSON.stringify({
      deck: 'only',
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('between 2 and 15');
  });

  it('should return 400 for invalid request body', async () => {
    mockEvent.body = JSON.stringify({
      maxParticipants: 'not-a-number', // Invalid type
    });

    const response = await handler(mockEvent as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Invalid request parameters');
  });
});
