import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRoomConnection } from '../hooks/use-room-connection';
import { useConnectionStore } from '../store/connection-store';

export default function HomePage() {
  const navigate = useNavigate();
  const { createRoom, joinRoom } = useRoomConnection();
  const { state: connectionState, error } = useConnectionStore();

  const [roomCode, setRoomCode] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [createdRoom, setCreatedRoom] = useState<{ shortCode: string; joinUrl: string } | null>(
    null
  );

  const handleCreateRoom = async () => {
    setIsCreating(true);
    try {
      const result = await createRoom();
      setCreatedRoom(result);
      // Navigate to room page
      navigate(`/${result.shortCode}`);
    } catch (error) {
      console.error('Failed to create room:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinRoom = async () => {
    if (!roomCode.trim()) {
      alert('Please enter a room code');
      return;
    }

    const name = participantName.trim() || 'Anonymous';
    setIsJoining(true);
    try {
      await joinRoom(roomCode.trim().toUpperCase(), name);
      // Navigate to room page
      navigate(`/${roomCode.trim().toUpperCase()}`);
    } catch (error) {
      console.error('Failed to join room:', error);
    } finally {
      setIsJoining(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      alert('Copied to clipboard!');
    });
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full text-center">
        <h1 className="text-5xl font-bold text-primary-600 mb-4">EstimateNest</h1>
        <p className="text-xl text-gray-600 dark:text-gray-300 mb-8">
          Real‑time collaborative planning‑poker for agile teams. No registration required.
        </p>

        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl p-4 mb-6 text-red-700 dark:text-red-300">
            <p className="font-medium">Error: {error}</p>
          </div>
        )}

        {connectionState === 'connecting' && (
          <div className="bg-primary-50 dark:bg-primary-900/30 border border-primary-200 dark:border-primary-800 rounded-xl p-4 mb-6">
            <p className="text-primary-700 dark:text-primary-300">Connecting...</p>
          </div>
        )}

        {createdRoom ? (
          <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-2xl p-8 mb-8">
            <h2 className="text-2xl font-semibold mb-4 text-green-800 dark:text-green-300">
              Room Created!
            </h2>
            <p className="mb-4 text-green-700 dark:text-green-400">
              Share this link with your team:
            </p>
            <div className="flex items-center justify-center mb-6">
              <code className="bg-white dark:bg-gray-800 px-4 py-3 rounded-lg text-lg font-mono border border-green-200 dark:border-green-800 flex-1 truncate">
                {createdRoom.joinUrl}
              </code>
              <button
                onClick={() => copyToClipboard(createdRoom.joinUrl)}
                className="ml-3 bg-primary-600 hover:bg-primary-700 text-white font-bold py-3 px-6 rounded-lg transition-colors"
              >
                Copy
              </button>
            </div>
            <button
              onClick={() => navigate(`/${createdRoom.shortCode}`)}
              className="bg-primary-600 hover:bg-primary-700 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            >
              Enter Room
            </button>
          </div>
        ) : (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 mb-8">
            <h2 className="text-2xl font-semibold mb-6">Create a room</h2>
            <p className="mb-6 text-gray-500 dark:text-gray-400">
              Start a new estimation session and invite your team with a simple link.
            </p>
            <button
              onClick={handleCreateRoom}
              disabled={isCreating}
              className="bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            >
              {isCreating ? 'Creating...' : 'Create Room'}
            </button>
          </div>
        )}

        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 mb-8">
          <h2 className="text-2xl font-semibold mb-6">Join a room</h2>
          <div className="space-y-4">
            <div>
              <label htmlFor="roomCode" className="block text-left mb-2 font-medium">
                Room Code
              </label>
              <input
                id="roomCode"
                type="text"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
            <div>
              <label htmlFor="participantName" className="block text-left mb-2 font-medium">
                Your Name (optional)
              </label>
              <input
                id="participantName"
                type="text"
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                placeholder="Anonymous"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={handleJoinRoom}
              disabled={isJoining || !roomCode.trim()}
              className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            >
              {isJoining ? 'Joining...' : 'Join Room'}
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6 text-left">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
            <h3 className="font-bold text-lg mb-2">Zero sign‑up</h3>
            <p className="text-gray-500 dark:text-gray-400">
              Create a room and share the link. No accounts, no passwords.
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
            <h3 className="font-bold text-lg mb-2">Real‑time voting</h3>
            <p className="text-gray-500 dark:text-gray-400">
              See votes appear live. Reveal when ready, or auto‑reveal when everyone has voted.
            </p>
          </div>
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
            <h3 className="font-bold text-lg mb-2">Flexible decks</h3>
            <p className="text-gray-500 dark:text-gray-400">
              Fibonacci, T‑shirt sizes, powers‑of‑two, or bring your own custom scale.
            </p>
          </div>
        </div>

        <footer className="mt-12 text-gray-400 text-sm">
          <p>
            Built with React, TypeScript, AWS Lambda, and WebSockets. Rooms expire after 14 days.
          </p>
        </footer>
      </div>
    </div>
  );
}
