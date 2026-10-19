// Path > Delete (K): a stretch out of an open line splits it in two; out of a loop, the loop opens;
// U takes it back; on the 3D frame an edge goes (and a point left with no edge). Also the color
// button reads "Color" with a chip. Real mouse presses, headless and muted; screenshots in
// .tmp/pathdelete at 1256x844 and 1920x1080.
// node tests/pathdelete.mjs [page.html]   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const PAGE = resolve(ROOT, process.argv[2] || 'Workingtitle3D.html');
const OUT = join(ROOT, '.tmp', 'pathdelete');
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
// a fresh browser profile per window size, so a setting switched on in one run (3D path) starts off in the next
const launch = PROFILE => puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR), headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0, browser = null;
const errors = [];
const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); };
try {
  for (const [W, H] of [[1256, 844], [1920, 1080]]) {
    if (browser) await browser.close();
    browser = await launch(join(OUT, `chrome-${W}`));
    const page = await browser.newPage();
    console.log(`-- ${W}x${H}`);
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
    await page.setViewport({ width: W, height: H });
    await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
    await page.goto(pathToFileURL(PAGE).href);
    await page.waitForSelector('footer .msg');
    await sleep(800);
    const shot = name => page.screenshot({ path: join(OUT, `${W}x${H}-${name}.png`) });
    const status = () => page.$eval('footer .msg', e => e.textContent);
    const click = async (x, y) => { await page.mouse.move(x, y); await sleep(60); await page.mouse.down(); await sleep(40); await page.mouse.up(); await sleep(150); };
    const dialogs = async () => { for (const b of await page.$$('dialog[open] .btn')) { await b.click(); await sleep(300); break; } };
    // the view's middle, left of the panel
    const aside = await page.$eval('aside', a => a.getBoundingClientRect().left);
    const cx = Math.round(aside / 2), cy = Math.round(H / 2);
    const key = async k => { await page.keyboard.press(k); await sleep(250); };

    // an open line of three stretches, then Delete on the middle one
    await key('p');
    await key('l');
    const L = [[cx - 150, cy + 60], [cx - 50, cy + 60], [cx + 50, cy + 60], [cx + 150, cy + 60]];
    for (const [x, y] of L) await click(x, y);
    await key('f'); await sleep(400); await dialogs(); await sleep(400);
    const added = await status();
    await key('k');
    await page.mouse.move(cx, cy + 60); await sleep(300);
    const hover = await status();
    await shot('1-delete-hover');
    await click(cx, cy + 60); await sleep(500);
    const split = await status();
    step('open line: middle stretch splits it in two', /split in two/.test(split), `${added} | ${hover} | ${split}`);
    await shot('2-delete-split');
    await key('u'); await sleep(500);
    step('U takes the delete back', /taken back/.test(await status()), await status());

    // an end stretch shortens the line
    await page.mouse.move(cx - 100, cy + 60); await sleep(200);
    await click(cx - 100, cy + 60); await sleep(500);
    step('end stretch shortens the line', /shortened/.test(await status()), await status());

    // a rectangle (a loop) opens where a side is deleted
    await key('r');
    await click(cx - 100, cy - 140); await click(cx + 100, cy - 40); await sleep(500);
    await key('k');
    // on the plate the rectangle is not square on screen: only its clicked corners sit where clicked
    await page.mouse.move(cx - 97, cy - 138); await sleep(200);
    await click(cx - 97, cy - 138); await sleep(500);
    step('loop opens where a side is deleted', /opened there/.test(await status()), await status());

    // 3D frame: switch 3D path on from View, draw two edges, delete the first
    await key('Escape'); await sleep(300);
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === 'View') { await t.click(); break; }
    await sleep(200);
    let on = false;
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)).startsWith('3D path')) { await b.click(); on = true; break; }
    await sleep(400);
    if (on) {
      await key('p'); await key('3');
      const F = [[cx - 150, cy + 160], [cx, cy + 160], [cx, cy + 260]];
      for (const [x, y] of F) await click(x, y);
      await key('n');
      await key('k');
      await page.mouse.move(cx - 75, cy + 160); await sleep(300);
      await shot('3-frame-hover');
      await click(cx - 75, cy + 160); await sleep(400);
      step('frame: an edge and its lone point go', /Deleted from the frame: 1 point, 1 edge/.test(await status()), await status());
      await key('u'); await sleep(300);
      step('frame: U brings them back', /taken back/.test(await status()), await status());
      await key('Escape');
    } else step('3D path switch found in View', false);

    // the color button: a part selected, the inspector shows "Color" with a chip
    await page.mouse.click(cx + 150, cy + 60); await sleep(600);   // the shortened line's far end
    const cb = await page.$eval('.inspector .colorbtn', b => ({ text: b.textContent, chip: !!b.querySelector('.chip'), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })).catch(() => null);
    step('color button reads Color with a chip, one line high', cb && cb.text === 'Color' && cb.chip && cb.h < 34, JSON.stringify(cb));
    await shot('4-color-button');

    // the Path list goes back against the panel when the color list or the parts list shuts
    await key('p'); await sleep(300);
    const pathRight = () => page.$eval('.pathfly', e => Math.round(e.getBoundingClientRect().right));
    const r0 = await pathRight();
    await page.click('.inspector .colorbtn'); await sleep(300);
    const rColor = await pathRight();
    const side = await page.evaluate(() => ({ colorRight: Math.round(document.querySelector('.colorfly').getBoundingClientRect().right), pathLeft: Math.round(document.querySelector('.pathfly').getBoundingClientRect().left) }));
    step('color list opens left of the Path list, not under it', side.colorRight <= side.pathLeft, JSON.stringify(side));
    await shot('5-path-and-color');
    await page.keyboard.press('Escape'); await sleep(300);
    const r1 = await pathRight();
    for (const t of await page.$$('.tabs button')) if ((await t.evaluate(n => n.textContent.trim())) === 'Parts') { await t.click(); break; }
    await sleep(400);
    const partsOpen = await page.$eval('.partfly', e => e.style.display !== 'none');
    const rParts = await pathRight();
    await shot('6-path-and-parts');
    if (partsOpen) { await page.$eval('.partfly', e => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await sleep(300); }
    const r2 = await pathRight();
    step('Path list back against the panel after the color and parts lists shut', r1 === r0 && r2 === r0, `path right ${r0}; color open ${rColor}, shut ${r1}; parts ${partsOpen ? 'open' : 'did not open'} ${rParts}, shut ${r2}`);
    await page.close();
  }
} catch (e) { fail++; console.log('FAIL ' + e.stack); }
if (browser) await browser.close();
for (const e of errors) console.log(e);
const ok = !fail && !errors.length;
console.log(ok ? 'VERDICT all passed' : `VERDICT ${fail} failed, ${errors.length} page errors`);
process.exit(ok ? 0 : 1);
