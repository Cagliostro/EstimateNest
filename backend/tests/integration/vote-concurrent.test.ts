import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../src/handlers/vote.js';
import { APIGatewayProxyEvent } from 'aws-lambda';

// Create mock DynamoDB client at module level using vi.hoisted to ensure it's available
const { mockDynamoDB, mockCacheManager, mockUuid, mockPutCommand } = vi.hoisted(() => {
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
    mockUuid: {
      v4: vi.fn(),
    },
    mockPutCommand: vi.fn(),
  };
});

// Mock the DynamoDB DocumentClient - hoisted before imports
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => mockDynamoDB),
  },
  GetCommand: vi.fn(),
  PutCommand: mockPutCommand,
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
  getCacheManager: vi.fn(() => mockCacheManager),
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: mockUuid.v4,
}));

describe('vote handler - concurrent scenarios', () => {
  let mockEvent1: Partial<APIGatewayProxyEvent>;
  let mockEvent2: Partial<APIGatewayProxyEvent>;
  const participantId1 = 'aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee';
  const participantId2 = 'bbbbbbbb-cccc-dddd-9eee-ffffffffffff';
  const roomId = '11111111-2222-3333-8444-555555555555';
  const connectionId1 = 'connection-id-1';
  const connectionId2 = 'connection-id-2';

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

    // Reset uuid mock
    mockUuid.v4.mockReset();

    // Reset command mocks
    mockPutCommand.mockReset();

    // Set environment variables required by the handler
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
    process.env.ROUNDS_TABLE = 'test-rounds-table';
    process.env.VOTES_TABLE = 'test-votes-table';
    process.env.ROOMS_TABLE = 'test-rooms-table';
    process.env.RATE_LIMIT_TABLE = 'test-rate-limit-table';

    // Create two events for two participants
    mockEvent1 = {
      requestContext: {
        connectionId: connectionId1,
        routeKey: 'vote',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
      body: JSON.stringify({
        type: 'vote',
        payload: { value: 5 },
      }),
    };

    mockEvent2 = {
      requestContext: {
        connectionId: connectionId2,
        routeKey: 'vote',
        domainName: 'test.execute-api.us-east-1.amazonaws.com',
        stage: 'test',
      },
      body: JSON.stringify({
        type: 'vote',
        payload: { value: 8 },
      }),
    };
  });

  it('should handle sequential votes correctly (no race condition)', async () => {
    // This test simulates two participants voting sequentially
    // The second participant should join the round created by the first

    const roundId = 'round-id-from-first-participant';

    // Mock UUID for round (only called once, for first participant)
    mockUuid.v4
      .mockReturnValueOnce(roundId) // First handler round ID
      .mockReturnValueOnce('vote-id-1') // First handler vote ID
      .mockReturnValueOnce('vote-id-2'); // Second handler vote ID (no round creation)

    // First participant voting flow
    // Rate limit
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Participant query
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId: participantId1,
          roomId,
          isModerator: false,
          connectionId: connectionId1,
        },
      ],
    });

    // Active round cache - returns null for first participant
    mockCacheManager.getActiveRoundWithCache.mockResolvedValueOnce(null);

    // Round creation - two PutCommands: ACTIVE coordination item and round item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Conditional Put for ACTIVE item
    mockDynamoDB.send.mockResolvedValueOnce({}); // Put for round item

    // Vote transaction
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Votes queries (first participant)
    const voteItem1 = {
      id: 'vote-id-1',
      roundId,
      participantId: participantId1,
      value: 5,
      createdAt: new Date().toISOString(),
    };

    for (let i = 0; i < 5; i++) {
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [voteItem1],
      });
    }

    // Participants cache (first participant)
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        participantId: participantId1,
        roomId,
        isModerator: false,
        connectionId: connectionId1,
        id: participantId1,
        name: 'Participant 1',
        avatarSeed: 'test1',
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ]);

    // Room cache (first participant)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      sk: 'META',
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
    });

    // Execute first vote
    const response1 = await handler(mockEvent1 as APIGatewayProxyEvent);
    expect(response1.statusCode).toBe(200);

    // Reset some mocks for second participant
    // Note: vi.clearAllMocks not called between sequential calls

    // Second participant voting flow
    // Rate limit
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 });
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Participant query
    mockDynamoDB.send.mockResolvedValueOnce({
      Items: [
        {
          participantId: participantId2,
          roomId,
          isModerator: false,
          connectionId: connectionId2,
        },
      ],
    });

    // Active round cache - returns the round created by first participant
    mockCacheManager.getActiveRoundWithCache.mockResolvedValueOnce({
      id: roundId,
      roomId,
      startedAt: new Date().toISOString(),
      isRevealed: false,
    });

    // Vote transaction (second participant)
    mockDynamoDB.send.mockResolvedValueOnce({});

    // Votes queries (both votes now in same round)
    const voteItem2 = {
      id: 'vote-id-2',
      roundId,
      participantId: participantId2,
      value: 8,
      createdAt: new Date().toISOString(),
    };

    for (let i = 0; i < 5; i++) {
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [voteItem1, voteItem2],
      });
    }

    // Participants cache (second participant)
    mockCacheManager.getParticipantsWithCache.mockResolvedValueOnce([
      {
        participantId: participantId1,
        roomId,
        isModerator: false,
        connectionId: connectionId1,
        id: participantId1,
        name: 'Participant 1',
        avatarSeed: 'test1',
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
      {
        participantId: participantId2,
        roomId,
        isModerator: false,
        connectionId: connectionId2,
        id: participantId2,
        name: 'Participant 2',
        avatarSeed: 'test2',
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ]);

    // Room cache (second participant)
    mockCacheManager.getRoomWithCache.mockResolvedValueOnce({
      id: roomId,
      sk: 'META',
      autoRevealEnabled: true,
      autoRevealCountdownSeconds: 3,
    });

    // Execute second vote
    const response2 = await handler(mockEvent2 as APIGatewayProxyEvent);
    expect(response2.statusCode).toBe(200);

    // Verify only one round was created
    const uuidCalls = mockUuid.v4.mock.calls;
    console.log('Sequential UUID v4 calls:', uuidCalls.length);

    // Should be 3 calls: round ID, vote-id-1, vote-id-2
    expect(uuidCalls.length).toBe(3);
    // Verify the first call was the round ID
    expect(mockUuid.v4.mock.results[0].value).toBe(roundId);

    // In sequential voting, only one round should be created
  });
});
