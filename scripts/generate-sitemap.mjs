import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

function findDistDir() {
  if (existsSync('dist')) return 'dist';
  if (existsSync('frontend/dist')) return 'frontend/dist';
  throw new Error('dist directory not found. Run `vite build` first.');
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const baseUrl = (process.env.VITE_FRONTEND_URL || 'https://estimatenest.net').replace(/\/$/, '');

const urls = ['/', '/legal'].map(
  (path) => `  <url>\n    <loc>${escapeXml(baseUrl)}${path}</loc>\n  </url>`
);

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;

const distDir = findDistDir();
writeFileSync(`${distDir}/sitemap.xml`, sitemap);
console.log(`generate-sitemap: wrote ${distDir}/sitemap.xml (${baseUrl})`);
