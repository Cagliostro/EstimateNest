/// <reference types="vite/client" />

// Frontend configuration from environment variables
// During development, these can be set in .env files
// In production, they are injected at build time

const stripTrailingSlash = (url: string) => url.replace(/\/$/, '');

export const config = {
  // REST API base URL (without trailing slash)
  apiUrl: stripTrailingSlash(import.meta.env.VITE_API_URL || 'http://localhost:3000'),

  // WebSocket URL for real-time communication
  websocketUrl: stripTrailingSlash(import.meta.env.VITE_WEBSOCKET_URL || 'ws://localhost:3001'),

  // Frontend domain (for constructing room URLs)
  frontendUrl: stripTrailingSlash(import.meta.env.VITE_FRONTEND_URL || 'http://localhost:5173'),

  // API Key for REST API (required for rate limiting)
  apiKey: import.meta.env.VITE_API_KEY || '',

  // Environment (development, production)
  env: import.meta.env.MODE || 'development',

  // Feature flags
  features: {
    autoReconnect: true,
    optimisticUpdates: true,
    apiKeyEnabled: import.meta.env.VITE_API_KEY_ENABLED === 'true' || false,
  },
} as const;
