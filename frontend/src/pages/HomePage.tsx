export default function HomePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full text-center">
        <h1 className="text-5xl font-bold text-primary-700 mb-4">
          EstimateNest
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-300 mb-8">
          Real‑time collaborative planning‑poker for agile teams.
          No registration required.
        </p>
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 mb-8">
          <h2 className="text-2xl font-semibold mb-4">Create a room</h2>
          <p className="mb-6 text-gray-500 dark:text-gray-400">
            Start a new estimation session and invite your team with a simple link.
          </p>
          <button
            className="bg-primary-600 hover:bg-primary-700 text-white font-bold py-3 px-8 rounded-lg transition-colors"
            onClick={() => alert('Coming soon!')}
          >
            Create Room
          </button>
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
            Built with React, TypeScript, AWS Lambda, and WebSockets.
            Rooms expire after 14 days.
          </p>
        </footer>
      </div>
    </div>
  );
}