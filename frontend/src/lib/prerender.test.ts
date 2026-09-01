import { describe, it, expect } from 'vitest';
import { renderHomeHtml } from '../../../scripts/prerender-home.mts';
import { landing } from '../content/landing';

describe('renderHomeHtml', () => {
  const html = renderHomeHtml(landing);

  it('renders hero title, subtitle, and badge', () => {
    expect(html).toContain(landing.hero.title);
    expect(html).toContain(landing.hero.subtitle);
    expect(html).toContain(landing.hero.badge);
  });

  it('renders all feature titles and descriptions', () => {
    for (const feature of landing.features) {
      expect(html).toContain(feature.title);
      expect(html).toContain(feature.description);
    }
  });

  it('renders all FAQ questions and answers', () => {
    expect(html).toContain('Frequently asked questions');
    for (const item of landing.faq) {
      expect(html).toContain(item.question);
      expect(html).toContain(item.answer);
    }
  });

  it('uses the same Tailwind structure as the React HomePage', () => {
    expect(html).toContain('min-h-screen flex flex-col items-center justify-center p-6');
    expect(html).toContain('text-5xl font-bold text-primary-600 mb-4');
    expect(html).toContain('grid md:grid-cols-3 gap-6 text-left');
  });

  it('escapes HTML in content', () => {
    const result = renderHomeHtml({
      hero: { title: '<script>', subtitle: 'a & b' },
      features: [],
      faq: [],
    });
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('a &amp; b');
  });
});
