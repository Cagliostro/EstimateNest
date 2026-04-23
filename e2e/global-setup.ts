import type { FullConfig } from '@playwright/test';

async function globalSetup(_config: FullConfig): Promise<void> {
  // Verify dev servers are reachable
  const healthUrl = 'http://localhost:3000/health';
  const frontendUrl = 'http://localhost:5173';

  const maxRetries = 10;
  const retryDelay = 2000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const [healthRes, frontendRes] = await Promise.all([
        fetch(healthUrl),
        fetch(frontendUrl).catch(() => null),
      ]);

      if (healthRes.ok && frontendRes?.ok) {
        const healthData = await healthRes.json();
        console.log(`Health check passed: ${JSON.stringify(healthData)}`);
        console.log(`Frontend server is ready on ${frontendUrl}`);
        return;
      }
    } catch {
      // Servers not ready yet
    }

    if (i < maxRetries - 1) {
      console.log(`Waiting for dev servers... (attempt ${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, retryDelay));
    }
  }

  throw new Error(
    `Dev servers not ready after ${maxRetries} attempts. ` +
      `Make sure backend is running on ${healthUrl} and frontend on ${frontendUrl}`
  );
}

export default globalSetup;
