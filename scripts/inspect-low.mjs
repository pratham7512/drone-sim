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
    state: value.flightState,
    lock: value.altitudeLocked,
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

await hold('Space', 900);
await page.waitForTimeout(1200);
await page.keyboard.press('h');
await page.waitForTimeout(500);
await hold('w', 1600);
await page.waitForTimeout(400);
await state('cruise');

await page.keyboard.press('h');
await page.waitForTimeout(200);
await hold('Shift', 6500);
await page.waitForTimeout(500);
await state('lower');
await page.keyboard.press('h');
await page.waitForTimeout(500);
await state('locked-low');
await page.screenshot({ path: 'screenshots/07-low.png' });

await hold('w', 700);
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/08-low-forward.png' });

await hold('q', 1000);
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/09-low-turn.png' });

await browser.close();
