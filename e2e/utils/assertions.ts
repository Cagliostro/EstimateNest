import { expect } from '@playwright/test';

export async function expectVisible(
  page: import('@playwright/test').Page,
  selector: string,
  description: string
): Promise<void> {
  await expect(
    page.locator(selector),
    `Expected "${description}" (${selector}) to be visible`
  ).toBeVisible();
}

export async function expectText(
  page: import('@playwright/test').Page,
  selector: string,
  text: string | RegExp,
  description: string
): Promise<void> {
  await expect(
    page.locator(selector),
    `Expected "${description}" (${selector}) to contain text "${text}"`
  ).toContainText(text);
}

export async function expectCount(
  page: import('@playwright/test').Page,
  selector: string,
  expected: number,
  description: string
): Promise<void> {
  await expect(
    page.locator(selector),
    `Expected ${expected} "${description}" (${selector}), but count differs`
  ).toHaveCount(expected);
}

export async function expectUrl(
  page: import('@playwright/test').Page,
  pattern: RegExp,
  description: string
): Promise<void> {
  await expect(page, `Expected URL to match "${pattern}" for "${description}"`).toHaveURL(pattern);
}
