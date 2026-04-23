import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WSWebSocket } from 'ws';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import type { Room, Participant, Round, Vote, WebSocketMessage } from '@estimatenest/shared';
import { generateShortCode, getDeckById } from '@estimatenest/shared';

const app = express();
const server = createServer(app);
const port = 3000;
const wsPort = 3001;

// Middleware
app.use(bodyParser.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// In-memory storage
const rooms = new Map<string, Room>();
const participants = new Map<string, Participant>();
const connections = new Map<string, WSWebSocket>(); // connectionId -> WebSocket
const participantByConnection = new Map<string, string>(); // connectionId -> participantId
const rounds = new Map<string, Round>();
const votes = new Map<string, Vote>();

// Create avatar seed
function createAvatarSeed(name?: string): string {
  if (name && name.trim().length > 0) {
    return name.trim().toLowerCase().replace(/\s+/g, '-');
  }
  return Math.random().toString(36).substring(2, 10);
}

// REST API Routes

// Create room
app.post('/rooms', (req, res) => {
  try {
    const { deck = 'fibonacci' } = req.body;
    const roomId = uuidv4();
    const shortCode = generateShortCode();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const room: Room = {
      id: roomId,
      shortCode,
      createdAt: now,
      expiresAt,
      allowAllParticipantsToReveal: false,
      deck: getDeckById(deck),
    };

    rooms.set(roomId, room);

    // Create initial round
    const roundId = uuidv4();
    const round: Round = {
      id: roundId,
      roomId,
      startedAt: now,
      isRevealed: false,
      scheduledRevealAt: undefined,
    };
    rounds.set(roundId, round);

    res.status(201).json({
      roomId,
      shortCode,
      joinUrl: `http://localhost:5173/room/${shortCode}`,
      expiresAt,
    });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Join room
app.get('/rooms/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { name, participantId } = req.query;

    // Find room by short code
    const room = Array.from(rooms.values()).find((r) => r.shortCode === code.toUpperCase());
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    let finalParticipantId: string;
    let finalName: string;
    let avatarSeed: string;
    let isNewParticipant = false;

    if (participantId && typeof participantId === 'string') {
      // Try to fetch existing participant
      const existingParticipant = participants.get(participantId);
      if (existingParticipant && existingParticipant.roomId === room.id) {
        // Participant exists - use stored details
        finalParticipantId = participantId;
        finalName = existingParticipant.name;
        avatarSeed = existingParticipant.avatarSeed;
        // Update lastSeenAt
        existingParticipant.lastSeenAt = new Date().toISOString();
        participants.set(participantId, existingParticipant);
      } else {
        // Participant not found - treat as new participant
        isNewParticipant = true;
        finalParticipantId = uuidv4();
        finalName = (name as string) || `Participant ${finalParticipantId.slice(0, 4)}`;
        avatarSeed = createAvatarSeed(name as string);
      }
    } else {
      // New participant joining
      isNewParticipant = true;
      finalParticipantId = uuidv4();
      finalName = (name as string) || `Participant ${finalParticipantId.slice(0, 4)}`;
      avatarSeed = createAvatarSeed(name as string);
    }

    // Create new participant record if new
    if (isNewParticipant) {
      const connectionId = uuidv4(); // Temporary for response, real one set on WS connect
      const now = new Date().toISOString();
      const participant: Participant = {
        id: finalParticipantId,
        roomId: room.id,
        connectionId,
        name: finalName,
        avatarSeed,
        joinedAt: now,
        lastSeenAt: now,
        isModerator: false,
      };

      // First participant becomes moderator
      const roomParticipants = Array.from(participants.values()).filter(
        (p) => p.roomId === room.id
      );
      if (roomParticipants.length === 0) {
        participant.isModerator = true;
      }

      participants.set(finalParticipantId, participant);
    }

    // Fetch all participants in the room (including the one we just added)
    const roomParticipants = Array.from(participants.values()).filter((p) => p.roomId === room.id);

    // Fetch active round (not revealed)
    const roomRounds = Array.from(rounds.values()).filter(
      (r) => r.roomId === room.id && !r.isRevealed
    );
    const round = roomRounds.length > 0 ? roomRounds[0] : null;
    let roundVotes: Vote[] = [];
    if (round) {
      roundVotes = Array.from(votes.values()).filter((v) => v.roundId === round.id);
    }

    // Remove connectionId from response for privacy/security
    const participantsWithoutConnection = roomParticipants.map((p) => ({
      id: p.id,
      roomId: p.roomId,
      name: p.name,
      avatarSeed: p.avatarSeed,
      joinedAt: p.joinedAt,
      lastSeenAt: p.lastSeenAt,
      isModerator: p.isModerator,
    }));

    res.json({
      roomId: room.id,
      participantId: finalParticipantId,
      name: finalName,
      avatarSeed,
      isNewParticipant,
      webSocketUrl: `ws://localhost:${wsPort}?roomId=${room.id}&participantId=${finalParticipantId}`,
      participants: participantsWithoutConnection,
      round,
      votes: roundVotes,
    });
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Failed to join room' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start REST server
server.listen(port, () => {
  console.log(`REST API server listening on http://localhost:${port}`);
});

// WebSocket Server
const wss = new WebSocketServer({ port: wsPort });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost`);
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');

  if (!roomId || !participantId) {
    ws.close(1008, 'Missing roomId or participantId');
    return;
  }

  const participant = participants.get(participantId);
  if (!participant || participant.roomId !== roomId) {
    ws.close(1008, 'Invalid participant or room');
    return;
  }

  const connectionId = uuidv4();
  connections.set(connectionId, ws);
  participantByConnection.set(connectionId, participantId);

  // Update participant with real connectionId
  participant.connectionId = connectionId;
  participants.set(participantId, participant);

  console.log(`WebSocket connected: participant=${participantId}, room=${roomId}`);

  // Send welcome message
  ws.send(
    JSON.stringify({
      type: 'connected',
      payload: { participantId, roomId },
    })
  );

  // Broadcast participant list update
  broadcastParticipantList(roomId);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleWebSocketMessage(ws, connectionId, roomId, participantId, message);
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { message: 'Invalid message format' },
        })
      );
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket disconnected: participant=${participantId}`);

    // Clean up connection
    connections.delete(connectionId);
    participantByConnection.delete(connectionId);

    // Update participant last seen
    if (participant) {
      participant.lastSeenAt = new Date().toISOString();
      participants.set(participantId, participant);
    }

    // Broadcast leave notification
    broadcastToRoom(roomId, {
      type: 'leave',
      payload: { participantId },
    });

    // Update participant list
    broadcastParticipantList(roomId);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// WebSocket message handling
async function handleWebSocketMessage(
  ws: WSWebSocket,
  connectionId: string,
  roomId: string,
  participantId: string,
  message: WebSocketMessage
) {
  switch (message.type) {
    case 'vote': {
      const { roundId, value } = message.payload;

      // Find active round for room if roundId not specified
      let activeRoundId = roundId;
      if (!activeRoundId) {
        const roomRounds = Array.from(rounds.values()).filter(
          (r) => r.roomId === roomId && !r.isRevealed
        );
        if (roomRounds.length === 0) {
          // Create new round
          activeRoundId = uuidv4();
          const newRound: Round = {
            id: activeRoundId,
            roomId,
            startedAt: new Date().toISOString(),
            isRevealed: false,
            scheduledRevealAt: undefined,
          };
          rounds.set(activeRoundId, newRound);
        } else {
          activeRoundId = roomRounds[0].id;
        }
      }

      const voteId = uuidv4();
      const vote: Vote = {
        id: voteId,
        roundId: activeRoundId,
        participantId,
        value,
        votedAt: new Date().toISOString(),
      };

      // Remove existing vote from this participant in this round
      const existingVotes = Array.from(votes.values()).filter(
        (v) => v.roundId === activeRoundId && v.participantId === participantId
      );
      existingVotes.forEach((v) => votes.delete(v.id));

      votes.set(voteId, vote);

      // Broadcast round update
      const round = rounds.get(activeRoundId)!;
      const roundVotes = Array.from(votes.values()).filter((v) => v.roundId === activeRoundId);

      broadcastToRoom(roomId, {
        type: 'roundUpdate',
        payload: { round, votes: roundVotes },
      });

      break;
    }

    case 'reveal': {
      const { roundId } = message.payload;
      const round = rounds.get(roundId);

      if (!round || round.roomId !== roomId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { message: 'Round not found' },
          })
        );
        return;
      }

      // Update round
      round.isRevealed = true;
      round.revealedAt = new Date().toISOString();
      rounds.set(roundId, round);

      // Get votes for this round
      const roundVotes = Array.from(votes.values()).filter((v) => v.roundId === roundId);

      // Broadcast revealed votes
      broadcastToRoom(roomId, {
        type: 'roundUpdate',
        payload: { round, votes: roundVotes },
      });

      break;
    }

    case 'updateParticipant': {
      const { name } = message.payload;
      const participant = participants.get(participantId);
      if (!participant) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { message: 'Participant not found' },
          })
        );
        break;
      }
      participant.name = name;
      participant.avatarSeed = createAvatarSeed(name);
      participants.set(participantId, participant);
      broadcastParticipantList(roomId);
      break;
    }

    case 'newRound': {
      const { title, description } = message.payload;
      const roundId = uuidv4();
      const now = new Date().toISOString();
      const round: Round = {
        id: roundId,
        roomId,
        title,
        description,
        startedAt: now,
        isRevealed: false,
        scheduledRevealAt: undefined,
      };
      rounds.set(roundId, round);
      broadcastToRoom(roomId, {
        type: 'roundUpdate',
        payload: { round, votes: [] },
      });
      break;
    }

    case 'updateRound': {
      const { roundId, title, description } = message.payload;
      const round = rounds.get(roundId);
      if (!round || round.roomId !== roomId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            payload: { message: 'Round not found' },
          })
        );
        break;
      }
      if (title !== undefined) round.title = title;
      if (description !== undefined) round.description = description;
      rounds.set(roundId, round);
      const roundVotes = Array.from(votes.values()).filter((v) => v.roundId === roundId);
      broadcastToRoom(roomId, {
        type: 'roundUpdate',
        payload: { round, votes: roundVotes },
      });
      break;
    }

    default:
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { message: `Unsupported message type: ${message.type}` },
        })
      );
  }
}

// Helper functions
function broadcastToRoom(roomId: string, message: WebSocketMessage) {
  const roomParticipants = Array.from(participants.values()).filter((p) => p.roomId === roomId);

  roomParticipants.forEach((participant) => {
    const connection = connections.get(participant.connectionId);
    if (connection && connection.readyState === connection.OPEN) {
      connection.send(JSON.stringify(message));
    }
  });
}

function broadcastParticipantList(roomId: string) {
  const roomParticipants = Array.from(participants.values()).filter((p) => p.roomId === roomId);

  broadcastToRoom(roomId, {
    type: 'participantList',
    payload: { participants: roomParticipants },
  });
}

console.log(`WebSocket server listening on ws://localhost:${wsPort}`);
