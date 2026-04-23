export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  type: 'console' | 'action' | 'action_result' | 'pageerror' | 'network' | 'ws';
  timestamp: number;
  user: string;
  data: Record<string, unknown>;
}

export interface WSFrame {
  direction: 'sent' | 'received';
  timestamp: number;
  payload: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  body: string;
}

export type UserAction =
  | 'createRoom'
  | 'joinRoom'
  | 'castVote'
  | 'reveal'
  | 'startNewRound'
  | 'changeName'
  | 'disconnect'
  | 'reconnect'
  | 'waitForParticipantList'
  | 'waitForRoundUpdate'
  | 'waitForReveal'
  | 'navigate'
  | 'fillForm'
  | 'click';

export interface RoomOptions {
  deck?: string;
  moderatorPassword?: string;
  autoRevealEnabled?: boolean;
  autoRevealCountdownSeconds?: number;
  allowAllParticipantsToReveal?: boolean;
  maxParticipants?: number;
  name?: string;
}

export interface CreateRoomResult {
  roomCode: string;
  participantId: string;
  roomId: string;
  joinUrl: string;
}
