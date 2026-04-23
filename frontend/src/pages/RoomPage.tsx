import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useRoomStore } from '../store/room-store';
import { useParticipantStore } from '../store/participant-store';
import { useConnectionStore } from '../store/connection-store';
import { useRoomConnection } from '../hooks/use-room-connection';
import { DEFAULT_DECKS } from '@estimatenest/shared';
import { config } from '../lib/config';
import { apiClient } from '../lib/api-client';
import CountdownOverlay from '../components/CountdownOverlay';
import Avatar from '../components/Avatar';

export default function RoomPage() {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();

  // Stores
  const {
    roomId,
    shortCode,
    autoRevealEnabled,
    participants,
    currentRound,
    votes,
    isRevealed,
    roundHistory,
    setRoundHistory,
    setAutoRevealEnabled,
  } = useRoomStore();
  const { participantId, name: participantName, avatarSeed, isModerator } = useParticipantStore();
  useEffect(() => {
    console.log('[RoomPage] participantName changed:', participantName);
  }, [participantName]);
  const { state: connectionState, error, setError } = useConnectionStore();
  const {
    sendVote,
    revealVotes,
    disconnect,
    joinRoom,
    updateParticipant,
    createNewRound,
    updateRound,
  } = useRoomConnection();

  // Local state
  const [selectedValue, setSelectedValue] = useState<number | string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [isEditingRound, setIsEditingRound] = useState(false);
  const [roundTitle, setRoundTitle] = useState('');
  const [roundDescription, setRoundDescription] = useState('');
  const [isUpdatingAutoReveal, setIsUpdatingAutoReveal] = useState(false);

  const hasPassword = useRoomStore((state) => state.hasPassword);

  // Password management state
  const [showPasswordSettings, setShowPasswordSettings] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  // Deck management state
  const [showDeckSettings, setShowDeckSettings] = useState(false);
  const [deckSelectedDeck, setDeckSelectedDeck] = useState('fibonacci');
  const [deckCustomInput, setDeckCustomInput] = useState('');
  const [deckCustomError, setDeckCustomError] = useState('');
  const [isUpdatingDeck, setIsUpdatingDeck] = useState(false);
  const [deckUpdateError, setDeckUpdateError] = useState('');

  // Permission flags
  const allowAllParticipantsToReveal = useRoomStore((state) => state.allowAllParticipantsToReveal);
  const canReveal = isModerator || allowAllParticipantsToReveal;
  const canStartNewRound = isModerator;

  // Room deck (from room settings)
  const deck = useRoomStore((state) => state.deck) || DEFAULT_DECKS[0];

  const copyRoomLink = () => {
    const roomLink = `${config.frontendUrl}/${shortCode || roomCode}`;
    navigator.clipboard.writeText(roomLink).then(() => {
      alert('Room link copied to clipboard!');
    });
  };

  const handleUpdateName = () => {
    console.log('[EstimateNest] handleUpdateName called', { newName, connectionState });
    if (!newName.trim()) return;

    try {
      updateParticipant(newName.trim());
      setIsEditingName(false);
      setNewName('');
    } catch (error) {
      console.error('Failed to update name:', error);
      alert('Failed to update name. Please try again.');
    }
  };

  const handleUpdateRound = () => {
    if (!currentRound) return;
    try {
      updateRound(currentRound.id, roundTitle || undefined, roundDescription || undefined);
      setIsEditingRound(false);
    } catch (error) {
      console.error('Failed to update round:', error);
      alert('Failed to update round. Please try again.');
    }
  };

  // Auto-join when landing on room page with a room code but no connection
  const hasAttemptedAutoJoin = useRef(false);
  useEffect(() => {
    if (
      connectionState === 'disconnected' &&
      !roomId &&
      roomCode &&
      !hasAttemptedAutoJoin.current
    ) {
      console.log('[EstimateNest] Auto-join triggered:', {
        roomCode,
        participantName,
        hasRoomId: !!roomId,
        connectionState,
      });
      hasAttemptedAutoJoin.current = true;
      const name = participantName || 'Anonymous';
      console.log('[EstimateNest] Attempting joinRoom with name:', name);
      joinRoom(roomCode, name).catch((error) => {
        console.error('[EstimateNest] Auto-join failed:', error);
        setError(error instanceof Error ? error.message : 'Failed to join room');
        // Reset the flag after some time to allow retry
        setTimeout(() => {
          hasAttemptedAutoJoin.current = false;
        }, 3000);
      });
    }
  }, [connectionState, roomId, roomCode, joinRoom, participantName, setError]);

  // Fetch round history when room is joined
  useEffect(() => {
    if (roomCode && connectionState === 'connected') {
      apiClient
        .fetchRoundHistory(roomCode)
        .then((history) => setRoundHistory(history))
        .catch((err) => console.error('Failed to fetch round history:', err));
    }
  }, [roomCode, connectionState, setRoundHistory]);

  // Refetch history when a round is revealed
  useEffect(() => {
    if (roomCode && connectionState === 'connected' && currentRound?.isRevealed) {
      apiClient
        .fetchRoundHistory(roomCode)
        .then((history) => setRoundHistory(history))
        .catch((err) => console.error('Failed to fetch round history after reveal:', err));
    }
  }, [roomCode, connectionState, currentRound?.id, currentRound?.isRevealed, setRoundHistory]);

  // Reset selected value when round changes (new round started)
  useEffect(() => {
    setSelectedValue(null);
  }, [currentRound?.id]);

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

  const handleRetryJoin = () => {
    if (!roomCode) return;
    hasAttemptedAutoJoin.current = false;
    const name = participantName || 'Anonymous';
    joinRoom(roomCode, name).catch((error) => {
      console.error('[EstimateNest] Retry join failed:', error);
      setError(error instanceof Error ? error.message : 'Failed to join room');
    });
  };

  const handleNewRound = () => {
    try {
      createNewRound();
    } catch (error) {
      console.error('Failed to create new round:', error);
      alert('Failed to create new round. Please try again.');
    }
  };

  const handleToggleAutoReveal = async () => {
    if (!shortCode || isUpdatingAutoReveal) return;

    setIsUpdatingAutoReveal(true);
    try {
      const newAutoRevealEnabled = !autoRevealEnabled;
      if (!participantId) return;
      await apiClient.updateRoomSettings(shortCode, participantId, {
        autoRevealEnabled: newAutoRevealEnabled,
      });
      setAutoRevealEnabled(newAutoRevealEnabled);
    } catch (error) {
      console.error('Failed to update auto-reveal setting:', error);
      alert('Failed to update auto-reveal setting. Please try again.');
    } finally {
      setIsUpdatingAutoReveal(false);
    }
  };

  const handleDeckChange = async (newDeck: string, customInput?: string) => {
    if (!shortCode || !participantId) return;

    const deckValue = newDeck === 'custom' && customInput ? customInput.trim() : newDeck;
    if (newDeck === 'custom' && (!customInput || !customInput.trim())) return;

    setIsUpdatingDeck(true);
    setDeckUpdateError('');
    try {
      const response = await apiClient.updateRoomSettings(shortCode, participantId, {
        deck: deckValue,
      });
      if (response.room.deck) {
        useRoomStore.getState().setRoomSettings({ deck: response.room.deck });
      }
      setShowDeckSettings(false);
    } catch (error) {
      console.error('Failed to update deck:', error);
      setDeckUpdateError('Failed to update deck');
    } finally {
      setIsUpdatingDeck(false);
    }
  };

  const handleDeactivatePassword = async () => {
    if (!shortCode || !participantId) return;
    setIsUpdatingPassword(true);
    setPasswordError('');
    try {
      await apiClient.updateRoomSettings(shortCode, participantId, {
        moderatorPassword: null,
      });
      useRoomStore.getState().setRoomSettings({ hasPassword: false });
      setShowPasswordSettings(false);
      setNewPassword('');
    } catch (error) {
      console.error('Failed to deactivate password:', error);
      setPasswordError('Failed to deactivate password');
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const handleActivatePassword = async () => {
    if (!shortCode || !participantId || !newPassword.trim()) return;
    setIsUpdatingPassword(true);
    setPasswordError('');
    try {
      await apiClient.updateRoomSettings(shortCode, participantId, {
        moderatorPassword: newPassword.trim(),
      });
      useRoomStore.getState().setRoomSettings({ hasPassword: true });
      setShowPasswordSettings(false);
      setNewPassword('');
    } catch (error) {
      console.error('Failed to activate password:', error);
      setPasswordError('Failed to activate password');
    } finally {
      setIsUpdatingPassword(false);
    }
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
  const roundNumber = roundHistory.length + (currentRound ? 1 : 0);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      {/* Countdown Overlay */}
      <CountdownOverlay />

      {/* Header */}
      <header className="max-w-6xl mx-auto py-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Logo and room info */}
          <div className="flex items-center gap-4">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-primary-600">EstimateNest</h1>
              <span className="ml-3 text-sm text-gray-500 dark:text-gray-400 font-medium">/</span>
              <div className="ml-3">
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
                  Room:{' '}
                  <span className="font-mono bg-gray-200 dark:bg-gray-800 px-3 py-1 rounded">
                    {shortCode || roomCode}
                  </span>
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  {connectionState === 'connected'
                    ? 'Connected'
                    : connectionState === 'connecting'
                      ? 'Connecting...'
                      : connectionState === 'error'
                        ? 'Connection error'
                        : 'Disconnected'}
                  <Avatar
                    seed={avatarSeed || ''}
                    name={participantName || ''}
                    size="md"
                    className="inline-block align-middle mr-2"
                  />
                  {participantName && ` • ${participantName}`}
                </p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={copyRoomLink}
              className="bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 font-medium py-2 px-4 rounded-lg transition-colors flex items-center gap-2"
            >
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
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              Share Link
            </button>
            <button
              onClick={handleLeaveRoom}
              className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg transition-colors"
            >
              Leave Room
            </button>
          </div>
        </div>
      </header>

      {/* Connection error */}
      {error && (
        <div className="max-w-6xl mx-auto mb-6">
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl p-4 text-red-700 dark:text-red-300">
            <p className="font-medium">Error: {error}</p>
            <div className="flex gap-3 mt-3">
              <button
                onClick={handleRetryJoin}
                className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Retry Join
              </button>
              <button
                onClick={() => navigate('/')}
                className="bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Go to Home
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main voting area */}
          <div className="lg:col-span-2 space-y-6">
            {/* Story/Topic Panel */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {isEditingRound && currentRound ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={roundTitle}
                        onChange={(e) => setRoundTitle(e.target.value)}
                        placeholder="Round title"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                        autoFocus
                      />
                      <textarea
                        value={roundDescription}
                        onChange={(e) => setRoundDescription(e.target.value)}
                        placeholder="Round description"
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleUpdateRound}
                          className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setIsEditingRound(false)}
                          className="bg-gray-300 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded text-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-2">
                          {currentRound?.title || 'New Estimation Round'}
                        </h3>
                        {currentRound && isModerator && (
                          <button
                            onClick={() => {
                              setIsEditingRound(true);
                              setRoundTitle(currentRound.title || '');
                              setRoundDescription(currentRound.description || '');
                            }}
                            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                            title="Edit round details"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                      <p className="text-gray-600 dark:text-gray-400">
                        {currentRound?.description ||
                          'Add a description for the item being estimated'}
                      </p>
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Round</div>
                  <div className="text-2xl font-bold text-primary-600">{roundNumber || 1}</div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Status:</span>{' '}
                    <span className="font-medium text-gray-800 dark:text-gray-200">
                      {isRevealed
                        ? 'Revealed'
                        : currentRound
                          ? 'Ready for estimation'
                          : 'No active round'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Priority:</span>{' '}
                    <span className="font-medium text-gray-800 dark:text-gray-200">
                      {currentRound ? 'To be estimated' : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Voting area */}
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
                          className="flex flex-col items-center gap-2 bg-primary-100 dark:bg-primary-900 border-2 border-primary-300 dark:border-primary-700 text-primary-800 dark:text-primary-200 font-bold py-4 rounded-lg text-center"
                        >
                          <div className="text-2xl">{vote.value}</div>
                          {voter && <Avatar seed={voter.avatarSeed} name={voter.name} size="sm" />}
                          <div className="text-xs truncate max-w-full">
                            {voter?.name || 'Unknown'}
                          </div>
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
                    {connectionState !== 'connected'
                      ? 'Connecting...'
                      : hasVoted
                        ? 'You have voted. Waiting for others...'
                        : 'Select your estimate below.'}
                    {votes.length > 0 && ` ${votes.length} vote(s) cast.`}
                  </p>
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-4">
                    {deck.values.map((value: number | string) => (
                      <button
                        key={value}
                        data-value={value}
                        onClick={() => handleVote(value)}
                        disabled={hasVoted || connectionState !== 'connected'}
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
                {participants.map((participant) => {
                  const hasVotedForParticipant = votes.some(
                    (v) => v.participantId === participant.id
                  );
                  return (
                    <li key={participant.id} className="flex items-center">
                      <div className="relative mr-3">
                        <Avatar seed={participant.avatarSeed} name={participant.name} size="sm" />
                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-800"></div>
                      </div>
                      <div className="flex-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {isEditingName && participant.id === participantId ? (
                            <>
                              <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className="px-2 py-1 border border-gray-300 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
                                autoFocus
                              />
                              <button
                                onClick={handleUpdateName}
                                className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setIsEditingName(false)}
                                className="bg-gray-300 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 px-3 py-1 rounded text-sm"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <span className={participant.id === participantId ? 'font-bold' : ''}>
                              {participant.name}
                              {participant.id === participantId && ' (You)'}
                              {participant.isModerator && ' 👑'}
                            </span>
                          )}
                          {participant.id === participantId && !isEditingName && (
                            <button
                              onClick={() => {
                                setIsEditingName(true);
                                setNewName(participant.name);
                              }}
                              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                              title="Edit name"
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                xmlns="http://www.w3.org/2000/svg"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                />
                              </svg>
                            </button>
                          )}
                        </div>
                        {/* Vote status indicator */}
                        {!isRevealed && (
                          <div
                            className={`w-3 h-3 rounded-full ${hasVotedForParticipant ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                            title={hasVotedForParticipant ? 'Voted' : 'Not voted'}
                          ></div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Room Controls */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Room Controls</h2>

              {canReveal && !isRevealed && (
                <button
                  onClick={handleReveal}
                  disabled={isRevealing || votes.length === 0 || connectionState !== 'connected'}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-400 text-white font-bold py-3 rounded-lg mb-3 transition-colors"
                >
                  {isRevealing ? 'Revealing...' : 'Reveal Votes'}
                </button>
              )}

              {canStartNewRound && (
                <button
                  onClick={handleNewRound}
                  className="w-full bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold py-3 rounded-lg transition-colors"
                >
                  New Round
                </button>
              )}

              {/* Auto-reveal toggle (moderator only) */}
              {isModerator && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Auto-reveal when everyone votes
                    </span>
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={autoRevealEnabled}
                        onChange={handleToggleAutoReveal}
                        disabled={isUpdatingAutoReveal}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600 disabled:opacity-50"></div>
                    </div>
                  </label>
                </div>
              )}

              {/* Password management (moderator only) */}
              {isModerator && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => {
                      setShowPasswordSettings(!showPasswordSettings);
                      setPasswordError('');
                      setNewPassword('');
                    }}
                    className="flex items-center justify-between w-full text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    <span className="flex items-center gap-2">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                        />
                      </svg>
                      Room password: {hasPassword ? '●●●●●●●●' : 'Not set'}
                    </span>
                    <svg
                      className={`w-4 h-4 transition-transform ${showPasswordSettings ? 'rotate-180' : ''}`}
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
                  {showPasswordSettings && (
                    <div className="mt-3 space-y-2">
                      {passwordError && <p className="text-red-500 text-xs">{passwordError}</p>}
                      {hasPassword ? (
                        <button
                          onClick={handleDeactivatePassword}
                          disabled={isUpdatingPassword}
                          className="w-full bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-300 font-medium py-2 px-4 rounded-lg text-sm transition-colors disabled:opacity-50"
                        >
                          {isUpdatingPassword ? 'Deactivating...' : 'Deactivate password'}
                        </button>
                      ) : (
                        <div className="space-y-2">
                          <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="New room password"
                            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          />
                          <button
                            onClick={handleActivatePassword}
                            disabled={isUpdatingPassword || !newPassword.trim()}
                            className="w-full bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                          >
                            {isUpdatingPassword ? 'Activating...' : 'Activate password'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Deck management (moderator only) */}
              {isModerator && (
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => {
                      setShowDeckSettings(!showDeckSettings);
                      setDeckUpdateError('');
                      // Initialize radio to current deck
                      if (!showDeckSettings && deck) {
                        if (deck.id === 'custom') {
                          setDeckSelectedDeck('custom');
                          setDeckCustomInput(deck.values.join(', '));
                        } else {
                          setDeckSelectedDeck(deck.id);
                          setDeckCustomInput('');
                        }
                      }
                      setDeckCustomError('');
                    }}
                    className="flex items-center justify-between w-full text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    <span className="flex items-center gap-2">
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                      Card deck: {deck?.name || 'Fibonacci'}
                    </span>
                    <svg
                      className={`w-4 h-4 transition-transform ${showDeckSettings ? 'rotate-180' : ''}`}
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
                  {showDeckSettings && (
                    <div className="mt-3 space-y-2">
                      {deckUpdateError && <p className="text-red-500 text-xs">{deckUpdateError}</p>}
                      <div className="space-y-1">
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
                              name="deckSettings"
                              value={option.id}
                              checked={deckSelectedDeck === option.id}
                              onChange={() => {
                                setDeckSelectedDeck(option.id);
                                setDeckCustomError('');
                              }}
                              className="text-primary-600 focus:ring-primary-500"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-300">
                              {option.label}
                            </span>
                          </label>
                        ))}
                      </div>

                      {deckSelectedDeck === 'custom' && (
                        <div>
                          <input
                            type="text"
                            value={deckCustomInput}
                            onChange={(e) => {
                              setDeckCustomInput(e.target.value);
                              const values = e.target.value
                                .split(',')
                                .map((v) => v.trim())
                                .filter((v) => v.length > 0);
                              if (values.length > 0 && (values.length < 2 || values.length > 15)) {
                                setDeckCustomError(
                                  `Custom deck must have between 2 and 15 values, got ${values.length}`
                                );
                              } else {
                                setDeckCustomError('');
                              }
                            }}
                            placeholder="e.g., 1, 2, 3, 5, 8"
                            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                          />
                          {deckCustomError && (
                            <p className="text-xs text-red-500 mt-1">{deckCustomError}</p>
                          )}
                        </div>
                      )}

                      <button
                        onClick={() =>
                          handleDeckChange(
                            deckSelectedDeck,
                            deckSelectedDeck === 'custom' ? deckCustomInput : undefined
                          )
                        }
                        disabled={
                          isUpdatingDeck ||
                          (deckSelectedDeck === 'custom' &&
                            (!deckCustomInput.trim() || !!deckCustomError))
                        }
                        className="w-full bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white font-medium py-2 px-4 rounded-lg text-sm transition-colors"
                      >
                        {isUpdatingDeck ? 'Applying...' : 'Apply Deck'}
                      </button>
                    </div>
                  )}
                </div>
              )}

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

            {/* Round History */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6 mt-6">
              <h2 className="text-xl font-bold mb-4">Round History</h2>
              {roundHistory.length === 0 ? (
                <p className="text-gray-500 dark:text-gray-400 py-4 text-center">
                  No round history yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {roundHistory.map((round, index) => (
                    <div
                      key={round.id}
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                    >
                      <div>
                        <div className="font-medium">Round {index + 1}</div>
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {round.revealedAt
                            ? new Date(round.revealedAt).toLocaleDateString()
                            : 'Not revealed'}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-primary-600">
                          {round.average?.toFixed(1) ?? '-'}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {round.voteCount} vote{round.voteCount !== 1 ? 's' : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button className="w-full mt-4 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 font-medium py-2 rounded-lg transition-colors">
                View all history →
              </button>
            </div>
          </div>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto mt-8 pt-4 border-t border-gray-200 dark:border-gray-800 text-center text-gray-400 text-sm">
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
  );
}
