// Text tool in the built page: a text part wrapped onto a cylinder, dragged, spiralled, kept;
// then a deboss. Headless and muted; close-up screenshots to .tmp/textwrap, delete after.
// node tests/textwrap.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'textwrap'), PROFILE = join(OUT, 'chrome');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const findChrome = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findChrome(p); if (hit) return hit; } else if (e.name === 'chrome.exe') return p;
  }
  return null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR), headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0;
const errors = [];
const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.setViewport({ width: 1256, height: 844 });
  await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
  await page.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  await page.waitForSelector('footer .msg');
  const click = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.getClientRects().length > 0)) { await e.click(); await sleep(250); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const field = async (label, value) => {
    for (const f of await page.$$('.field')) {
      if ((await f.evaluate(n => n.querySelector('label')?.textContent)) !== label || !(await f.evaluate(n => n.getClientRects().length > 0))) continue;
      const input = await f.$('input');
      await input.click({ clickCount: 3 }); await input.type(String(value)); await page.keyboard.press('Enter'); await sleep(400);
      return;
    }
    throw new Error(`no field ${label}`);
  };
  const status = () => page.$eval('footer .msg', e => e.textContent);
  const at = (x, y, z) => page.evaluate((x, y, z) => {
    const v = document.getElementById('view').viewer, r = v.renderer.domElement.getBoundingClientRect();
    const p = v.camera.position.clone().set(x, y, z).project(v.camera);
    return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
  }, x, y, z);
  const look = (pos, target) => page.evaluate((pos, target) => {
    const v = document.getElementById('view').viewer;
    v.camera.position.set(...pos); v.controls.target.set(...target); v.controls.update(); v.request();
  }, pos, target);
  const shot = async name => { await sleep(300); await page.screenshot({ path: join(OUT, name + '.png') }); };

  // a first start: High contrast, 3D path off
  await sleep(500);
  const first = await page.evaluate(() => ({ scheme: document.documentElement.dataset.scheme, frame: [...document.querySelectorAll('button')].some(b => /3D frame/.test(b.textContent) && b.getClientRects().length) }));
  step('first start: High contrast, no 3D path', first.scheme === 'mono' && !first.frame, JSON.stringify(first));
  await shot('0-first-start');

  // a cylinder d 30 h 30 in the middle; the first change asks about saving: say no
  await click('.tabs button', 'Shape tools'); await click('.shapes .btn', 'Cylinder'); await page.keyboard.press('Enter'); await sleep(500);
  for (const b of await page.$$('dialog[open] .btn')) { await b.click(); break; }
  await sleep(300);
  await field('Diameter', 30); await field('Height', 30);
  // a text, 5 mm, out of the way
  await click('.shapes .btn', 'Text'); await page.keyboard.press('Enter'); await sleep(600);
  await field('Size', 5);
  await page.$eval('.textin', e => { e.value = 'Workingtitle'; e.dispatchEvent(new Event('change')); });
  await sleep(600);
  await look([60, -60, 30], [0, 0, 15]);
  await click('.btn', 'Wrap onto a part');
  const side = await at(0, -15, 15);
  await page.mouse.click(...side); await sleep(800);
  step('wrap starts on the cylinder', /Text on Cylinder/.test(await status()), await status());
  await look([0, -45, 17], [0, 0, 15]);
  await shot('1-wrapped-front');
  await look([30, -38, 25], [0, 0, 15]);
  await shot('2-wrapped-angle');

  // drag on the cylinder: the text follows and re-forms
  const a = await at(0, -15, 15), b = await at(10.6, -10.6, 22);
  const t0 = Date.now();
  await page.mouse.move(...a); await page.mouse.down();
  for (let k = 1; k <= 10; k++) { await page.mouse.move(a[0] + (b[0] - a[0]) * k / 10, a[1] + (b[1] - a[1]) * k / 10); await sleep(30); }
  await page.mouse.up(); await sleep(300);
  await shot('3-dragged');
  step('drag moved the text', true, `${Date.now() - t0} ms for 10 moves`);

  // a letter setting changed while wrapped: the wrapped text follows, and no flat copy shows
  const spanOf = () => page.evaluate(() => { const a = document.getElementById('view').viewer.wrapMesh.geometry.attributes.position.array; let lo = 1e9, hi = -1e9; for (let i = 2; i < a.length; i += 3) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); } return hi - lo; });
  const tall0 = await spanOf();
  await field('Line width', 1.2); await sleep(400);
  const tall1 = await spanOf();
  const shown = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(o => o.group.visible).length);
  step('line width re-forms the wrapped text, no copy', tall1 < tall0 - 0.3 && shown === 1, `height ${tall0.toFixed(2)} -> ${tall1.toFixed(2)} mm, ${shown} part shown`);

  // spiral 15 deg, then overhangs slanted (the cylinder's side is a wall), then emboss kept
  await field('Spiral', 15);
  await look([0, -55, 20], [0, 0, 15]);
  await shot('4-spiral');
  for (const l of await page.$$('label.check')) if ((await l.evaluate(n => n.textContent)) === 'Slant overhangs') { await l.click(); break; }
  for (let k = 0; k < 40 && !/slanted/.test(await status()); k++) await sleep(250);
  step('overhangs slanted', /slanted to 45/.test(await status()), await status());
  await look([35, -40, 0], [8, -8, 16]);   // from below, to see the slanted undersides
  await shot('4b-slant-below');
  await look([16, -30, 9], [6, -14, 17]);
  await shot('4c-slant-close');
  await click('.btn', 'Done'); await sleep(800);
  step('Done locks it onto the part', /locked onto Cylinder/.test(await status()), await status());
  await shot('5-done');
  const lockText = await page.$eval('.lockrow', e => e.textContent).catch(() => '');
  step('the group shows the lock', /locked to Cylinder/.test(lockText), lockText);
  // on the Parts tab: Unlock, then Flat text again; the tab stays where it was
  await click('.tabs button', 'Parts'); await sleep(400);
  await click('.lockrow .btn', 'Unlock'); await sleep(800);
  step('Unlock frees the text', /unlocked/.test(await status()) && (await page.evaluate(() => document.getElementById('view').viewer.objs.size)) === 2, await status());
  await click('.btn', 'Flat text again'); await sleep(800);
  const tabNow = await page.evaluate(() => [...document.querySelectorAll('.tabs button')].find(b => b.classList.contains('on'))?.textContent);
  step('Flat text again keeps the Parts tab', tabNow === 'Parts', tabNow);
  await click('.tabs button', 'Shape tools'); await sleep(300);

  // a deboss: a second text, cut into the other side, grouped
  await click('.shapes .btn', 'Text'); await page.keyboard.press('Enter'); await sleep(600);
  await field('Size', 6); await field('Height', 1);
  await page.$eval('.textin', e => { e.value = 'WT3D'; e.dispatchEvent(new Event('change')); });
  await sleep(600);
  await look([-60, 60, 30], [0, 0, 15]);
  await click('.btn', 'Wrap onto a part');
  await page.mouse.click(...await at(-10.6, 10.6, 12)); await sleep(800);
  await click('.seg button', 'Deboss'); await sleep(300);
  await click('.btn', 'Done'); await sleep(2500);
  step('deboss cuts in (grouped)', /cut into/.test(await status()), await status());
  await look([-35, 35, 14], [0, 0, 12]);
  await shot('6-deboss');
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(500);
  await shot('7-deboss-1920');

  // Snap faces: its bar's Done takes the click (the view must not sit over it)
  await page.setViewport({ width: 1256, height: 844 }); await sleep(400);
  await page.evaluate(() => { for (const b of document.querySelectorAll('.menubar .mtitle')) if (b.textContent === 'Edit') b.click(); });
  await sleep(200);
  for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)).startsWith('Snap faces')) { await b.click(); break; }
  await sleep(300);
  const onTop = await page.evaluate(() => { const bar = document.querySelector('.snapbar'); if (!bar || bar.style.display === 'none') return 'no bar'; const r = bar.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return bar.contains(e) ? 'bar' : e?.tagName; });
  step('Snap faces bar takes clicks', onTop === 'bar', onTop);
} catch (e) { fail++; console.log('FAIL', e.message); }
for (const e of errors) { fail++; console.log('FAIL', e); }
await browser.close();
console.log(fail ? `VERDICT FAIL (${fail})` : 'VERDICT PASS');
process.exit(fail ? 1 : 0);
