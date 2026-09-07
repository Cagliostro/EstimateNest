import { describe, it, expect, vi, beforeEach } from 'vitest';

// Table names and WEBSOCKET_URL are read as module constants, so the env must
// be set before the handler module is imported (hoisted runs pre-import).
const { mockSend, mockDocClientSend, mockCacheManager, mockUpdateCommand, mockDeleteCommand } =
  vi.hoisted(() => {
    process.env.ROUNDS_TABLE = 'test-rounds-table';
    process.env.VOTES_TABLE = 'test-votes-table';
    process.env.PARTICIPANTS_TABLE = 'test-participants-table';
    process.env.ROOMS_TABLE = 'test-rooms-table';
    process.env.WEBSOCKET_URL = 'wss://api-id.execute-api.eu-central-1.amazonaws.com/dev';
    return {
      mockSend: vi.fn(),
      mockDocClientSend: vi.fn(),
      mockCacheManager: {
        invalidateActiveRound: vi.fn(),
        invalidateParticipants: vi.fn(),
      },
      mockUpdateCommand: vi.fn((params: Record<string, unknown>) => ({ input: params })),
      mockDeleteCommand: vi.fn((params: Record<string, unknown>) => ({ input: params })),
    };
  });

// The handler now fans out through ws-fanout.ts, which constructs the
// management client and UpdateCommands — real classes recording construction
// on the hoisted vi.fns keep the assertions working (see broadcast.test.ts).
vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send = mockSend;
  },
  PostToConnectionCommand: class {
    input: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.input = params;
    }
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn(() => ({ send: mockDocClientSend })),
  },
  UpdateCommand: class {
    input: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      mockUpdateCommand(params);
      this.input = params;
    }
  },
  ScanCommand: vi.fn(),
  QueryCommand: vi.fn(),
  DeleteCommand: class {
    input: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      mockDeleteCommand(params);
      this.input = params;
    }
  },
}));

vi.mock('../../src/utils/cache', () => ({
  getCacheManager: vi.fn(() => mockCacheManager),
}));

// Import after mocks are set up
import { handler } from '../../src/handlers/scheduled-auto-reveal.js';

const roomId = 'room-1';
const roundItem = {
  roomId,
  roundId: 'round-1',
  id: 'round-1',
  title: 'Sprint 14',
  description: '',
  startedAt: '2026-09-01T10:00:00.000Z',
  isRevealed: false,
  scheduledRevealAt: '2026-09-07T08:00:00.000Z', // in the past
};

const voteItem = {
  id: 'vote-1',
  roundId: 'round-1',
  participantId: 'p1',
  value: 5,
  votedAt: '2026-09-07T07:59:00.000Z',
};

const participantRows = [
  {
    id: 'p1',
    participantId: 'p1',
    roomId,
    connectionId: 'conn1',
    name: 'Alice',
    avatarSeed: 'seed1',
    joinedAt: '2026-09-01T10:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
    isModerator: true,
  },
  {
    id: 'p2',
    participantId: 'p2',
    roomId,
    connectionId: 'conn2',
    name: 'Bob',
    avatarSeed: 'seed2',
    joinedAt: '2026-09-01T10:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
    isModerator: false,
  },
];

const ccfError = (): Error => {
  const error = new Error('ConditionalCheckFailedException');
  error.name = 'ConditionalCheckFailedException';
  return error;
};

