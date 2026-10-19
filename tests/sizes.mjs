// Typed sizes for groups and imports, the outer size box, and a step on a scaled part seeing
// the part's real size. Headless and muted; screenshots to .tmp/sizes, delete after.
// node tests/sizes.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'sizes'), PROFILE = join(OUT, 'chrome');
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
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.offsetParent !== null)) { await e.click(); await sleep(150); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const closeAsk = async () => { await sleep(150); for (const b of await page.$$('dialog[open] .btn')) { await b.click(); await sleep(150); break; } };
  const addShape = async name => { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', name); await sleep(300); await page.keyboard.press('Enter'); await closeAsk(); await sleep(600); };
  const labels = () => page.$$eval('.inspector .field label', l => l.map(x => x.textContent));
  const fieldVal = l => page.$$eval('.inspector .field', (fs, l) => +fs.find(f => f.querySelector('label').textContent === l)?.querySelector('input')?.value, l);
  const setField = async (label, value) => {
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type(String(value)); await i.press('Enter'); await sleep(1200); return;
    }
    throw new Error('no field ' + label);
  };
  const dims = () => page.$$eval('.inspector .dims b', b => b.map(x => x.textContent));

  await addShape('Box');
  step('a shape has no extra Size section (its own sizes are there)', (await labels()).filter(l => l === 'Height').length === 1, (await labels()).join(', '));
  step('outer size box on one part', (await dims()).join(' ') === '20.00 20.00 20.00', (await dims()).join(' '));
  // dragging a size handle: the panel does not jump (the History block stays while the drag runs)
  await setField('Width', 25);
  await page.click('.viewbtn[aria-label="Top"]'); await sleep(400);
  const hx = await page.evaluate(() => { const v = document.getElementById('view').viewer; v.updateHandles(); const r = v.renderer.domElement.getBoundingClientRect(); const q = v.hparts[0].getWorldPosition(v.hparts[0].position.clone()).project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; });
  const layout = () => page.evaluate(() => { const d = document.querySelector('.inspector .dims'); return `${[...document.querySelectorAll('.inspector .sub')].map(s => s.textContent).filter(t => t === 'History').length} ${Math.round(d.getBoundingClientRect().top)}`; });
  const before = await layout();
  await page.mouse.move(...hx); await page.mouse.down(); await page.mouse.move(hx[0] + 40, hx[1], { steps: 8 }); await sleep(300);
  const during = await layout();
  await page.mouse.up(); await sleep(800);
  // Shape tools and Parts: the part's panel at the same height, the Shapes card on both
  const panelTop = () => page.evaluate(() => { const i = [...document.querySelectorAll('.inspector')].find(e => e.getClientRects().length); return i ? Math.round(i.getBoundingClientRect().top) : null; });
  await click('.tabs button', 'Shape tools'); const topS = await panelTop();
  await click('.tabs button', 'Parts'); await sleep(200); const topP = await panelTop();
  const shapesOnParts = await page.evaluate(() => [...document.querySelectorAll('.pane')].some(p => p.style.display !== 'none' && /^SHAPES|^Shapes/.test(p.textContent.trim())));
  step('Shape tools and Parts: the panel does not move, Shapes on both', topS != null && topS === topP && shapesOnParts, `${topS} vs ${topP}, shapes on Parts ${shapesOnParts}`);
  await click('.tabs button', 'Shape tools');
  step('size drag: History stays and the panel does not move', before === during && before.startsWith('1 '), `before ${before}, during ${during} (History count, outer size top px)`);
  await addShape('Box');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.press('g'); await page.keyboard.up('Control');
  await sleep(1500);
  await click('.tabs button', 'Parts');
  const L = await labels();
  step('a group has Width, Depth, Height', ['Width', 'Depth', 'Height'].every(l => L.includes(l)), L.join(', '));
  await setField('Height', 30);
  const scaleZ = () => page.$$eval('.inspector .field', fs => +fs.filter(f => f.querySelector('label').textContent === 'Z').pop()?.querySelector('input')?.value);
  step('typed height sets the group to 30 mm', (await dims())[2] === '30.00' && Math.abs(await scaleZ() - 150) < 1e-6, `${(await dims()).join(' x ')}, scale Z ${await scaleZ()} %`);
  const w0 = await fieldVal('Width');
  await setField('Width', 70);
  step('typed width kept exactly, height untouched', Math.abs(await fieldVal('Width') - 70) < 1e-3 && (await dims())[2] === '30.00', `width ${w0} -> ${await fieldVal('Width')}`);
  const look = await page.$eval('.inspector .dims', e => { const s = getComputedStyle(e); return `${s.cursor} ${s.backgroundColor} ${s.borderTopColor}`; });
  step('outer size box is not dressed as a button', /^default rgba\(0, 0, 0, 0\)/.test(look), look);
  await page.screenshot({ path: join(OUT, 'group-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(400);
  await page.screenshot({ path: join(OUT, 'group-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(400);

  // the step sees 30 mm: 25 mm down the side is fine, where it saw 20 before
  await click('.inspector .btn', 'Edge shaper');
  await sleep(400);
  await setField('Height down the side', 25);
  const err = await page.$$eval('.inspector .err', e => e.map(x => x.textContent).join(' '));
  const note = await page.$$eval('.inspector .card', c => c.map(x => x.textContent).join(' '));
  step('edge shaper sees the scaled height', !err && /30\.00 mm thick/.test(note), err || note.match(/part [\d.]+ mm thick/)?.[0] || '');
  await page.screenshot({ path: join(OUT, 'step-1256.png') });

  // hollow starts at 1 mm detail; finer is allowed, with a warning
  await click('.inspector .card .btn', 'Cancel');
  await click('.inspector .btn', 'Hollow');
  await sleep(300);
  const hollowNote = () => page.$$eval('.inspector .card .note', n => n.map(x => x.textContent).join(' '));
  const d0 = await fieldVal('Detail'), n0 = await hollowNote();
  await setField('Detail', 0.5);
  const n1 = await hollowNote();
  step('hollow detail starts at 1 mm, warns below it', d0 === 1 && !/Warning/.test(n0) && /Warning: detail under 1 mm/.test(n1), `detail ${d0}`);
  await page.screenshot({ path: join(OUT, 'hollow-1256.png') });
} catch (e) {
  fail++;
  console.log('FAIL stopped: ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
