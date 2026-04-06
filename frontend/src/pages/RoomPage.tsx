import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoomStore } from '../store/room-store';
import { useParticipantStore } from '../store/participant-store';
import { useConnectionStore } from '../store/connection-store';
import { useRoomConnection } from '../hooks/use-room-connection';
import { DEFAULT_DECKS } from '@estimatenest/shared';

export default function RoomPage() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();

  // Stores
  const { roomId, shortCode, participants, currentRound, votes, isRevealed } = useRoomStore();
  const { participantId, name: participantName } = useParticipantStore();
  const { state: connectionState, error } = useConnectionStore();
  const { sendVote, revealVotes, disconnect } = useRoomConnection();

  // Local state
  const [selectedValue, setSelectedValue] = useState<number | string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);

  // Fibonacci deck (default)
  const deck = DEFAULT_DECKS.find((d: { id: string }) => d.id === 'fibonacci') || DEFAULT_DECKS[0];

  // Redirect to home if not connected
  useEffect(() => {
    if (connectionState === 'disconnected' && !roomId && roomCode) {
      // We have a room code but no connection - attempt to join?
      // For now, redirect to home with room code prefilled?
      // Let's keep them on page but show connection error
    }
  }, [connectionState, roomId, roomCode]);

  // Handle page leave
  useEffect(() => {
    return () => {
      // Don't disconnect immediately - user might be navigating within room
      // We'll disconnect only when component unmounts and no longer in room
    };
  }, []);

  const handleVote = (value: number | string) => {
    if (!participantId) return;

    setSelectedValue(value);
    try {
      sendVote(value);
    } catch (error) {
      console.error('Failed to send vote:', error);
      alert('Failed to submit vote. Please try again.');
    }
  };

  const handleReveal = async () => {
    if (!currentRound) return;

    setIsRevealing(true);
    try {
      await revealVotes();
    } catch (error) {
      console.error('Failed to reveal votes:', error);
      alert('Failed to reveal votes. You may not be the moderator.');
    } finally {
      setIsRevealing(false);
    }
  };

  const handleLeaveRoom = () => {
    disconnect();
    navigate('/');
  };

  const handleNewRound = () => {
    // Not implemented in Phase 1
    alert('New round functionality coming soon!');
  };

  // Calculate statistics
  const numericVotes = votes
    .map((v) => (typeof v.value === 'number' ? v.value : parseFloat(v.value as string)))
    .filter((v) => !isNaN(v));

  const averageVote =
    numericVotes.length > 0
      ? numericVotes.reduce((sum, val) => sum + val, 0) / numericVotes.length
      : null;

  const hasVoted = votes.some((v) => v.participantId === participantId);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      {/* Header */}
      <header className="max-w-6xl mx-auto py-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-primary-700">
              Room:{' '}
              <span className="font-mono bg-gray-200 dark:bg-gray-800 px-3 py-1 rounded">
                {shortCode || roomCode}
              </span>
            </h1>
            <p className="text-gray-500 dark:text-gray-400 mt-1">
              {connectionState === 'connected'
                ? 'Connected'
                : connectionState === 'connecting'
                  ? 'Connecting...'
                  : connectionState === 'error'
                    ? 'Connection error'
                    : 'Disconnected'}
              {participantName && ` • ${participantName}`}
            </p>
          </div>
          <button
            onClick={handleLeaveRoom}
            className="mt-4 md:mt-0 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg transition-colors"
          >
            Leave Room
          </button>
        </div>
      </header>

      {/* Connection error */}
      {error && (
        <div className="max-w-6xl mx-auto mb-6">
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl p-4 text-red-700 dark:text-red-300">
            <p className="font-medium">Error: {error}</p>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main voting area */}
          <div className="lg:col-span-2">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">
                {currentRound ? 'Current Round' : 'No active round'}
                {isRevealed && ' • Revealed!'}
              </h2>

              {isRevealed ? (
                <div>
                  <h3 className="text-lg font-semibold mb-4">Results</h3>
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-4 mb-6">
                    {votes.map((vote) => {
                      const voter = participants.find((p) => p.id === vote.participantId);
                      return (
                        <div
                          key={vote.id}
                          className="bg-primary-100 dark:bg-primary-900 border-2 border-primary-300 dark:border-primary-700 text-primary-800 dark:text-primary-200 font-bold py-4 rounded-lg text-center"
                        >
                          <div className="text-2xl">{vote.value}</div>
                          <div className="text-xs mt-1 truncate">{voter?.name || 'Unknown'}</div>
                        </div>
                      );
                    })}
                  </div>
                  {averageVote !== null && (
                    <div className="bg-gray-100 dark:bg-gray-800 rounded-xl p-4">
                      <p className="font-medium">
                        Average: <span className="font-bold text-xl">{averageVote.toFixed(1)}</span>
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-gray-500 dark:text-gray-400 mb-6">
                    {hasVoted
                      ? 'You have voted. Waiting for others...'
                      : 'Select your estimate below.'}
                    {votes.length > 0 && ` ${votes.length} vote(s) cast.`}
                  </p>
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
                    {deck.values.map((value: number | string) => (
                      <button
                        key={value}
                        onClick={() => handleVote(value)}
                        disabled={hasVoted}
                        className={`bg-primary-100 dark:bg-primary-900 hover:bg-primary-200 dark:hover:bg-primary-800 text-primary-800 dark:text-primary-200 font-bold py-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                          selectedValue === value
                            ? 'ring-4 ring-primary-400 dark:ring-primary-600'
                            : ''
                        }`}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div>
            {/* Participants */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6 mb-6">
              <h2 className="text-xl font-bold mb-4">Participants ({participants.length})</h2>
              <ul className="space-y-3">
                {participants.map((participant) => (
                  <li key={participant.id} className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center text-white font-bold mr-3">
                      {participant.name.charAt(0).toUpperCase()}
                    </div>
                    <span className={participant.id === participantId ? 'font-bold' : ''}>
                      {participant.name}
                      {participant.id === participantId && ' (You)'}
                      {participant.isModerator && ' 👑'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Room Controls */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Room Controls</h2>

              {!isRevealed && (
                <button
                  onClick={handleReveal}
                  disabled={isRevealing || votes.length === 0}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-bold py-3 rounded-lg mb-3 transition-colors"
                >
                  {isRevealing ? 'Revealing...' : 'Reveal Votes'}
                </button>
              )}

              <button
                onClick={handleNewRound}
                className="w-full bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold py-3 rounded-lg transition-colors"
              >
                New Round
              </button>

              {/* Round info */}
              {currentRound && (
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                  <h3 className="font-bold mb-2">Round Info</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Started: {new Date(currentRound.startedAt).toLocaleTimeString()}
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Votes: {votes.length}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
