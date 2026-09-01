import { test, expect } from '@playwright/test';

// These tests inspect the raw HTML served by `vite preview` (a production
// build) without executing JavaScript — exactly what search engines receive.

test.describe('SEO — static HTML', () => {
  test('home page ships prerendered content and meta tags', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const html = await res.text();

    // Static landing content (prerendered, no JS required)
    expect(html).toContain('EstimateNest');
    expect(html).toContain('Real-time collaborative planning-poker for agile teams');
    expect(html).toContain('Frequently asked questions');

    // Robots meta is env-replaced (no leftover %VITE_% literals)
    expect(html).not.toContain('%VITE_');
    expect(html).toMatch(/<meta name="robots" content="[^"]+"/);

    // Open Graph + Twitter cards (URLs must be absolute — the base differs
    // between local builds (.env.production default) and CI deploys)
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:image"');
    // No og:url — scrapers must fall back to the requested URL so shared
    // room links (/ABC123) resolve to the room, not the homepage
    expect(html).not.toContain('property="og:url"');
    expect(html).toMatch(
      /<meta property="og:image" content="https?:\/\/[^"]+\/og-image\.png"/
    );
    expect(html).toContain('name="twitter:card" content="summary_large_image"');

    // Canonical must be an absolute URL pointing at the root
    expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+\/" \/>/);

    // JSON-LD: valid JSON, SoftwareApplication present, no invented ratings
    const match = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    );
    expect(match).not.toBeNull();
    const ld = JSON.parse(match![1]);
    const types = ld['@graph'].map((entry: { '@type': string }) => entry['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('SoftwareApplication');
    expect(JSON.stringify(ld)).not.toContain('aggregateRating');

    // Prerendered content lives inside the #root div
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain('<div id="root"></div>');
  });

  test('robots.txt exists and references the sitemap', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Sitemap:');
    expect(body).not.toContain('<div id="root">');
  });

  test('sitemap.xml lists index and legal', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/<loc>https?:\/\/[^<]+\/<\/loc>/);
    expect(body).toMatch(/<loc>https?:\/\/[^<]+\/legal<\/loc>/);
    expect(body).not.toContain('<lastmod>');
  });

  test('favicon is served', async ({ request }) => {
    const res = await request.get('/favicon.svg');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<svg');
  });
});
