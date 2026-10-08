import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:3000/';
const outputDir = path.resolve('visual-preview');
const commitSha = process.env.GITHUB_SHA || 'local';

const profiles = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false },
  { name: 'tablet', width: 768, height: 1024, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const summary = {
  commit: commitSha,
  generatedAt: new Date().toISOString(),
  url: baseUrl,
  profiles: {},
};

for (const profile of profiles) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    screen: { width: profile.width, height: profile.height },
    deviceScaleFactor: 1,
    isMobile: profile.isMobile,
    hasTouch: profile.isMobile,
  });

  const page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('requestfailed', (request) => {
    failedRequests.push({
      url: request.url(),
      method: request.method(),
      failure: request.failure()?.errorText || 'unknown',
    });
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // Some CDN or analytics requests can remain active; continue after a short settle period.
  }

  await page.evaluate(async () => {
    if (document.fonts?.ready) {
      try { await document.fonts.ready; } catch {}
    }

    const pendingImages = [...document.images]
      .filter((img) => !img.complete)
      .map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      }));

    await Promise.all(pendingImages);
  });

  await page.waitForTimeout(1200);

  const diagnostics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;

    const brokenImages = [...document.images]
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt || '',
      }));

    const overflowingElements = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > window.innerWidth + 1 || rect.left < -1;
      })
      .slice(0, 30)
      .map((el) => ({
        tag: el.tagName,
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.slice(0, 180) : '',
        left: Math.round(el.getBoundingClientRect().left),
        right: Math.round(el.getBoundingClientRect().right),
        width: Math.round(el.getBoundingClientRect().width),
      }));

    return {
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      document: {
        scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
        scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0),
      },
      horizontalOverflow:
        Math.max(root.scrollWidth, body?.scrollWidth || 0) > window.innerWidth + 1,
      brokenImages,
      overflowingElements,
      imageCount: document.images.length,
      linkCount: document.links.length,
      buttonCount: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
      h1Count: document.querySelectorAll('h1').length,
    };
  });

  await page.screenshot({
    path: path.join(outputDir, `${profile.name}-viewport.png`),
    fullPage: false,
    animations: 'disabled',
  });

  await page.screenshot({
    path: path.join(outputDir, `${profile.name}-full.png`),
    fullPage: true,
    animations: 'disabled',
  });

  const profileDiagnostics = {
    ...diagnostics,
    consoleErrors,
    pageErrors,
    failedRequests,
  };

  summary.profiles[profile.name] = profileDiagnostics;

  await fs.writeFile(
    path.join(outputDir, `${profile.name}-diagnostics.json`),
    JSON.stringify(profileDiagnostics, null, 2)
  );

  await context.close();
}

const bookingQA = await runBookingQA(browser);

await browser.close();

await fs.writeFile(
  path.join(outputDir, 'diagnostics.json'),
  JSON.stringify(summary, null, 2)
);

await fs.writeFile(
  path.join(outputDir, 'metadata.json'),
  JSON.stringify(
    {
      commit: commitSha,
      generatedAt: summary.generatedAt,
      url: baseUrl,
      screenshots: profiles.flatMap((profile) => [
        `${profile.name}-viewport.png`,
        `${profile.name}-full.png`,
      ]),
      viewportSizes: Object.fromEntries(
        profiles.map((profile) => [
          profile.name,
          { width: profile.width, height: profile.height },
        ])
      ),
    },
    null,
    2
  )
);

console.log('Visual preview generated successfully.');


