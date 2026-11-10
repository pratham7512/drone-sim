import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:5199/';
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') console.log(message.type(), message.text());
});
page.on('pageerror', (error) => console.log('pageerror', error.message));
await mkdir('screenshots', { recursive: true });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__DIWALI_GAME__?.getDebugState().ready === true, {
  timeout: 30_000,
});
await page.waitForTimeout(2000);

const state = async (label) => {
  const value = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());
  console.log(label, JSON.stringify({
    p: value.position,
    mode: value.flightMode,
    state: value.flightState,
    lock: value.altitudeLocked,
    fps: value.fps,
    calls: value.drawCalls,
    tris: value.triangles,
  }));
  return value;
};
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

await state('initial');
await hold('Space', 900);
await page.waitForTimeout(1600);
await state('hover');

await page.keyboard.press('h');
await page.waitForTimeout(800);
await state('locked');

await hold('w', 2500);
await page.waitForTimeout(500);
await state('over-street');
await page.screenshot({ path: 'screenshots/03-street.png' });

await hold('q', 700);
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/04-street-turn.png' });

await hold('w', 800);
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/05-street-forward.png' });

await browser.close();
