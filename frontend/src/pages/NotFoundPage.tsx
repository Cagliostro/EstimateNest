import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-6xl font-bold text-primary-700 mb-4">404</h1>
        <p className="text-xl text-gray-600 dark:text-gray-300 mb-8">
          Oops! The page you're looking for doesn't exist.
        </p>
        <Link
          to="/"
          className="inline-block bg-primary-600 hover:bg-primary-700 text-white font-bold py-3 px-6 rounded-lg transition-colors"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}