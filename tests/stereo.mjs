// Stereo view: halves on whole device pixels, eye separation on the screen, the right half a mirror
// with the right eye's picture, input on it acting on the real app; frame cost mono against stereo.
// Headless and muted; screenshots to .tmp/stereo, delete after.
// node tests/stereo.mjs [model.3mf for the timing]   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const MODEL = process.argv[2];
const OUT = join(ROOT, '.tmp', 'stereo'), PROFILE = join(OUT, 'chrome');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const findChrome = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) { const h = findChrome(p); if (h) return h; } else if (e.name === 'chrome.exe') return p; } return null; };
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
  const click = async (sel, text) => { for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.getClientRects().length > 0)) { await e.click(); await sleep(200); return; } throw new Error(`no ${sel} "${text}"`); };
  const menuItem = async (m, item) => {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(150);
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)) === item) { await b.click(); await sleep(400); return; }
    throw new Error(`no menu item ${m} > ${item}`);
  };
  await click('.tabs button', 'Shape tools'); await click('.shapes .btn', 'Sphere'); await page.keyboard.press('Enter'); await sleep(400);
  for (const b of await page.$$('dialog[open] .btn')) { await b.click(); break; }
  await sleep(600);

  const geom = () => page.evaluate(() => {
    const dpr = devicePixelRatio, a = document.getElementById('app').getBoundingClientRect(), m = document.querySelector('.stereo-mirror');
    const v = document.getElementById('view'), r = v.getBoundingClientRect(), c = v.viewer.renderer.domElement;
    const dx = m ? new DOMMatrix(getComputedStyle(m).transform).m41 : 0;
    return { dpr, L: a.left * dpr, W: a.width * dpr, H: a.height * dpr, R: (a.left + dx) * dpr, vw: innerWidth * dpr, buf: [c.width, c.height], view: [r.width * dpr, r.height * dpr], css: [parseFloat(c.style.width) * dpr, parseFloat(c.style.height) * dpr], sep: dx * dpr };
  });
  const check = async (label, eyeSep) => {
    const g = await geom();
    // (a transform's place comes back through floats: 2.9999998 for 3 at 2.625; a thousandth of a pixel)
    const whole = [g.L, g.W, g.H, g.R].every(x => Math.abs(x - Math.round(x)) < 1e-3);
    const line = g.R - (g.L + g.W) >= 1 - 1e-3;
    const sepWant = Math.max(g.W + 1, Math.round((eyeSep / 25.4) * 96 * g.dpr));
    const exact = Math.abs(g.buf[0] - Math.round(g.view[0])) < 1e-6 && Math.abs(g.buf[1] - Math.round(g.view[1])) < 1e-6 && Math.abs(g.css[0] - g.buf[0]) < 1e-3 && Math.abs(g.css[1] - g.buf[1]) < 1e-3;
    step(`${label}: halves on whole device px, a line between, middles ${eyeSep} mm apart or touching, drawn at exactly the view's device size`,
      whole && line && Math.abs(g.sep - sepWant) <= 1 && exact, JSON.stringify({ ...g, sepWant }));
    return g;
  };

  await menuItem('View', 'Stereo');
  await sleep(800);
  const on = await page.evaluate(() => document.body.classList.contains('stereo') && document.querySelector('.stereo-mirror')?.children.length > 0);
  step('View > Stereo: the page in two halves, the right one a mirror', on);
  const g1 = await check('1256x844, 1', 63);
  // the right half's view holds the right eye: something drawn, and not the same as the left
  const eyes = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.stereo-mirror canvas')].find(c => c.width === document.getElementById('view').viewer.renderer.domElement.width);
    if (!m) return null;
    const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data;
    let lit = 0, sx = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 60) { lit++; sx += (i / 4) % m.width; }
    return { lit, cx: lit ? sx / lit : 0, w: m.width };
  });
  step('the right half shows the right eye\'s picture', eyes && eyes.lit > 1000, JSON.stringify(eyes));
  // goggles: the eyes look the same way (no pitch in), each picture centred on its own half (no
  // frustum shift), no up or down shift anywhere, and the left to right shift of a point 15 mm
  // nearer or 2 m beyond the turning point a few percent of a half's width, close up and far off
  for (const dist of [60, 400]) {
    const d = await page.evaluate(dist => {
      const v = document.getElementById('view').viewer, cam = v.camera, t = v.controls.target, was = cam.position.clone();
      cam.position.sub(t).setLength(dist).add(t); cam.updateMatrixWorld(); v.drawFrame();
      const R = v.eyeR;
      if (!R) { cam.position.copy(was); cam.updateMatrixWorld(); v.drawFrame(); return null; }
      const dir = cam.position.clone().sub(t).normalize();
      const pts = [t.clone(), t.clone().addScaledVector(dir, 15), t.clone().addScaledVector(dir, -2000), t.clone().add(cam.up.clone().multiplyScalar(10))];
      const shift = pts.map(p => { const l = p.clone().project(cam), r = p.clone().project(R); return [+((r.x - l.x) / 2 * 100).toFixed(2), +((r.y - l.y) / 2 * v.renderer.domElement.height).toFixed(3)]; });
      const centred = [cam, R].every(c => Math.abs(c.projectionMatrix.elements[8]) < 1e-9 && Math.abs(c.projectionMatrix.elements[9]) < 1e-9);
      const parallel = R.quaternion.angleTo(cam.quaternion) < 1e-6;   // (acos of 1 within float rounding)
      const apart = +R.position.distanceTo(cam.position).toFixed(3);
      cam.position.copy(was); cam.updateMatrixWorld(); v.drawFrame();
      return { shift, centred, parallel, apart };
    }, dist);
    if (!d) { step(`stereo at ${dist} mm`, false, 'no right eye camera (viewer.eyeR)'); continue; }
    const [focus, near, far] = d.shift;
    step(`stereo at ${dist} mm: eyes parallel, pictures centred, no up/down shift, small left/right shift`,
      d.parallel && d.centred && d.shift.every(([, y]) => Math.abs(y) < 0.5) && Math.abs(Math.abs(focus[0]) - 2) < 0.01 && Math.abs(near[0]) < 4 && Math.abs(far[0]) < 2,
      JSON.stringify({ ...d, shift: { focus, near, far } }));
  }
  await page.screenshot({ path: join(OUT, 'stereo-1256.png') });

  // the pointer in both eyes: drawn twice, the real one hidden; over a panel the two match, over the
  // model the right one moves with the model's depth; over the right half it is the same pointer;
  // outside both halves the real one is back
  const ptrs = () => page.evaluate(() => {
    const d = [...document.querySelectorAll('.stereo-ptr')].map(p => ({ shown: p.style.display !== 'none', x: new DOMMatrix(getComputedStyle(p).transform).m41, y: new DOMMatrix(getComputedStyle(p).transform).m42, img: p.style.backgroundImage.length }));
    return { d, real: getComputedStyle(document.body).cursor, dx: new DOMMatrix(getComputedStyle(document.querySelector('.stereo-mirror')).transform).m41 };
  });
  const btn = await page.evaluate(() => { const b = [...document.querySelectorAll('#app .shapes .btn')].find(n => n.textContent.trim() === 'Box'); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(btn[0], btn[1]); await sleep(150);
  const onPanel = await ptrs();
  step('pointer over a panel: drawn in both halves, same place in each, real one hidden',
    onPanel.d.every(p => p.shown && p.img) && Math.abs(onPanel.d[1].x - onPanel.d[0].x - onPanel.dx) < 0.01 && onPanel.d[1].y === onPanel.d[0].y && onPanel.real === 'none', JSON.stringify(onPanel));
  await page.mouse.move(btn[0] + onPanel.dx, btn[1]); await sleep(150);
  const onRight = await ptrs();
  step('pointer over the right half: the same pointer', Math.abs(onRight.d[0].x - onPanel.d[0].x) < 0.01 && Math.abs(onRight.d[1].x - onPanel.d[1].x) < 0.01, JSON.stringify(onRight));
  const mid = await page.evaluate(() => { const r = document.getElementById('view').viewer.renderer.domElement.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(mid[0], mid[1]); await sleep(300);
  const onModel = await ptrs();
  const want = await page.evaluate(([x, y]) => {
    const v = document.getElementById('view').viewer, r = v.renderer.domElement.getBoundingClientRect();
    const at = v.placeHit({ clientX: x, clientY: y }).point, a = at.clone().project(v.controls.object), b = at.clone().project(v.eyeR);
    return ((b.x - a.x) / 2) * r.width;
  }, mid);
  const got = onModel.d[1].x - onModel.d[0].x - onModel.dx;
  step('pointer over the model: the right one moved by the depth there', Math.abs(want) > 1 && Math.abs(got - want) < 0.01, `moved ${got.toFixed(2)} px, model there ${want.toFixed(2)} px`);
  // (at this size the halves fill the window: the one pixel line between them is outside both)
  const gap = await page.evaluate(() => { const a = document.getElementById('app').getBoundingClientRect(), dx = new DOMMatrix(getComputedStyle(document.querySelector('.stereo-mirror')).transform).m41; return (a.right + a.left + dx) / 2; });
  await page.mouse.move(gap, 300); await sleep(150);
  const outside = await ptrs();
  step('pointer outside both halves: drawn ones gone, the real one back', outside.d.every(p => !p.shown) && outside.real !== 'none', JSON.stringify(outside));

  // input on the right half acts on the real app: its Shape tools tab, then Box
  const mirrorClick = async (sel, text) => {
    const pt = await page.evaluate((sel, text) => {
      const m = document.querySelector('.stereo-mirror');
      const el = [...m.querySelectorAll(sel)].find(n => n.textContent.trim() === text && n.getClientRects().length);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, sel, text);
    if (!pt) throw new Error(`no ${sel} "${text}" in the right half`);
    await page.mouse.click(pt[0], pt[1]); await sleep(500);
  };
  const n0 = await page.evaluate(() => document.getElementById('view').viewer.objs.size);
  await mirrorClick('.tabs button', 'Shape tools');
  await mirrorClick('.shapes .btn', 'Box');
  await page.keyboard.press('Enter'); await sleep(900);
  const n1 = await page.evaluate(() => document.getElementById('view').viewer.objs.size);
  step('clicks on the right half work the real app (Shape tools, Box)', n1 === n0 + 1, `${n0} -> ${n1} parts`);

  // presets and other screens
  await menuItem('View', 'Stereo settings...');
  await click('.pop .seg button', '1/2'); await sleep(600);
  const g2 = await check('1256x844, 1/2', 63);
  step('1/2: each half half as wide as at 1 (whole device px)', g2.W === Math.floor(g1.W / 2), `${g1.W} -> ${g2.W}`);
  await page.screenshot({ path: join(OUT, 'stereo-half-1256.png') });
  await click('.pop .seg button', '1'); await sleep(400);
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(800);
  await check('1920x1080, 1', 63);
  await page.screenshot({ path: join(OUT, 'stereo-1920.png') });
  await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 2.625 }); await sleep(900);
  await check('phone 915x412 at 2.625, 1', 63);
  await page.screenshot({ path: join(OUT, 'stereo-phone.png') });
  await page.setViewport({ width: 1256, height: 844, deviceScaleFactor: 1 }); await sleep(600);

  // frame cost: the part alone, fitted, mono against stereo (headless draws on the CPU: compare, do not quote as fps)
  const cost = label => page.evaluate(async label => {
    const v = document.getElementById('view').viewer, gl = v.renderer.getContext();
    v.view(null, [...v.objs.keys()].slice(-1)); v.controls.update();
    // reading a pixel back makes the frame really finish before the clock stops
    const px = new Uint8Array(4);
    const run = () => { const t0 = performance.now(); for (let i = 0; i < 8; i++) { v.drawFrame(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } return (performance.now() - t0) / 8; };
    run();
    return `${label}: ${run().toFixed(1)} ms a frame`;
  }, label);
  const timing = async name => {
    await menuItem('View', 'Stereo'); await sleep(500);
    const mono = await cost(`${name} mono`);
    await menuItem('View', 'Stereo'); await sleep(800);
    const st = await cost(`${name} stereo`);
    console.log(`     ${mono} | ${st}`);
  };
  await page.evaluate(() => { const v = document.getElementById('view').viewer; for (const id of [...v.objs.keys()]) v.onPick(id, 0, { shiftKey: false }); });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Delete'); await sleep(500);
  // about a million triangles: a sphere of 1414 facets round
  await click('.tabs button', 'Shape tools'); await click('.shapes .btn', 'Sphere'); await page.keyboard.press('Enter'); await sleep(600);
  await click('.tabs button', 'Parts');
  for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === 'Facets') { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('1414'); await i.press('Enter'); break; }
  for (let i = 0; i < 200 && /\.\.\.$/.test(await page.$eval('footer .msg', e => e.textContent)); i++) await sleep(200);
  await sleep(3000);
  const tris = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].reduce((s, o) => s + o.tris.length / 9, 0));
  await timing(`sphere ${tris.toLocaleString('en-US')} tris`);
  if (MODEL && existsSync(MODEL)) {
    await page.keyboard.press('Delete'); await sleep(400);
    await (await page.$('input[type=file][multiple]')).uploadFile(MODEL);
    await sleep(2500);
    await page.evaluate(() => { const v = document.getElementById('view').viewer; const [id] = [...v.objs.keys()]; v.onPick(id, 0, { shiftKey: false }); });
    await sleep(400);
    await click('.tabs button', 'Parts');
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === 'Height') { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('30'); await i.press('Enter'); break; }
    await sleep(1200);
    await click('.inspector .btn', 'Edge shaper');
    for (const [l, val] of [['Width into the face', 10], ['Height down the side', 10]]) for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', x => x.textContent)) === l) { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type(String(val)); await i.press('Enter'); await sleep(800); break; }
    await click('.inspector .card .btn', 'Apply');
    for (let i = 0; i < 300 && !/Edge shaper added/.test(await page.$eval('footer .msg', e => e.textContent)); i++) await sleep(200);
    await sleep(1500);
    await click('.inspector .btn', 'Hollow'); await click('.inspector .card .btn', 'Apply');
    for (let i = 0; i < 300 && !/Hollow added/.test(await page.$eval('footer .msg', e => e.textContent)); i++) await sleep(200);
    await sleep(3000);
    const t2 = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].reduce((s, o) => s + o.tris.length / 9, 0));
    await timing(`zero2 filleted and hollowed, ${t2.toLocaleString('en-US')} tris`);
  }
  await menuItem('View', 'Stereo'); await sleep(400);
  step('Stereo off: the page whole again', await page.evaluate(() => !document.body.classList.contains('stereo') && !document.querySelector('.stereo-mirror') && document.getElementById('app').style.width === ''));
} catch (e) {
  fail++;
  console.log('FAIL stopped: ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
