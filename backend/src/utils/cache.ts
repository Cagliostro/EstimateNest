import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Participant, Round } from '@estimatenest/shared';

// Cache configuration
const PARTICIPANT_CACHE_TTL_MS = 3 * 1000; // 3 seconds
const ACTIVE_ROUND_CACHE_TTL_MS = 2 * 1000; // 2 seconds
const ROOM_CACHE_TTL_MS = 10 * 1000; // 10 seconds (matches existing room cache)

// Cache entries with timestamps
interface ParticipantCacheEntry {
  participants: Participant[];
  timestamp: number;
}

interface ActiveRoundCacheEntry {
  round: Round | null;
  timestamp: number;
}

interface RoomCacheEntry {
  room: Record<string, unknown>;
  timestamp: number;
}

/**
 * Cache manager for reducing DynamoDB read operations.
 * Uses in-memory caching with TTLs suitable for real-time collaboration.
 * Caches are scoped per Lambda instance (warm start).
 */
export class CacheManager {
  private participantCache = new Map<string, ParticipantCacheEntry>();
  private activeRoundCache = new Map<string, ActiveRoundCacheEntry>();
  private roomCache = new Map<string, RoomCacheEntry>();

  constructor(
    private docClient: DynamoDBDocumentClient,
    private participantsTableName: string,
    private roundsTableName: string,
    private roomsTableName: string
  ) {}

  /**
   * Get participants for a room with cache (3s TTL)
   */
  async getParticipantsWithCache(roomId: string): Promise<Participant[]> {
    const cached = this.participantCache.get(roomId);
    const now = Date.now();

    if (cached && now - cached.timestamp < PARTICIPANT_CACHE_TTL_MS) {
      return cached.participants;
    }

    // Fetch from DynamoDB
    const participantsResult = await this.docClient.send(
      new QueryCommand({
        TableName: this.participantsTableName,
        KeyConditionExpression: 'roomId = :roomId',
        ExpressionAttributeValues: {
          ':roomId': roomId,
        },
      })
    );

    const participants = (participantsResult.Items as Participant[]) || [];
    this.participantCache.set(roomId, { participants, timestamp: now });
    return participants;
  }

  /**
   * Get active (unrevealed) round for a room with cache (2s TTL)
   */
  async getActiveRoundWithCache(roomId: string): Promise<Round | null> {
    const cached = this.activeRoundCache.get(roomId);
    const now = Date.now();

    if (cached && now - cached.timestamp < ACTIVE_ROUND_CACHE_TTL_MS) {
      return cached.round;
    }

    // Fetch from DynamoDB
    const activeRoundsResult = await this.docClient.send(
      new QueryCommand({
        TableName: this.roundsTableName,
        KeyConditionExpression: 'roomId = :roomId',
        FilterExpression: 'isRevealed = :false',
        ExpressionAttributeValues: {
          ':roomId': roomId,
          ':false': false,
        },
        ConsistentRead: true,
      })
    );

    const items = activeRoundsResult.Items || [];
    // Sort by startedAt descending to get the most recent round
    items.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    let round: Round | null = null;

    if (items.length > 0) {
      const item = items[0];
      // Map DynamoDB attributes to Round interface
      round = {
        id: item.roundId || item.id,
        roomId: item.roomId,
        title: item.title,
        description: item.description,
        startedAt: item.startedAt,
        revealedAt: item.revealedAt,
        isRevealed: item.isRevealed,
      };
    }

    this.activeRoundCache.set(roomId, { round, timestamp: now });
    return round;
  }

  /**
   * Get room metadata with cache (10s TTL)
   */
  async getRoomWithCache(roomId: string): Promise<Record<string, unknown> | undefined> {
    const cached = this.roomCache.get(roomId);
    const now = Date.now();

    if (cached && now - cached.timestamp < ROOM_CACHE_TTL_MS) {
      return cached.room;
    }

    // Fetch from DynamoDB
    const roomResult = await this.docClient.send(
      new GetCommand({
        TableName: this.roomsTableName,
        Key: { id: roomId, sk: 'META' },
      })
    );

    const room = roomResult.Item;
    if (room) {
      this.roomCache.set(roomId, { room, timestamp: now });
    }
    return room;
  }

  /**
   * Invalidate participant cache for a room
   */
  invalidateParticipants(roomId: string): void {
    this.participantCache.delete(roomId);
  }

  /**
   * Invalidate active round cache for a room
   */
  invalidateActiveRound(roomId: string): void {
    this.activeRoundCache.delete(roomId);
  }

  /**
   * Invalidate room cache for a room
   */
  invalidateRoom(roomId: string): void {
    this.roomCache.delete(roomId);
  }

  /**
   * Clear all caches (useful for testing or memory management)
   */
  clearAll(): void {
    this.participantCache.clear();
    this.activeRoundCache.clear();
    this.roomCache.clear();
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    participantCacheSize: number;
    activeRoundCacheSize: number;
    roomCacheSize: number;
  } {
    return {
      participantCacheSize: this.participantCache.size,
      activeRoundCacheSize: this.activeRoundCache.size,
      roomCacheSize: this.roomCache.size,
    };
  }
}

// Singleton instance for sharing across modules in the same Lambda instance
let sharedInstance: CacheManager | null = null;

export function getCacheManager(): CacheManager {
  if (!sharedInstance) {
    sharedInstance = new CacheManager(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      process.env.PARTICIPANTS_TABLE!,
      process.env.ROUNDS_TABLE!,
      process.env.ROOMS_TABLE!
    );
  }
  return sharedInstance;
}

// Default export for convenience
export default getCacheManager();
