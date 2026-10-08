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
  { name: 'mobile-320', width: 320, height: 720, isMobile: true },
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

  // Trigger scroll-based reveal effects before capturing the full page.
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const scrollStep = Math.max(200, Math.floor(profile.height * 0.75));
  for (let y = 0; y < pageHeight; y += scrollStep) {
    await page.evaluate((position) => window.scrollTo(0, position), y);
    await page.waitForTimeout(160);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(750);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(450);

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

const yg03AdditionalQA = await runYG03AdditionalQA(browser);
const bookingQA = await runBookingQA(browser);

await runYG05LanguageQA(browser);
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
  for (const profile of profiles.filter((p) => p.name === 'desktop' || p.name === 'mobile')) {
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
      await page.locator('section').filter({ has: page.locator('h1') }).locator('button').filter({ hasText: '無料体験を予約' }).first().click({ timeout: 10000 });
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
      const expected = ['B01-open','B02-close','B03-input','B04-dates','B05-week-navigation','B06-horizontal-date-scroll','B07-time-slots','B08-booked-disabled','B09-date-change-clears-booked','B10-required-fields','B11-email-validation','B12-demo-success','B13-reset','B14-modal-scroll','B15-modal-bounds'];
      for (const id of expected) {
        if (!cases.some((item) => item.id === id)) cases.push({ id, status: 'NOT TESTED', reason: 'Setup failed before this case could run' });
      }
    } finally {
      results.profiles[profile.name] = cases;
      await context.close();
    }
  }
  await fs.writeFile(path.join(outputDir, 'booking-qa.json'), JSON.stringify(results, null, 2));
  return results;
}


