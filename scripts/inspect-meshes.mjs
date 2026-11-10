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
const rows = await page.evaluate(() => {
  const scene = window.__DIWALI_GAME__.engine.scene;
  const out = [];
  scene.traverse((object) => {
    if (!object.isMesh && !object.isPoints && !object.isLineSegments) return;
    const geometry = object.geometry;
    const indexCount = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
    const tris = object.isMesh ? Math.round(indexCount / 3) : 0;
    const instances = object.isInstancedMesh ? object.count : 1;
    out.push({ name: object.name || object.type, tris, instances, total: tris * instances, calls: 1 });
  });
  return out.sort((a, b) => b.total - a.total);
});
console.log(rows.slice(0, 40).map((r) => `${r.total.toString().padStart(8)}  ${r.instances.toString().padStart(5)}x  ${r.tris.toString().padStart(5)}  ${r.name}`).join('\n'));
await browser.close();
