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
  default: vi.fn(() => mockCacheManager),
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

  it.skip('should handle concurrent votes when no active round exists (race condition)', async () => {
    // This test simulates two participants voting at the exact same time
    // when there's no active round. Both should end up voting in the same round.

    // Mock UUIDs for rounds - both handlers will generate different round IDs
    // if they run concurrently and both create rounds
    const roundId1 = 'round-id-from-participant-1';
    const roundId2 = 'round-id-from-participant-2';

    // First, set up common mocks for both handler calls

    // 1. Rate limit checks (both participants allowed)
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 }); // Participant 1 rate limit
    mockDynamoDB.send.mockResolvedValueOnce({}); // Participant 1 rate limit record
    mockDynamoDB.send.mockResolvedValueOnce({ Count: 0 }); // Participant 2 rate limit
    mockDynamoDB.send.mockResolvedValueOnce({}); // Participant 2 rate limit record

    // 2. Participant queries (by connectionId)
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

    // 3. Active round cache - both return null (no active round)
    // Simulating concurrent reads before either writes
    mockCacheManager.getActiveRoundWithCache
      .mockResolvedValueOnce(null) // First handler call
      .mockResolvedValueOnce(null); // Second handler call

    // 4. Round creation - mock PutCommand for rounds table
    // First handler will create a round with roundId1
    // Second handler will create a round with roundId2 (in race condition)
    mockUuid.v4
      .mockReturnValueOnce(roundId1) // First handler round ID
      .mockReturnValueOnce('vote-id-1') // First handler vote ID
      .mockReturnValueOnce(roundId2) // Second handler round ID
      .mockReturnValueOnce('vote-id-2'); // Second handler vote ID

    // Mock round creation PutCommand (both succeed)
    mockDynamoDB.send.mockResolvedValueOnce({}); // First round creation
    mockDynamoDB.send.mockResolvedValueOnce({}); // Second round creation

    // 5. Transaction writes for votes (both succeed)
    mockDynamoDB.send.mockResolvedValueOnce({}); // First vote transaction
    mockDynamoDB.send.mockResolvedValueOnce({}); // Second vote transaction

    // 6. Votes queries for broadcast - each handler will query votes
    // Return votes based on which round each participant voted in
    // In race condition, participant1 votes in round1, participant2 in round2
    const voteItem1 = {
      id: 'vote-id-1',
      roundId: roundId1,
      participantId: participantId1,
      value: 5,
      createdAt: new Date().toISOString(),
    };

    const voteItem2 = {
      id: 'vote-id-2',
      roundId: roundId2,
      participantId: participantId2,
      value: 8,
      createdAt: new Date().toISOString(),
    };

    // Each handler queries votes multiple times due to retry logic
    // First handler queries votes for roundId1, finds only its own vote
    for (let i = 0; i < 5; i++) {
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [voteItem1],
      });
    }

    // Second handler queries votes for roundId2, finds only its own vote
    for (let i = 0; i < 5; i++) {
      mockDynamoDB.send.mockResolvedValueOnce({
        Items: [voteItem2],
      });
    }

    // 7. Participants cache (for auto-reveal check)
    mockCacheManager.getParticipantsWithCache
      .mockResolvedValueOnce([
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
      ])
      .mockResolvedValueOnce([
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

    // 8. Room cache (for auto-reveal settings)
    mockCacheManager.getRoomWithCache
      .mockResolvedValueOnce({
        id: roomId,
        sk: 'META',
        autoRevealEnabled: true,
        autoRevealCountdownSeconds: 3,
      })
      .mockResolvedValueOnce({
        id: roomId,
        sk: 'META',
        autoRevealEnabled: true,
        autoRevealCountdownSeconds: 3,
      });

    // Execute both handlers (simulating concurrent execution)
    const [response1, response2] = await Promise.all([
      handler(mockEvent1 as APIGatewayProxyEvent),
      handler(mockEvent2 as APIGatewayProxyEvent),
    ]);

    // Both votes should succeed
    expect(response1.statusCode).toBe(200);
    expect(response2.statusCode).toBe(200);

    // Parse response bodies
    const body1 = JSON.parse(response1.body);
    const body2 = JSON.parse(response2.body);

    expect(body1.type).toBe('ack');
    expect(body2.type).toBe('ack');

    // Verify that two rounds were created (exposing the race condition)
    // In an ideal system, only one round should be created
    // Count calls to uuid.v4 for round IDs (first and third calls)
    const uuidCalls = mockUuid.v4.mock.calls;
    console.log('UUID v4 calls:', uuidCalls.length);

    // First and third calls should be round IDs (as mocked)
    expect(uuidCalls.length).toBe(4); // 2 rounds + 2 votes
    // Verify that two distinct round IDs were generated
    expect(mockUuid.v4.mock.results[0].value).toBe(roundId1);
    expect(mockUuid.v4.mock.results[2].value).toBe(roundId2);

    // This assertion demonstrates the race condition
    // In a fixed system, only one round ID should be generated
    // For now, we expect 2 (demonstrating the issue)

    // Verify cache invalidation was called for both rounds
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledTimes(2);
    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);
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