async function runYG03AdditionalQA(browser) {
  const results = { commit: commitSha, map: {}, mobile320: { cases: [] } };
  const context = await browser.newContext({
    viewport: { width: 320, height: 720 }, screen: { width: 320, height: 720 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const check = async (id, test) => {
    try {
      const details = await test();
      results.mobile320.cases.push({ id, status: 'PASS', details: details || null });
    } catch (error) {
      results.mobile320.cases.push({ id, status: 'FAIL', error: String(error.message || error).slice(0, 500) });
    }
  };
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 30000 });
    const frame = page.locator('#access iframe[title="Y_Gym Ebisu Area Map"]');
    results.map.exists = (await frame.count()) === 1;
    if (results.map.exists) {
      results.map.source = await frame.getAttribute('src');
      await frame.scrollIntoViewIfNeeded();
      const box = await frame.boundingBox();
      results.map.bounds = box;
      results.map.validBounds = !!box && box.width > 200 && box.height > 200 && box.x >= -1 && box.x + box.width <= 321;
      results.map.loadEvent = 'NOT VERIFIED';
      try {
        await frame.evaluate((el) => new Promise((resolve, reject) => {
          if (el.contentDocument?.readyState === 'complete') return resolve(true);
          const timer = setTimeout(() => reject(Error('iframe load timeout')), 10000);
          el.addEventListener('load', () => { clearTimeout(timer); resolve(true); }, { once: true });
        }));
        results.map.loadEvent = 'OBSERVED';
      } catch (error) {
        results.map.loadEvent = 'NOT VERIFIED: ' + String(error.message || error);
      }
      await page.locator('#access').screenshot({ path: path.join(outputDir, 'access-map-mobile-320.png'), animations: 'disabled' });
      results.map.visualRendering = 'REQUIRES VISUAL REVIEW';
    }
    const dialog = page.locator('[role="dialog"]');
    await check('M320-01', async () => {
      await page.locator('section').filter({ has: page.locator('h1') }).locator('button').filter({ hasText: '無料体験を予約' }).first().click();
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
    });
    if (await dialog.isVisible()) {
      await page.waitForTimeout(600);
      await check('M320-02', async () => {
        const box = await dialog.boundingBox();
        if (!box || box.x < -1 || box.x + box.width > 321) throw Error('Dialog outside 320px viewport');
        return box;
      });
      await check('M320-03', async () => {
        const data = await dialog.evaluate(el => {
          const a = el.getBoundingClientRect();
          const offenders = [...el.querySelectorAll('*')].filter(node => {
            const r = node.getBoundingClientRect();
            const s = getComputedStyle(node);
            // Ignore items intentionally clipped by the horizontal date carousel.
            if (node.closest('.no-scrollbar')) return false;
            return s.position !== 'absolute' && s.position !== 'fixed' &&
              s.overflowX !== 'auto' && s.overflowX !== 'scroll' &&
              r.width > 0 && (r.left < a.left - 2 || r.right > a.right + 2);
          }).slice(0, 8).map(n => ({tag:n.tagName, className:typeof n.className==='string'?n.className.slice(0,80):''}));
          return { offenders, dialogWidth: a.width };
        });
        if (data.offenders.length) throw Error('Possible overflow: ' + JSON.stringify(data.offenders));
        return data;
      });
      await page.screenshot({path:path.join(outputDir,'booking-mobile-320.png'),animations:'disabled'});
      await check('M320-04', async () => {
        const el = dialog.locator('.no-scrollbar').first();
        const metrics = await el.evaluate(e=>({scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
        if (metrics.scrollWidth <= metrics.clientWidth) throw Error('Date row cannot scroll');
        await el.evaluate(e=>{e.scrollLeft=e.scrollWidth});
        if (await el.evaluate(e=>e.scrollLeft) <= 0) throw Error('Scroll position unchanged');
        return metrics;
      });
      await check('M320-05', async () => {
        const cards = dialog.locator('button').filter({hasText:/^\d{1,2}\/\d{1,2}/});
        await cards.first().click();
        const spans = await dialog.locator('span').allTextContents();
        const slots = ['09:00','10:00','11:00','12:00','13:00','15:00','17:00','19:00'];
        const missing = slots.filter(t=>!spans.includes(t));
        if(missing.length) throw Error('Missing time slots: '+missing.join(','));
        return slots;
      });
      await check('M320-06', async () => {
        const scroller = dialog.locator('.overflow-y-auto').first();
        const size = await scroller.evaluate(e=>({scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}));
        if(size.scrollHeight <= size.clientHeight) throw Error('Expected vertical scrolling at 320px');
        await scroller.evaluate(e=>{e.scrollTop=e.scrollHeight});
        if(await scroller.evaluate(e=>e.scrollTop)<=0) throw Error('Vertical scrolling failed');
        return size;
      });
      await page.screenshot({path:path.join(outputDir,'booking-mobile-320-scrolled.png'),animations:'disabled'});
      await check('M320-07', async () => {
        await dialog.locator('button[aria-label="閉じる"]').click();
        await dialog.waitFor({state:'hidden',timeout:6000});
      });
    } else {
      for (let i=2;i<=7;i++) results.mobile320.cases.push({id:'M320-0'+i,status:'NOT TESTED',reason:'Dialog did not open'});
    }
  } finally {
    await context.close();
    await fs.writeFile(path.join(outputDir,'yg03-additional-qa.json'),JSON.stringify(results,null,2));
  }
  return results;
}

async function runYG05LanguageQA(browser) {
  const langs = [['ja','日本語'],['en','English'],['zh','简体中文'],['ko','한국어'],['fr','Français'],['es','Español'],['th','ไทย'],['vi','Tiếng Việt']];
  const viewports = [{name:'desktop',width:1440,height:900,mobile:false},{name:'mobile',width:390,height:844,mobile:true},{name:'mobile-320',width:320,height:720,mobile:true}];
  const report = {commit:commitSha,profiles:{},summary:{PASS:0,FAIL:0,'NOT TESTED':0}};
  const ids=['switch','hero','modal','form','demo','overflow','javascript'];
  for (const viewport of viewports) {
    report.profiles[viewport.name]={};
    const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},isMobile:viewport.mobile,hasTouch:viewport.mobile});
    const page=await context.newPage();
    let errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    try {
      await page.goto(baseUrl,{waitUntil:'domcontentloaded',timeout:60000});
      await page.locator('h1').first().waitFor({timeout:30000});
      for (const [code,name] of langs) {
        const cases=[];errors=[];
        const test=async(id,fn)=>{
          try { const detail=await fn();cases.push({id,status:'PASS',detail:detail||''});report.summary.PASS++;return true; }
          catch(e){cases.push({id,status:'FAIL',error:String(e.message||e).slice(0,350)});report.summary.FAIL++;return false;}
        };
        const skip=(id,reason)=>{cases.push({id,status:'NOT TESTED',reason});report.summary['NOT TESTED']++;};
        report.profiles[viewport.name][code]=cases;
        const switched=await test('switch',async()=>{
          if(viewport.mobile) {
            await page.locator('#menu-toggle-btn').click();
            const menu=page.locator('#mobile-menu');
            await menu.waitFor({state:'visible',timeout:6000});
            await menu.getByRole('button',{name:new RegExp(name)}).first().click();
            await page.waitForFunction(() => {
              const toggle=document.querySelector('#menu-toggle-btn');
              const panel=document.querySelector('#mobile-menu');
              return toggle?.getAttribute('aria-expanded')==='false' &&
                !!panel && panel.getBoundingClientRect().left >= window.innerWidth - 1;
            },{timeout:6000});
            const chosen=menu.getByRole('button',{name:new RegExp(name)}).first();
            const selectedClass=await chosen.getAttribute('class') || '';
            if(!selectedClass.includes('border-[#831a34]'))throw Error('Selected mobile language not reflected');
          } else {
            await page.locator('#main-nav button[aria-haspopup="listbox"]').click();
            await page.getByRole('listbox').getByRole('option',{name:new RegExp(name)}).click();
            const selected=await page.locator('#main-nav button[aria-haspopup="listbox"]').innerText();
            if(!selected.includes(name))throw Error('Selected language not reflected');
          }
          await page.waitForTimeout(350);
          return code;
        });
        if(!switched) {for(const id of ids.slice(1))skip(id,'Language switch failed');continue;}
        await test('hero',async()=>{
          const hero=page.locator('section').filter({has:page.locator('h1')}).first();
          const txt=await hero.innerText();
          if(txt.length<30||code!=='ja'&&txt.includes('運動ゼロでも大丈夫'))throw Error('Missing translation or Japanese fallback');
          return txt.slice(0,120);
        });
        const dialog=page.locator('[role="dialog"]');
        const opened=await test('modal',async()=>{
          await page.locator('section').filter({has:page.locator('h1')}).first().locator('button').first().click();
          await dialog.waitFor({state:'visible',timeout:7000});
          const txt=await dialog.locator('#modal-title').innerText();
          if(!txt.trim()||code!=='ja'&&txt.includes('無料体験デモ'))throw Error('Modal not translated');
          return txt;
        });
        if(opened) {
          await test('form',async()=>{
            await dialog.locator('#modal-name').fill('QA Sample');
            await dialog.locator('#modal-email').fill('qa@example.com');
            const cards=dialog.locator('button').filter({hasText:/^\d{1,2}\/\d{1,2}/});
            if(await cards.count()!==7)throw Error('Not seven date cards');
            await cards.first().click();
            const spans=await dialog.locator('span').allTextContents();
            const missing=['09:00','10:00','11:00','12:00','13:00','15:00','17:00','19:00'].filter(t=>!spans.includes(t));
            if(missing.length)throw Error('Missing slots '+missing.join(','));
            return 'Inputs/date/time';
          });
          await test('demo',async()=>{
            await dialog.locator('#modal-name').fill('QA Sample');
            await dialog.locator('#modal-email').fill('qa@example.com');
            await dialog.locator('button').filter({hasText:/^\d{1,2}\/\d{1,2}/}).first().click();
            await dialog.locator('button').filter({hasText:/^09:00/}).first().click();
            await dialog.locator('button[type="submit"]').click();
            await dialog.getByText('QA Sample',{exact:false}).first().waitFor({timeout:7000});
            if(!(await dialog.innerText()).includes('09:00'))throw Error('Selected time not present');
            await page.screenshot({path:path.join(outputDir,'yg05-'+viewport.name+'-'+code+'-success.png'),animations:'disabled'});
          });
          await page.screenshot({path:path.join(outputDir,'yg05-'+viewport.name+'-'+code+'-modal.png'),animations:'disabled'});
          await dialog.locator('button[aria-label="閉じる"]').click();
          await dialog.waitFor({state:'hidden',timeout:6000});
        } else {skip('form','Modal did not open');skip('demo','Modal did not open');}
        await test('overflow',async()=>{
          const x=await page.evaluate(()=>({w:innerWidth,doc:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)}));
          if(x.doc>x.w+1)throw Error(JSON.stringify(x));
          return x;
        });
        await test('javascript',async()=>{if(errors.length)throw Error(errors.join(' | '));return 'No pageerror';});
        await page.screenshot({path:path.join(outputDir,'yg05-'+viewport.name+'-'+code+'-hero.png'),animations:'disabled'});
      }
    } catch(e) {
      report.profiles[viewport.name].setupError=String(e.message||e);
      for(const [code] of langs)if(!report.profiles[viewport.name][code]){
        report.profiles[viewport.name][code]=ids.map(id=>{report.summary['NOT TESTED']++;return{id,status:'NOT TESTED',reason:'Profile setup failed'};});
      }
    } finally {await context.close();}
  }
  await fs.writeFile(path.join(outputDir,'yg05-language-qa.json'),JSON.stringify(report,null,2));
  return report;
}
