import { describe, it, expect } from 'vitest';
import { landing } from './landing';

describe('landing content', () => {
  it('has a hero title, subtitle, and badge', () => {
    expect(landing.hero.title.length).toBeGreaterThan(0);
    expect(landing.hero.subtitle.length).toBeGreaterThan(10);
    expect(landing.hero.badge.length).toBeGreaterThan(0);
  });

  it('has at least 6 features with title and description', () => {
    expect(landing.features.length).toBeGreaterThanOrEqual(6);
    for (const feature of landing.features) {
      expect(feature.title.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(10);
    }
  });

  it('has at least 4 FAQ entries with question and answer', () => {
    expect(landing.faq.length).toBeGreaterThanOrEqual(4);
    for (const item of landing.faq) {
      expect(item.question.endsWith('?')).toBe(true);
      expect(item.answer.length).toBeGreaterThan(20);
    }
  });

  it('contains SEO keywords in feature copy', () => {
    const allText = landing.features.map((f) => f.title + ' ' + f.description).join(' ');
    expect(allText).toMatch(/free|sign-up|no accounts/i);
  });
});
