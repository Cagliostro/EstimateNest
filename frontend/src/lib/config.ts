/// <reference types="vite/client" />

// Frontend configuration from environment variables
// During development, these can be set in .env files
// In production, they are injected at build time

export const config = {
  // REST API base URL (without trailing slash)
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',

  // WebSocket URL for real-time communication
  websocketUrl: import.meta.env.VITE_WEBSOCKET_URL || 'ws://localhost:3001',

  // Frontend domain (for constructing room URLs)
  frontendUrl: import.meta.env.VITE_FRONTEND_URL || 'http://localhost:5173',

  // Environment (development, production)
  env: import.meta.env.MODE || 'development',

  // Feature flags
  features: {
    autoReconnect: true,
    optimisticUpdates: true,
  },
} as const;