describe('scheduled auto-reveal handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockDocClientSend.mockReset();
    mockCacheManager.invalidateActiveRound.mockReset();
    mockCacheManager.invalidateParticipants.mockReset();

    // Default successful mocks
    mockSend.mockResolvedValue({});
    mockDocClientSend.mockResolvedValue({});
  });

  it('reveals a due round and broadcasts roundUpdate to all participants', async () => {
    mockDocClientSend
      .mockResolvedValueOnce({ Items: [roundItem] }) // Scan
      .mockResolvedValueOnce({}) // Reveal update
      .mockResolvedValueOnce({}) // ACTIVE delete
      .mockResolvedValueOnce({ Items: [voteItem] }) // Votes query
      .mockResolvedValueOnce({ Items: participantRows }); // Participants query

    await handler();

    // Reveal update ran before any query
    expect(mockUpdateCommand).toHaveBeenCalledTimes(1);
    const revealInput = mockUpdateCommand.mock.calls[0][0] as {
      UpdateExpression?: string;
    };
    expect(revealInput.UpdateExpression).toContain('SET isRevealed = :true');
    expect(revealInput.UpdateExpression).toContain('REMOVE scheduledRevealAt');
    expect(revealInput.UpdateExpression).toContain('expiresAt = :exp');

    expect(mockCacheManager.invalidateActiveRound).toHaveBeenCalledWith(roomId);

    // The revealed round must no longer act as the active round
    expect(mockDeleteCommand).toHaveBeenCalledTimes(1);
    const deleteInput = mockDeleteCommand.mock.calls[0][0] as { Key?: Record<string, string> };
    expect(deleteInput.Key).toEqual({ roomId, roundId: 'ACTIVE' });

    expect(mockDocClientSend).toHaveBeenCalledTimes(5); // scan, reveal, delete, votes, participants

    expect(mockSend).toHaveBeenCalledTimes(2); // conn1 + conn2
    const firstData = JSON.parse(mockSend.mock.calls[0][0].input.Data);
    expect(firstData).toMatchObject({
      type: 'roundUpdate',
      payload: {
        round: {
          id: 'round-1',
          roomId,
          title: 'Sprint 14',
          isRevealed: true,
          revealedAt: expect.any(String),
        },
        votes: [{ participantId: 'p1', value: 5 }],
      },
    });
    // scheduledRevealAt must not leak into the broadcast payload
    expect(firstData.payload.round.scheduledRevealAt).toBeUndefined();
  });

  it('cleans up a stale connection with grace-guarded CAS and balances the count', async () => {
    mockDocClientSend
      .mockResolvedValueOnce({ Items: [roundItem] }) // Scan
      .mockResolvedValueOnce({}) // Reveal update
      .mockResolvedValueOnce({}) // ACTIVE delete
      .mockResolvedValueOnce({ Items: [voteItem] }) // Votes query
      .mockResolvedValueOnce({ Items: participantRows }); // Participants query

    // conn1 is gone (410), conn2 and the refresh sends succeed
    mockSend
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 410 } })
      .mockResolvedValue({});

    await handler();

    // roundUpdate to both + roster refresh to the survivor only
    expect(mockSend).toHaveBeenCalledTimes(3);
    const refreshCall = mockSend.mock.calls[2][0].input;
    expect(refreshCall.ConnectionId).toBe('conn2');
    expect(JSON.parse(refreshCall.Data)).toMatchObject({
      type: 'participantList',
      payload: { participants: [{ id: 'p2', connectionId: 'conn2' }] },
    });

    // The stale connection triggered a mapping REMOVE and a count balance
    const cleanupCall = mockUpdateCommand.mock.calls.find((call) =>
      (call[0] as { UpdateExpression?: string }).UpdateExpression?.startsWith(
        'REMOVE connectionId'
      )
    );
    expect(cleanupCall).toBeDefined();
    const cleanupInput = cleanupCall![0] as {
      ConditionExpression?: string;
      ExpressionAttributeValues?: Record<string, string>;
    };
    expect(cleanupInput.ConditionExpression).toBe(
      'connectionId = :cid AND lastSeenAt < :graceCutoff'
    );
    expect(cleanupInput.ExpressionAttributeValues?.[':graceCutoff']).toBeDefined();

    expect(mockDocClientSend).toHaveBeenCalledTimes(7); // scan, reveal, delete, votes, participants, REMOVE, balance
    expect(mockCacheManager.invalidateParticipants).toHaveBeenCalledWith(roomId);
  });

  it('does not balance or refresh when the guarded REMOVE loses the race (CCF)', async () => {
    mockDocClientSend
      .mockResolvedValueOnce({ Items: [roundItem] }) // Scan
      .mockResolvedValueOnce({}) // Reveal update
      .mockResolvedValueOnce({}) // ACTIVE delete
      .mockResolvedValueOnce({ Items: [voteItem] }) // Votes query
      .mockResolvedValueOnce({ Items: participantRows }) // Participants query
      .mockRejectedValueOnce(ccfError()); // the mapping REMOVE

    mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: 410 } });

    await handler();

    // No count balance after the failed REMOVE, no cache invalidation, no refresh
    expect(mockDocClientSend).toHaveBeenCalledTimes(6); // scan, reveal, delete, votes, participants, failed REMOVE
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(2); // roundUpdate only, no roster refresh
  });

  it('does not clean up on non-410 errors', async () => {
    mockDocClientSend
      .mockResolvedValueOnce({ Items: [roundItem] }) // Scan
      .mockResolvedValueOnce({}) // Reveal update
      .mockResolvedValueOnce({}) // ACTIVE delete
      .mockResolvedValueOnce({ Items: [voteItem] }) // Votes query
      .mockResolvedValueOnce({ Items: participantRows }); // Participants query

    mockSend.mockRejectedValueOnce(new Error('Network error'));

    await handler();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockUpdateCommand).toHaveBeenCalledTimes(1); // reveal update only
    expect(mockCacheManager.invalidateParticipants).not.toHaveBeenCalled();
  });

  it('does nothing when no rounds are due', async () => {
    mockDocClientSend.mockResolvedValueOnce({ Items: [] }); // Scan

    await handler();

    expect(mockDocClientSend).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
