import { chromium } from 'playwright';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__DIWALI_GAME__?.getDebugState().ready === true);
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__KEYS__ = [];
  window.addEventListener('keydown', (e) => window.__KEYS__.push({ type: 'down', key: e.key, code: e.code }));
  window.addEventListener('keyup', (e) => window.__KEYS__.push({ type: 'up', key: e.key, code: e.code }));
});
const state = async (label) => {
  const v = await page.evaluate(() => {
    const d = window.__DIWALI_GAME__.getDebugState();
    return { y: d.position.y, speed: d.speed, throttle: d.throttle, lock: d.altitudeLocked };
  });
  console.log(label, v);
};
await state('start');
await page.keyboard.down('Space');
await page.waitForTimeout(1200);
await page.keyboard.up('Space');
await state('space-up');
for (let i = 0; i < 6; i += 1) {
  await page.waitForTimeout(500);
  await state(`coast ${i}`);
}
await page.keyboard.down('Shift');
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(500);
  await state(`shift ${i}`);
}
await page.keyboard.up('Shift');
console.log(await page.evaluate(() => window.__KEYS__));
await browser.close();
