import { useParams } from 'react-router-dom';

export default function RoomPage() {
  const { roomCode } = useParams();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <header className="max-w-6xl mx-auto py-4">
        <h1 className="text-2xl font-bold text-primary-700">
          Room: <span className="font-mono bg-gray-200 dark:bg-gray-800 px-3 py-1 rounded">{roomCode}</span>
        </h1>
      </header>
      <main className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Current Round</h2>
              <p className="text-gray-500 dark:text-gray-400">
                Voting in progress. Select your estimate below.
              </p>
              <div className="mt-8 grid grid-cols-4 md:grid-cols-6 gap-4">
                {[0, 1, 2, 3, 5, 8, 13, 20, 40, 100, '?', '☕'].map((value) => (
                  <button
                    key={value}
                    className="bg-primary-100 dark:bg-primary-900 hover:bg-primary-200 dark:hover:bg-primary-800 text-primary-800 dark:text-primary-200 font-bold py-4 rounded-lg transition-colors"
                    onClick={() => alert(`Voted ${value}`)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6 mb-6">
              <h2 className="text-xl font-bold mb-4">Participants</h2>
              <ul className="space-y-3">
                {['Alex', 'Sam', 'Taylor', 'Jordan'].map((name) => (
                  <li key={name} className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center text-white font-bold mr-3">
                      {name.charAt(0)}
                    </div>
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Room Controls</h2>
              <button className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg mb-3">
                Reveal Votes
              </button>
              <button className="w-full bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold py-3 rounded-lg">
                New Round
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}