import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { landing } from '../frontend/src/content/landing';

export interface LandingContent {
  hero: { title: string; subtitle: string; badge?: string };
  features: ReadonlyArray<{ title: string; description: string }>;
  faq: ReadonlyArray<{ question: string; answer: string }>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHomeHtml(content: LandingContent): string {
  const features = content.features
    .map(
      (feature) => `<div class="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
            <h3 class="font-bold text-lg mb-2">${escapeHtml(feature.title)}</h3>
            <p class="text-gray-500 dark:text-gray-400">${escapeHtml(feature.description)}</p>
          </div>`
    )
    .join('');

  const faq = content.faq
    .map(
      (item) => `<div class="bg-white dark:bg-gray-800 p-6 rounded-xl shadow">
            <h3 class="font-bold mb-2">${escapeHtml(item.question)}</h3>
            <p class="text-gray-500 dark:text-gray-400">${escapeHtml(item.answer)}</p>
          </div>`
    )
    .join('');

  const badge = content.hero.badge
    ? `<span class="inline-block bg-primary-50 dark:bg-primary-900/30 border border-primary-200 dark:border-primary-800 text-primary-700 dark:text-primary-300 text-sm font-medium px-3 py-1 rounded-full mb-4">${escapeHtml(content.hero.badge)}</span>`
    : '';

  return `<div class="min-h-screen flex flex-col items-center justify-center p-6">
      <div class="max-w-2xl w-full text-center">
        ${badge}
        <h1 class="text-5xl font-bold text-primary-600 mb-4">${escapeHtml(content.hero.title)}</h1>
        <p class="text-xl text-gray-600 dark:text-gray-300 mb-8">${escapeHtml(content.hero.subtitle)}</p>
        <div class="grid md:grid-cols-3 gap-6 text-left">
          ${features}
        </div>
        <section class="mt-12 text-left">
          <h2 class="text-3xl font-bold text-gray-800 dark:text-gray-100 mb-6">Frequently asked questions</h2>
          <div class="space-y-4">
            ${faq}
          </div>
        </section>
      </div>
    </div>`;
}

function findDistIndexHtml(): string {
  const fromCwd = 'dist/index.html';
  if (existsSync(fromCwd)) return fromCwd;
  const fromScript = fileURLToPath(new URL('../frontend/dist/index.html', import.meta.url));
  if (existsSync(fromScript)) return fromScript;
  throw new Error('dist/index.html not found. Run `vite build` first.');
}

function main(): void {
  const file = findDistIndexHtml();
  const html = readFileSync(file, 'utf8');

  // Anchor on the empty root div exactly: `vite build` leaves it untouched,
  // and an exact match cannot swallow anything after it (e.g. inline scripts).
  // If the template ever renders non-empty content into #root, this fails
  // loudly instead of silently deleting it.
  const rootPattern = /<div id="root"><\/div>/;
  if (!rootPattern.test(html)) {
    throw new Error('Could not find an empty <div id="root"></div> in dist/index.html');
  }

  const prerendered = html.replace(rootPattern, `<div id="root">${renderHomeHtml(landing)}</div>`);
  writeFileSync(file, prerendered);
  console.log(`prerender-home: injected static landing content into ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`prerender-home: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
