import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__DIWALI_GAME__?.getDebugState().ready === true, { timeout: 30000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const game = window.__DIWALI_GAME__;
  const body = game.drone.body;
  body.setTranslation({ x: 24, y: 5.2, z: 56 }, true);
  body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/street-level.png' });

await page.evaluate(() => {
  const game = window.__DIWALI_GAME__;
  const body = game.drone.body;
  body.setTranslation({ x: -1.7, y: 4.2, z: 30 }, true);
  body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
});
await page.waitForTimeout(800);
await page.screenshot({ path: 'screenshots/gali-level.png' });

await browser.close();