async function runBookingQA(browser) {
  const results = { commit: commitSha, generatedAt: new Date().toISOString(), profiles: {}, passed: 0, failed: 0 };
  for (const profile of profiles.filter((p) => p.name !== 'tablet')) {
    const context = await browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      screen: { width: profile.width, height: profile.height },
      isMobile: profile.isMobile, hasTouch: profile.isMobile, deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const cases = [];
    const check = async (id, fn) => {
      try {
        const detail = await fn();
        cases.push({ id, status: 'PASS', detail: detail || '' });
        results.passed++;
      } catch (error) {
        cases.push({ id, status: 'FAIL', error: String(error.message || error).slice(0, 400) });
        results.failed++;
      }
    };
    const dialog = page.locator('[role="dialog"]');
    const isOpen = async () => (await dialog.count()) > 0 && await dialog.isVisible();
    const open = async () => {
      await page.locator('button').filter({ hasText: '無料体験を予約' }).first().click();
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
    };
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30000 });
      await check('B01-open', async () => { await open(); if (!await isOpen()) throw Error('dialog absent'); });
      if (!await isOpen()) throw Error('Cannot run booking QA without dialog');
      await check('B02-close', async () => {
        await dialog.locator('button[aria-label="閉じる"]').click();
        await dialog.waitFor({ state: 'hidden', timeout: 5000 });
        if (await page.evaluate(() => document.body.style.overflow === 'hidden')) throw Error('body remains locked');
        await open();
      });
      await check('B03-input', async () => {
        await dialog.locator('#modal-name').fill('QA Test');
        await dialog.locator('#modal-email').fill('qa@example.com');
        if (await dialog.locator('#modal-name').inputValue() !== 'QA Test') throw Error('name missing');
      });
      const cards = dialog.locator('button').filter({ has: page.locator('div') }).filter({ hasText: /^\d{1,2}\/\d{1,2}/ });
      await check('B04-dates', async () => {
        const count = await cards.count();
        if (count !== 7) throw Error('Expected 7 date cards, got ' + count);
        await cards.first().click();
      });
      await check('B05-week-navigation', async () => {
        const first = await cards.first().innerText();
        await dialog.getByRole('button', { name: '次の7日' }).click();
        if (await cards.first().innerText() === first) throw Error('next week did not change');
        await dialog.getByRole('button', { name: '前の7日' }).click();
        if (await cards.first().innerText() !== first) throw Error('previous week did not restore');
      });
      await check('B06-horizontal-date-scroll', async () => {
        const el = dialog.locator('div.no-scrollbar').first();
        const state = await el.evaluate((e) => ({ width: e.scrollWidth, client: e.clientWidth }));
        if (profile.isMobile && state.width <= state.client) throw Error('mobile date row not scrollable');
        if (profile.isMobile) {
          await el.evaluate((e) => { e.scrollLeft = e.scrollWidth; e.dispatchEvent(new Event('scroll')); });
          const pos = await el.evaluate((e) => e.scrollLeft);
          if (pos <= 0) throw Error('date row could not scroll');
        }
      });
      await check('B07-time-slots', async () => {
        await cards.first().click();
        const buttons = dialog.locator('button').filter({ hasText: /^09:00|^10:00|^11:00|^12:00|^13:00|^15:00|^17:00|^19:00/ });
        const times = await dialog.locator('span').allTextContents();
        for (const t of ['09:00','10:00','11:00','12:00','13:00','15:00','17:00','19:00']) if (!times.includes(t)) throw Error('Missing ' + t);
        await dialog.locator('button').filter({ hasText: /^09:00/ }).click();
        if (!await buttons.count()) throw Error('No time buttons');
      });
      await check('B08-booked-disabled', async () => {
        const booked = dialog.locator('[title]').filter({ hasText: '満席' });
        if (await booked.count() < 1) throw Error('No booked time visible');
        if (await booked.first().evaluate((el) => el.tagName.toLowerCase()) === 'button') throw Error('Booked item is clickable');
      });
      await check('B09-date-change-clears-booked', async () => {
        // Choose an available time on one date that is booked on another date.
        const tomorrowCards = cards;
        let tested = false;
        for (let i = 0; i < 7 && !tested; i++) {
          await tomorrowCards.nth(i).click();
          for (const time of ['11:00','17:00','15:00','10:00']) {
            const option = dialog.locator('button').filter({ hasText: new RegExp('^' + time) }).first();
            if (!await option.count()) continue;
            await option.click();
            for (let j = 0; j < 7; j++) {
              if (i === j) continue;
              await tomorrowCards.nth(j).click();
              const booked = dialog.locator('[title]').filter({ hasText: time });
              if (await booked.count()) {
                const picked = await dialog.locator('button').filter({ hasText: new RegExp('^' + time) }).count();
                if (picked) throw Error('Booked time remains selectable');
                tested = true; break;
              }
            }
            if (tested) break;
            await tomorrowCards.nth(i).click();
          }
        }
        if (!tested) throw Error('Could not reach transition case');
      });
      await check('B10-required-fields', async () => {
        await dialog.locator('#modal-name').fill('');
        const submit = dialog.locator('button[type="submit"]');
        if (await submit.isEnabled()) throw Error('Submit enabled without name');
        await dialog.locator('#modal-name').fill('QA Test');
      });
      await check('B11-email-validation', async () => {
        await dialog.locator('#modal-email').fill('not-an-email');
        await cards.first().click();
        await dialog.locator('button').filter({ hasText: /^09:00/ }).click();
        const valid = await dialog.locator('#modal-email').evaluate((el) => el.checkValidity());
        if (valid) throw Error('Invalid email accepted');
        await dialog.locator('#modal-email').fill('qa@example.com');
      });
      await check('B14-modal-scroll', async () => {
        if (await page.evaluate(() => document.body.style.overflow) !== 'hidden') throw Error('background not locked');
        const scroller = dialog.locator('.overflow-y-auto').first();
        const dimensions = await scroller.evaluate((e) => ({ scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));
        if (dimensions.scrollHeight > dimensions.clientHeight) await scroller.evaluate((e) => { e.scrollTop = e.scrollHeight; });
      });
      await check('B15-modal-bounds', async () => {
        const box = await dialog.boundingBox();
        if (!box || box.x < -1 || box.x + box.width > profile.width + 1) throw Error('dialog exceeds viewport');
      });
      await page.screenshot({ path: path.join(outputDir, 'booking-' + profile.name + '.png'), animations: 'disabled' });
      await check('B12-demo-success', async () => {
        await cards.first().click();
        await dialog.locator('button').filter({ hasText: /^09:00/ }).click();
        await dialog.locator('button[type="submit"]').click();
        await dialog.getByText('QA Test', { exact: false }).first().waitFor({ timeout: 6000 });
        if (!await dialog.getByText(/09:00/).count()) throw Error('Time absent in success');
        await page.screenshot({ path: path.join(outputDir, 'booking-success-' + profile.name + '.png'), animations: 'disabled' });
      });
      await check('B13-reset', async () => {
        await dialog.getByRole('button', { name: '閉じる' }).first().click();
        await dialog.waitFor({ state: 'hidden', timeout: 5000 });
        await open();
        if (await dialog.locator('#modal-name').inputValue() !== '') throw Error('name not reset');
        if (await dialog.locator('#modal-email').inputValue() !== '') throw Error('email not reset');
      });
    } catch (error) {
      cases.push({ id: 'SETUP', status: 'FAIL', error: String(error.message || error).slice(0, 600) });
      results.failed++;
    } finally {
      results.profiles[profile.name] = cases;
      await context.close();
    }
  }
  await fs.writeFile(path.join(outputDir, 'booking-qa.json'), JSON.stringify(results, null, 2));
  return results;
}
