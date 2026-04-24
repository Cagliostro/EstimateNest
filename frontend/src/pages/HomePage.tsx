import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useRoomConnection } from '../hooks/use-room-connection';
import { useConnectionStore } from '../store/connection-store';
import { ApiError } from '../lib/api-client';

export default function HomePage() {
  const navigate = useNavigate();
  const { createRoom, joinRoom } = useRoomConnection();
  const { state: connectionState, error } = useConnectionStore();

  const [roomCode, setRoomCode] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [createdRoom, setCreatedRoom] = useState<{
    shortCode: string;
    joinUrl: string;
    participantId?: string;
  } | null>(null);

  // Password state
  const [moderatorPassword, setModeratorPassword] = useState('');
  const [showRoomSettings, setShowRoomSettings] = useState(false);

  // Deck state
  const [selectedDeck, setSelectedDeck] = useState('fibonacci');
  const [customDeckInput, setCustomDeckInput] = useState('');
  const [customDeckError, setCustomDeckError] = useState('');

  // Join password dialog state
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [joinPassword, setJoinPassword] = useState('');
  const [joinPasswordError, setJoinPasswordError] = useState('');
  const [pendingJoinCode, setPendingJoinCode] = useState('');
  const [pendingJoinName, setPendingJoinName] = useState('');

  const handleCreateRoom = async () => {
    setIsCreating(true);
    try {
      const deckValue = selectedDeck === 'custom' ? customDeckInput.trim() : selectedDeck;

      const result = await createRoom({
        deck: deckValue,
        moderatorPassword: moderatorPassword.trim() || undefined,
        name: participantName.trim() || undefined,
      });
      setCreatedRoom(result);

      const name = participantName.trim() || 'Anonymous';
      try {
        await joinRoom(result.shortCode, name, undefined, result.participantId);
        navigate(`/${result.shortCode}`);
      } catch (joinError) {
        console.error('Failed to join room after creation:', joinError);
      }
    } catch (error) {
      console.error('Failed to create room:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleEnterCreatedRoom = async () => {
    if (!createdRoom) return;

    const name = participantName.trim() || 'Anonymous';
    try {
      await joinRoom(createdRoom.shortCode, name, undefined, createdRoom.participantId);
      navigate(`/${createdRoom.shortCode}`);
    } catch (error) {
      console.error('Failed to join created room:', error);
      alert('Failed to join room. Please try again.');
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
      navigate(`/${roomCode.trim().toUpperCase()}`);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.details as { code?: string })?.code === 'PASSWORD_REQUIRED'
      ) {
        setPendingJoinCode(roomCode.trim().toUpperCase());
        setPendingJoinName(name);
        setJoinPassword('');
        setJoinPasswordError('');
        setShowPasswordDialog(true);
      } else {
        console.error('Failed to join room:', error);
      }
    } finally {
      setIsJoining(false);
    }
  };

  const handleJoinWithPassword = async () => {
    if (!joinPassword.trim()) {
      setJoinPasswordError('Password is required');
      return;
    }

    setIsJoining(true);
    try {
      await joinRoom(pendingJoinCode, pendingJoinName, joinPassword);
      setShowPasswordDialog(false);
      navigate(`/${pendingJoinCode}`);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.details as { code?: string })?.code === 'INCORRECT_PASSWORD'
      ) {
        setJoinPasswordError('Incorrect password');
      } else {
        setJoinPasswordError(error instanceof Error ? error.message : 'Failed to join room');
      }
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
              onClick={handleEnterCreatedRoom}
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
            <div className="mb-6">
              <label htmlFor="creatorName" className="block text-left mb-2 font-medium">
                Your Name (optional)
              </label>
              <input
                id="creatorName"
                type="text"
                value={participantName}
                onChange={(e) => setParticipantName(e.target.value)}
                placeholder="Anonymous"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>

            {/* Room Settings */}
            <div className="mb-6 border border-gray-200 dark:border-gray-700 rounded-lg">
              <button
                type="button"
                onClick={() => setShowRoomSettings(!showRoomSettings)}
                className="w-full flex items-center justify-between px-4 py-3 text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-750 rounded-lg transition-colors"
              >
                <span className="flex items-center gap-2 font-medium">
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  Room Settings
                </span>
                <svg
                  className={`w-5 h-5 transition-transform ${showRoomSettings ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {showRoomSettings && (
                <div className="px-4 pb-4 space-y-4">
                  <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                    <label
                      htmlFor="moderatorPassword"
                      className="block text-left mb-2 text-sm font-medium text-gray-600 dark:text-gray-400"
                    >
                      Room password (optional)
                    </label>
                    <input
                      id="moderatorPassword"
                      type="password"
                      value={moderatorPassword}
                      onChange={(e) => setModeratorPassword(e.target.value)}
                      placeholder="Require a password for others to join this room"
                      className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm"
                      title="Anyone with the password can join. The room creator automatically becomes the moderator."
                    />
                    <p className="text-left text-xs text-gray-400 dark:text-gray-500 mt-1">
                      Anyone with the password can join. The room creator automatically becomes the
                      moderator.
                    </p>
                  </div>

                  <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                    <span className="block text-left mb-3 text-sm font-medium text-gray-600 dark:text-gray-400">
                      Card deck
                    </span>
                    <div className="space-y-2">
                      {[
                        { id: 'fibonacci', label: 'Fibonacci' },
                        { id: 'tshirt', label: 'T‑Shirt Sizes' },
                        { id: 'powersOfTwo', label: 'Powers of Two' },
                        { id: 'custom', label: 'Custom' },
                      ].map((option) => (
                        <label
                          key={option.id}
                          className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                        >
                          <input
                            type="radio"
                            name="deck"
                            value={option.id}
                            checked={selectedDeck === option.id}
                            onChange={() => {
                              setSelectedDeck(option.id);
                              setCustomDeckError('');
                            }}
                            className="text-primary-600 focus:ring-primary-500"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300">
                            {option.label}
                          </span>
                        </label>
                      ))}
                    </div>

                    {selectedDeck === 'custom' && (
                      <div className="mt-3">
                        <input
                          type="text"
                          value={customDeckInput}
                          onChange={(e) => {
                            setCustomDeckInput(e.target.value);
                            const values = e.target.value
                              .split(',')
                              .map((v) => v.trim())
                              .filter((v) => v.length > 0);
                            if (values.length > 0 && (values.length < 2 || values.length > 15)) {
                              setCustomDeckError(
                                `Custom deck must have between 2 and 15 values, got ${values.length}`
                              );
                            } else {
                              setCustomDeckError('');
                            }
                          }}
                          placeholder="e.g., 1, 2, 3, 5, 8"
                          className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent text-sm"
                        />
                        {customDeckError && (
                          <p className="text-left text-xs text-red-500 mt-1">{customDeckError}</p>
                        )}
                        <p className="text-left text-xs text-gray-400 dark:text-gray-500 mt-1">
                          Comma-separated values, 2 to 15 items.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

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

        {/* Password join dialog */}
        {showPasswordDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 max-w-md w-full mx-4">
              <h2 className="text-xl font-semibold mb-2">This room requires a password</h2>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                Enter the password to join room{' '}
                <span className="font-mono font-bold">{pendingJoinCode}</span>
              </p>
              {joinPasswordError && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl p-3 mb-4 text-red-700 dark:text-red-300 text-sm">
                  {joinPasswordError}
                </div>
              )}
              <input
                type="password"
                value={joinPassword}
                onChange={(e) => {
                  setJoinPassword(e.target.value);
                  setJoinPasswordError('');
                }}
                placeholder="Room password"
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent mb-4"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleJoinWithPassword();
                  }
                }}
              />
              <div className="flex gap-3">
                <button
                  onClick={handleJoinWithPassword}
                  disabled={isJoining}
                  className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-bold py-3 rounded-lg transition-colors"
                >
                  {isJoining ? 'Joining...' : 'Join'}
                </button>
                <button
                  onClick={() => {
                    setShowPasswordDialog(false);
                    setJoinPassword('');
                    setJoinPasswordError('');
                  }}
                  className="flex-1 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold py-3 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

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
          <p className="mb-2">
            Built with React, TypeScript, AWS Lambda, and WebSockets. Rooms expire after 14 days.
          </p>
          <p>
            <Link
              to="/legal"
              className="text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-300 underline transition-colors"
            >
              Impressum & Datenschutz
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
