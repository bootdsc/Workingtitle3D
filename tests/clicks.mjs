// One click is one click: buttons in the panel and the color list act on the first press, also
// right after typing in a field (the panel used to rebuild between press and release, so every
// button needed two). Real mouse presses, headless and muted.
// node tests/clicks.mjs [page.html]   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const PAGE = resolve(ROOT, process.argv[2] || 'Workingtitle3D.html');
const OUT = join(ROOT, '.tmp', 'clicks'), PROFILE = join(OUT, 'chrome');
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
  await page.goto(pathToFileURL(PAGE).href);
  await page.waitForSelector('footer .msg');
  // a person's click: press, a short hold, release
  const press = async el => {
    await el.evaluate(n => n.scrollIntoView({ block: 'nearest' })); await sleep(100);
    const b = await el.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(250);
  };
  const find = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.getClientRects().length > 0)) return e;
    throw new Error(`no ${sel} "${text}"`);
  };
  const typeIn = async (label, value) => {
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input'); await press(i); await i.type(String(value)); return;   // left in the field, no Enter
    }
    throw new Error('no field ' + label);
  };
  const statusText = () => page.$eval('footer .msg', e => e.textContent);

  await press(await find('.tabs button', 'Shape tools')); await press(await find('.shapes .btn', 'Box'));
  await page.keyboard.press('Enter'); await sleep(300);
  for (const b of await page.$$('dialog[open] .btn')) { await b.click(); await sleep(300); break; }   // the first-change question
  await sleep(500);
  await press(await find('.tabs button', 'Parts')); await sleep(300);

  // color: open the list, one press on a color
  if (process.env.CLICK_DEBUG) await page.evaluate(() => {
    window.__log = [];
    const ins = document.querySelector('.inspector');
    new MutationObserver(() => window.__log.push('inspector rebuilt')).observe(ins, { childList: true });
    for (const t of ['pointerdown', 'pointerup', 'click', 'focusout']) document.addEventListener(t, e => window.__log.push(`${t} ${e.target.className || e.target.tagName} in-aside:${!!e.target.closest?.('aside')}`), true);
  });
  // the button reads "Color"; the color's name is in its tooltip
  const colorNow = () => page.$eval('.inspector .colorbtn', b => b.title.replace(/^Color: (.*?)\. .*$/, '$1'));
  await press(await find('.inspector .colorbtn', 'Color'));
  if (process.env.CLICK_DEBUG) console.log(await page.evaluate(() => window.__log.join('\n')));
  step('color list opens with one press', await page.$eval('.colorfly', e => e.style.display !== 'none'));
  await press(await find('.colorfly .citem', 'Orange'));
  step('color set by one press', (await colorNow()) === 'Orange', await colorNow());
  // again, straight after typing a size and leaving it in the field
  await typeIn('Width', 25);
  await press(await find('.inspector .colorbtn', 'Color'));
  const listOpen = await page.$eval('.colorfly', e => e.style.display !== 'none');
  if (listOpen) await press(await find('.colorfly .citem', 'Gray (default)'));
  step('after typing: color list opens and sets by one press each', listOpen && (await colorNow()) === 'Gray', `list ${listOpen ? 'opened' : 'did not open'}`);

  // a step: open it with one press, type a width, then one press on Apply
  await press(await find('.inspector .btn', 'Edge shaper'));
  const opened = !!(await page.$('.inspector .card .section'));
  step('Edge shaper opens with one press', opened);
  if (opened) {
    await typeIn('Width into the face', 3);
    if (process.env.CLICK_DEBUG) await page.evaluate(() => { window.__log = []; });
    await press(await find('.inspector .card .btn', 'Apply'));
    if (process.env.CLICK_DEBUG) console.log('APPLY:\n' + await page.evaluate(() => window.__log.join('\n')));
    let s = '';
    for (let i = 0; i < 60; i++) { s = await statusText(); if (/added to/.test(s)) break; await sleep(200); }
    step('Apply works with one press, right after typing', /added to/.test(s), s);
  }
  // a face clicked while a hollow is working is not picked: the openings stay as they were sent
  // (on a sphere: a box is flat, hollowed exactly and at once, so nothing would be running)
  await press(await find('.tabs button', 'Shape tools')); await press(await find('.shapes .btn', 'Sphere'));
  await page.keyboard.press('Enter'); await sleep(800);
  await press(await find('.tabs button', 'Parts')); await sleep(300);
  await press(await find('.inspector .btn', 'Hollow'));
  await typeIn('Detail', 0.15); await page.keyboard.press('Enter'); await sleep(200);
  await press(await find('.inspector .card .btn', 'Preview'));
  // click while it is working: wait for the status to say so (a fixed wait raced a fast hollow)
  for (let i = 0; i < 100 && !/\.\.\.$/.test(await statusText()); i++) await sleep(20);
  const during = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, [id] = [...v.selected];
    v.onPick(id, 0, { shiftKey: false });
    return { msg: document.querySelector('footer .msg').textContent, line: [...document.querySelectorAll('.inspector .card .note')].map(n => n.textContent).find(t => /Closed|opening/.test(t)) };
  });
  step('a face click during a hollow run is refused', /faces are locked/.test(during.msg) && /^Closed/.test(during.line || ''), `${during.msg} | ${during.line}`);
} catch (e) {
  fail++;
  console.log('FAIL stopped: ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
