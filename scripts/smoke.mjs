import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:5199/';
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const errors = [];
const warnings = [];
const failedRequests = [];

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
  if (message.type() === 'error') errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
});

await mkdir('screenshots', { recursive: true });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__DIWALI_GAME__?.getDebugState().ready === true, {
  timeout: 30_000,
});
await page.waitForTimeout(2500);

await page.screenshot({ path: 'screenshots/01-terrace.png' });
const initial = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

await page.keyboard.down('Space');
await page.waitForTimeout(1300);
await page.keyboard.up('Space');
await page.waitForTimeout(400);
const afterClimb = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

await page.keyboard.down('w');
await page.waitForTimeout(1400);
await page.keyboard.up('w');
await page.waitForTimeout(350);
const afterForward = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

await page.keyboard.press('Backquote');
await page.waitForTimeout(300);
const debugVisible = await page.locator('.debug').evaluate((el) => !el.hidden);
await page.screenshot({ path: 'screenshots/02-flight.png' });

await page.keyboard.press('h');
await page.waitForTimeout(500);
const afterHoverToggle = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

await page.keyboard.press('m');
await page.waitForTimeout(300);
const afterMute = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

await page.keyboard.press('m');
await page.waitForTimeout(300);
const afterUnmute = await page.evaluate(() => window.__DIWALI_GAME__.getDebugState());

console.log(JSON.stringify({
  initial,
  afterClimb,
  afterForward,
  afterHoverToggle,
  afterMute,
  afterUnmute,
  debugVisible,
  errors,
  warnings,
  failedRequests,
}, null, 2));

await browser.close();

const climbed = afterClimb.position.y - initial.position.y;
const moved = Math.hypot(
  afterForward.position.x - afterClimb.position.x,
  afterForward.position.z - afterClimb.position.z,
);

if (initial.webgl !== 'webgl2') errors.push('WebGL2 was not active.');
if (climbed < 0.3) errors.push(`Drone did not climb (${climbed.toFixed(2)} m).`);
if (moved < 0.3) errors.push(`Drone did not move forward (${moved.toFixed(2)} m).`);
if (!debugVisible) errors.push('Debug overlay did not toggle.');
if (afterClimb.audio !== 'on') errors.push('Synthesised audio did not start on a gesture.');
if (afterHoverToggle.hoverAssist !== false) errors.push('Hover assist did not toggle off.');
if (!afterMute.muted) errors.push('Mute toggle did not mute audio.');
if (afterUnmute.muted) errors.push('Mute toggle did not restore audio.');
if (!initial.infinite) errors.push('Infinite city flag is off.');
if (!initial.postProcessing) errors.push('Post-processing pipeline is missing.');
if (!initial.frontProps) errors.push('Camera-mounted front props are missing.');
if (initial.cityBuildings < 100) errors.push(`City is too sparse (${initial.cityBuildings} buildings).`);
if (initial.cityPeriod < 256) errors.push(`City period is too short (${initial.cityPeriod} m).`);
if (initial.activeColliders < 1) errors.push('No streamed city colliders are active.');
if (initial.drawCalls > 120) errors.push(`Draw calls over budget (${initial.drawCalls}).`);
if (initial.triangles > 150_000) errors.push(`Triangle budget exceeded (${initial.triangles}).`);
if (errors.length) {
  console.error('SMOKE TEST FAILED');
  process.exitCode = 1;
} else {
  console.log('SMOKE TEST PASSED');
}
