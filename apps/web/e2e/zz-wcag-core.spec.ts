import { expect, test, type Page } from '@playwright/test';
import { db } from '../src/lib/db';

const adminEmail = 'admin@example.test';
const adminPassword = 'Correct-Horse-Battery-42';

async function signInIfNeeded(page: Page) {
  await page.goto('/');
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByLabel('Clubname', { exact: true }).fill('WCAG Test Club');
    await page.getByLabel('Slug', { exact: true }).fill('wcag-test');
    await page.getByLabel('Name', { exact: true }).fill('Club Admin');
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Installation abschließen' }).click();
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/sign-in');
  }
  if (new URL(page.url()).pathname === '/sign-in') {
    await page.getByLabel('E-Mail', { exact: true }).fill(adminEmail);
    await page.getByLabel('Passwort', { exact: true }).fill(adminPassword);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await page.waitForURL((url) => url.pathname === '/');
  }
}

async function auditAccessibleNames(page: Page) {
  const failures = await page.locator('button, a[href], input:not([type="hidden"]), select, textarea').evaluateAll((nodes) => {
    function referencedText(element: Element, idref: string | null) {
      if (!idref) return '';
      return idref.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim();
    }
    function labelText(element: Element) {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return '';
      const explicit = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() ?? '' : '';
      const wrapped = element.closest('label')?.textContent?.trim() ?? '';
      return explicit || wrapped;
    }
    return nodes.filter((node) => {
      const element = node as HTMLElement;
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const input = element as HTMLInputElement;
      const name = [
        element.getAttribute('aria-label')?.trim() ?? '',
        referencedText(element, element.getAttribute('aria-labelledby')),
        labelText(element),
        element.getAttribute('alt')?.trim() ?? '',
        input.type === 'submit' || input.type === 'button' ? input.value?.trim() ?? '' : '',
        element.textContent?.trim() ?? '',
        element.getAttribute('title')?.trim() ?? '',
      ].find(Boolean);
      return !name;
    }).map((node) => `${node.tagName.toLowerCase()}#${(node as HTMLElement).id || '-'}[name=${node.getAttribute('name') ?? '-'}]`);
  });
  expect(failures, `Interactive elements without accessible name on ${page.url()}`).toEqual([]);
}

async function auditStructure(page: Page) {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const levels = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  for (let index = 1; index < levels.length; index += 1) {
    expect(levels[index] - levels[index - 1], `Heading level skip on ${page.url()}`).toBeLessThanOrEqual(1);
  }
}

async function auditStaticSemantics(page: Page) {
  const failures = await page.evaluate(() => {
    const findings: string[] = [];
    const ids = new Map<string, number>();
    document.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
      if (!element.id) return;
      ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
    });
    ids.forEach((count, id) => {
      if (count > 1) findings.push(`duplicate-id:${id}:${count}`);
    });

    document.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => {
      const value = Number(element.getAttribute('tabindex'));
      if (Number.isFinite(value) && value > 0) findings.push(`positive-tabindex:${element.tagName.toLowerCase()}#${element.id || '-'}`);
    });

    document.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
      if (!image.hasAttribute('alt')) findings.push(`img-without-alt:${image.src || image.id || '-'}`);
    });

    return findings;
  });
  expect(failures, `Static semantic WCAG violations on ${page.url()}`).toEqual([]);
}

async function auditTextContrast(page: Page) {
  const failures = await page.evaluate(() => {
    type Rgb = [number, number, number];
    const parseRgb = (value: string): Rgb | null => {
      const match = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i);
      if (!match) return null;
      if (match[4] !== undefined && Number(match[4]) < 0.999) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = ([r, g, b]: Rgb) => {
      const linear = [r, g, b].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const contrast = (a: Rgb, b: Rgb) => {
      const first = luminance(a);
      const second = luminance(b);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const effectiveBackground = (element: HTMLElement): Rgb | null => {
      let current: HTMLElement | null = element;
      while (current) {
        const background = parseRgb(getComputedStyle(current).backgroundColor);
        if (background) return background;
        current = current.parentElement;
      }
      return parseRgb(getComputedStyle(document.documentElement).backgroundColor) ?? [255, 255, 255];
    };

    const candidates = new Set<HTMLElement>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.textContent?.trim()) continue;
      const parent = node.parentElement;
      if (parent) candidates.add(parent);
    }

    const findings: string[] = [];
    candidates.forEach((element) => {
      if (element.closest('[aria-hidden="true"]')) return;
      // Native option popups are rendered by the browser/OS. Chromium exposes
      // computed option colors without a reliable representation of the painted
      // popup background, so pairing them here creates false contrast findings.
      // The closed select control remains part of this audit.
      if (element instanceof HTMLOptionElement) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.999) return;
      const foreground = parseRgb(style.color);
      const background = effectiveBackground(element);
      if (!foreground || !background) return;
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const minimum = largeText ? 3 : 4.5;
      const ratio = contrast(foreground, background);
      if (ratio + 0.01 < minimum) {
        const text = element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ?? '';
        findings.push(`${element.tagName.toLowerCase()}#${element.id || '-'}:${ratio.toFixed(2)}<${minimum}:${text}`);
      }
    });
    return findings;
  });
  expect(failures, `Text contrast below WCAG AA threshold on ${page.url()}`).toEqual([]);
}

async function auditKeyboardAndFocus(page: Page) {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen = new Set<string>();
  let visibleFocusCount = 0;
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press('Tab');
    const snapshot = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        key: `${element.tagName}:${element.id}:${element.getAttribute('name') ?? ''}:${element.textContent?.trim().slice(0, 40) ?? ''}`,
        visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      };
    });
    if (snapshot) {
      seen.add(snapshot.key);
      if (snapshot.visible) visibleFocusCount += 1;
    }
  }
  expect(seen.size, `Keyboard focus did not traverse the page on ${page.url()}`).toBeGreaterThan(1);
  expect(visibleFocusCount, `No visible focus indicator detected on ${page.url()}`).toBeGreaterThan(0);
}

async function auditReflow(page: Page) {
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `Horizontal page overflow at 320 CSS px on ${page.url()}`).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function auditPage(page: Page, path: string) {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/sign-in$/);
  await auditAccessibleNames(page);
  await auditStructure(page);
  await auditStaticSemantics(page);
  await auditTextContrast(page);
  await auditKeyboardAndFocus(page);
  await auditReflow(page);
}

test('WCAG 2.2 AA core browser contract for stable club beta surfaces', async ({ page }) => {
  await signInIfNeeded(page);
  await auditPage(page, '/');
  await auditPage(page, '/athletes');
  await auditPage(page, '/tests');

  const result = await db.$client.execute({ sql: 'SELECT id FROM tests ORDER BY created_at DESC LIMIT 1', args: [] });
  const testId = result.rows[0]?.id;
  expect(typeof testId, 'The WCAG contract requires an existing E2E test to cover the test detail/review surface').toBe('string');
  await auditPage(page, `/tests/${String(testId)}`);
});
