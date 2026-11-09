import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const out = '/private/var/folders/8f/sthz3w_56w5czfjrq5475vgr0000gn/T/opencode/drone-video-frames';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
  <video id="v" src="http://127.0.0.1:8021/drone-sim.mp4" style="width:100vw;height:100vh;object-fit:contain" muted playsinline></video>
</body></html>`);

await page.waitForFunction(() => {
  const v = document.querySelector('video');
  return v && v.readyState >= 2 && v.videoWidth > 0;
}, { timeout: 30000 });

const info = await page.evaluate(() => {
  const v = document.querySelector('video');
  return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
});
console.log('VIDEO', info);

const times = [0.2];
const step = Math.max(0.5, info.duration / 14);
for (let t = step; t < info.duration; t += step) times.push(t);
times.push(Math.max(0, info.duration - 0.15));

let index = 0;
for (const time of times) {
  await page.evaluate((t) => new Promise((resolve) => {
    const v = document.querySelector('video');
    const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = t;
  }), Math.min(time, info.duration - 0.01));
  const name = `frame-${String(index).padStart(2, '0')}-${time.toFixed(2)}s.png`;
  await page.screenshot({ path: `${out}/${name}` });
  console.log(name);
  index += 1;
}

await browser.close();
