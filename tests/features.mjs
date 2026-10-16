// The 2026-10-15 round, headless and muted: selection outline on round shapes, the camera inside
// a part, near and far planes, the bottom view, right drag held, the
// panel's flyouts, export of selected parts one file each, STEP import, a picture
// traced into a part, plate and background pictures, the theme builder, keyboard focus in
// menus, and screenshots at three window sizes. Screenshots go to .tmp/features; delete after.
// node tests/features.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { writeSTL, readMesh } from '../src/core/meshio.js';
import { report, describe } from '../src/core/meshcheck.js';
import { writeSTEP } from './stepfixture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const require = createRequire(import.meta.url);
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'features');
const PROFILE = join(OUT, 'chrome');
const DL = join(OUT, 'dl');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });
const findChrome = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findChrome(p); if (hit) return hit; } else if (e.name === 'chrome.exe') return p;
  }
  return null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a closed sphere and an open one (top cut off), 30 mm across
const sphere = (r, n, cutTop) => {
  const t = [];
  const P = (i, j) => { const th = Math.PI * i / n, ph = 2 * Math.PI * j / n; return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th) + r]; };
  for (let i = cutTop ? 2 : 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) t.push(...a, ...b, ...d);
    if (i < n - 1) t.push(...b, ...c, ...d);
  }
  return Float32Array.from(t);
};
const box = (x, y, z) => {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return Float32Array.from(f.flatMap(q => q.flatMap(i => v[i])));
};
const files = { ball: join(OUT, 'ball.stl'), cup: join(OUT, 'cup.stl'), step: join(OUT, 'brick.step'), png: join(OUT, 'disc.png') };
writeFileSync(files.ball, writeSTL(sphere(15, 40, false)));
writeFileSync(files.cup, writeSTL(sphere(15, 40, true)));
{ const w = writeSTEP(box(20, 10, 5), { name: 'brick' }); writeFileSync(files.step, Buffer.concat(w.chunks.map(c => Buffer.from(c)))); }

const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR), headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0;
const errors = [];
const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 260) : ''}`); };
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.setViewport({ width: 1256, height: 844 });
  await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
  const t0 = Date.now();
  await page.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  await page.waitForSelector('footer .msg');
  step('page loads', true, `${Date.now() - t0} ms to the page, ${(readFileSync(join(ROOT, 'Workingtitle3D.html')).length / 1048576).toFixed(1)} MB file`);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  const statusText = () => page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  const clearStatus = () => page.evaluate(() => { document.querySelector('footer .msg').textContent = ''; });
  const waitStatus = async (re, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { const s = await statusText(); if (re.test(s)) return s; await sleep(80); } return `TIMEOUT ${re}: ${await statusText()}`; };
  const click = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.offsetParent !== null || getComputedStyle(n).position === 'fixed')) { await e.click(); await sleep(150); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const shot = async name => { await sleep(300); await page.screenshot({ path: join(OUT, name + '.png') }); };
  const menuItem = async (m, item) => {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(100);
    if (!(await page.$('.menu.open'))) { const err = await page.evaluate(() => { const t = document.querySelector('.menubar .mtitle'); const r = t.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 5, r.top + 5); return top?.className + ' ' + top?.tagName + ' ' + (document.querySelector('dialog[open]')?.textContent || '').slice(0, 120); }); console.log('     (menu did not open; on top of it: ' + err + ')'); for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; } await sleep(100); }
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)).startsWith(item)) { await b.click(); await sleep(200); return; }
    throw new Error(`no menu item ${m} > ${item} (open: ${!!(await page.$('.menu.open'))}; ${(await page.$$eval('.menu.open .mlabel', l => l.map(x => x.textContent))).join(' | ')})`);
  };
  const closeFloatIf = async () => { const b = await page.$('.floatpanel h3 .btn'); if (b) { await b.click(); await sleep(100); } };
  const closeAsk = async () => { await sleep(150); for (const b of await page.$$('dialog[open] .btn')) { await b.click(); await sleep(150); break; } };
  const addShape = async name => { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', name); await sleep(300); await page.keyboard.press('Enter'); await closeAsk(); await sleep(600); };
  const settle = async () => { for (let i = 0; i < 100; i++) { const s = await statusText(); if (!/\.\.\.$/.test(s)) break; await sleep(100); } await sleep(300); };
  const fieldVal = l => page.$$eval('.inspector .field', (fs, l) => +fs.find(f => f.querySelector('label').textContent === l)?.querySelector('input')?.value, l);
  const setField = async (label, value) => {
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type(String(value)); await i.press('Enter'); await sleep(400); return;
    }
    throw new Error('no field ' + label);
  };
  const objOf = name => page.evaluate(n => { const v = document.getElementById('view').viewer; for (const [id, o] of v.objs) if (o.part?.name === n) return id; return null; }, name);
  // a point of a part's mesh on screen (local coords)
  const onScreen = (name, x, y, z) => page.evaluate((n, x, y, z) => {
    const v = document.getElementById('view').viewer, o = [...v.objs.values()].find(q => q.part?.name === n);
    o.group.updateMatrixWorld();
    const p = new o.mesh.position.constructor(x, y, z).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
  }, name, x, y, z);
  // pixels of the page: a screenshot read back in the page itself
  const pixels = async pts => {
    const b64 = await page.screenshot({ encoding: 'base64' });
    return page.evaluate(async (b64, pts) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0);
      return pts.map(([px, py]) => [...x.getImageData(Math.round(px), Math.round(py), 1, 1).data.slice(0, 3)]);
    }, b64, pts);
  };
  const near = (a, b, d = 40) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < d;
  const GLOW = [0x7d, 0xcf, 0x7d];

  // ---- the tab on load ------------------------------------------------------------------------------
  step('Shape tools is the tab on load', await page.$eval('.tabs button.on', b => b.textContent) === 'Shape tools');

  // ---- outline: a selected cone shows a line along its sloped sides, not only its base --------------
  await addShape('Cone');
  await page.click('.viewbtn[aria-label="Front"]'); await sleep(400);
  // the sloped sides seen face on: just outside the left edge, half way up
  const [lx, ly] = await onScreen('Cone 1', -5, 0, 10);
  const [cxp] = await onScreen('Cone 1', 0, 0, 10);
  const side = [];
  for (let k = 0; k < 8; k++) {
    const t = 0.15 + 0.08 * k;   // along the slope, from the base up
    const [x, y] = await onScreen('Cone 1', -10 * (1 - t), 0, 20 * t);
    side.push([x - 2, y], [x - 3, y]);
  }
  const lit = (await pixels(side)).filter(p => near(p, GLOW, 90)).length;
  await page.keyboard.press('Escape'); await sleep(300);
  const unlit = (await pixels(side)).filter(p => near(p, GLOW, 90)).length;
  await shot('1-cone-outline');
  step('cone outline along its sloped sides', lit >= 8 && unlit === 0, `${lit} of ${side.length} side points lit when selected, ${unlit} when not (left edge ${lx.toFixed(0)},${ly.toFixed(0)}, middle ${cxp.toFixed(0)})`);
  for (const s of ['Cylinder', 'Sphere', 'Torus']) await addShape(s);
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(400);
  await shot('1b-all-outlined');

  // ---- bottom view ----------------------------------------------------------------------------------
  await page.click('.viewbtn[aria-label="Bottom"]'); await sleep(400);
  const camZ = await page.evaluate(() => { const v = document.getElementById('view').viewer; return v.camera.position.z - v.controls.target.z; });
  await shot('2-bottom-view');
  step('Bottom view looks up from under the plate', camZ < 0, `camera ${camZ.toFixed(1)} mm below the target`);
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);

  // ---- far plane: zoomed far out, nothing is cut off at the back ------------------------------------
  const farOk = await page.evaluate(async () => {
    const v = document.getElementById('view').viewer;
    v.camera.position.set(9000, -12000, 8000); v.controls.update(); v.request();
    await new Promise(r => setTimeout(r, 300));
    const d = v.camera.position.length();
    return { far: v.camera.far, d, near: v.camera.near };
  });
  step('far plane follows the camera', farOk.far > farOk.d + 300, `camera ${farOk.d.toFixed(0)} mm out, far ${farOk.far.toFixed(0)}, near ${farOk.near.toFixed(2)}`);
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);

  // ---- camera inside a part: see-through, closed or open mesh --------------------------------------
  for (const [f, nm] of [[files.ball, 'ball'], [files.cup, 'cup']]) {
    await clearStatus();
    await (await page.$('input[type=file][multiple]')).uploadFile(f);
    await waitStatus(/Imported|ERROR/);
    await settle();
    const r = await page.evaluate(async n => {
      const v = document.getElementById('view').viewer;
      const [id, o] = [...v.objs].find(([, q]) => q.part?.name === n);
      const b = new o.mesh.position.constructor(); o.mesh.geometry.computeBoundingBox(); o.mesh.geometry.boundingBox.getCenter(b);
      o.group.updateMatrixWorld(); b.applyMatrix4(o.group.matrixWorld);
      v.controls.target.copy(b).add(new b.constructor(0, 5, 0)); v.camera.position.copy(b); v.controls.update();
      v.request(); await new Promise(r => setTimeout(r, 400)); v.request(); await new Promise(r => setTimeout(r, 300));
      const rc = new (v.ray({ clientX: 0, clientY: 0 }).constructor)(v.camera.position.clone(), v.controls.target.clone().sub(v.camera.position).normalize());
      const hits = rc.intersectObjects([...v.objs.values()].flatMap(q => [q.mesh, q.group.children[1]]), false).slice(0, 3).map(x => `${x.object.parent === o.group ? n : 'other'}:${x.object === o.mesh ? 'front' : 'back'}@${x.distance.toFixed(1)}`);
      return { inside: !!v.insideIds?.has(id), see: o.group.children[1].material === o.seeThrough, hits: hits.join(' '), cam: v.camera.position.toArray().map(x => +x.toFixed(1)) };
    }, nm);
    await shot(`3-inside-${nm}`);
    const mid = (await pixels([[628, 422]]))[0];
    step(`inside the ${nm} (${nm === 'cup' ? 'open' : 'closed'} mesh): see-through, not dark`, r.inside && r.see && !near(mid, [0x2d, 0x5a, 0x2d], 30), `${JSON.stringify(r)} centre pixel ${mid}`);
    await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(400);
    const out = await page.evaluate(n => { const v = document.getElementById('view').viewer; const [id] = [...v.objs].find(([, q]) => q.part?.name === n); return !v.insideIds?.has(id); }, nm);
    step(`out of the ${nm}: solid again`, out);
  }

  // ---- right drag: turns while held, stops on release (it acted as a toggle) ---------
  const camAt = () => page.evaluate(() => { const c = document.getElementById('view').viewer.controls; return +(c.getAzimuthalAngle() * 180 / Math.PI).toFixed(1); });
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(400);
  await page.mouse.move(500, 400); await sleep(100);
  const r0 = await camAt();
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 10; i++) { await page.mouse.move(500 + i * 12, 400); await sleep(20); }
  await page.mouse.up({ button: 'right' }); await sleep(500);
  const r1 = await camAt();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(620 - i * 12, 400 + i * 4); await sleep(20); }
  await sleep(400);
  const r2 = await camAt();
  step('right drag turns while held, stops on release', Math.abs(r1 - r0) > 5 && Math.abs(r2 - r1) < 0.5, `${r0} -> ${r1} -> ${r2}`);

  // ---- keyboard: menus open and walk with the keys; a focus frame shows ---------------------------
  await page.focus('.menubar .mtitle');
  await page.keyboard.press('ArrowDown'); await sleep(150);
  const inMenu = await page.evaluate(() => document.activeElement.classList.contains('mitem') && document.querySelector('.menu.open') !== null);
  await page.keyboard.press('ArrowDown'); await sleep(80);
  const moved = await page.evaluate(() => document.activeElement.textContent);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  await shot('4-menu-by-keys');
  await page.keyboard.press('Escape'); await sleep(100);
  const closed = await page.evaluate(() => !document.querySelector('.menu.open') && document.activeElement.classList.contains('mtitle'));
  step('menus by keyboard: down opens and walks, Esc closes, focus framed', inMenu && closed && ring !== 'none', `${moved}; outline ${ring}`);

  // ---- parts list: picking in the view marks the row and scrolls to it ----------------------------
  await click('.tabs button', 'Parts');
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(400);
  const [tx, ty] = await onScreen('Torus 1', 8, 0, 4);
  await page.mouse.click(tx, ty); await sleep(400);
  const rowOn = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, id = [...v.selected][0], name = v.objs.get(id)?.part.name;
    const r = document.querySelector('.partfly .prow.on'), l = r?.closest('.parts');
    if (!r) return { name };
    const a = r.getBoundingClientRect(), b = l.getBoundingClientRect();
    return { name, text: r.textContent, seen: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, rows: document.querySelectorAll('.partfly .prow.on').length };
  });
  await shot('5-parts-list');
  step('a pick in the view marks its row in the list', rowOn?.name && rowOn.text?.includes(rowOn.name) && rowOn.seen && rowOn.rows === 1, JSON.stringify(rowOn));

  // ---- export: selected parts, one file each, numbered from 0 ---------------------------------------
  await page.keyboard.down('Shift');
  for (const n of ['Cylinder 1', 'Sphere 1']) for (const r of await page.$$('.partfly .prow')) if ((await r.evaluate(x => x.textContent)).includes(n)) { await r.click(); await sleep(200); break; }
  await page.keyboard.up('Shift');
  // several selected: the triangles (and volume, size) are added up, not hidden
  const tot = await page.$$eval('.inspector .kv', els => { for (const e of els) { const t = e.innerText.split('\n'); const i = t.indexOf('triangles'); if (i >= 0) return +t[i + 1].replace(/\D/g, ''); } return null; });
  const want3 = await page.evaluate(() => { const v = document.getElementById('view').viewer; return [...v.selected].reduce((s, id) => s + v.objs.get(id).tris.length / 9, 0); });
  step('several selected: triangles added up', tot === want3 && want3 > 0, `${tot} shown, ${want3} in the parts`);
  await menuItem('File', 'Export...');
  await page.waitForSelector('dialog[open]');
  await click('dialog[open] .seg button', 'Selected');
  await click('dialog[open] .seg button', 'One each');
  await page.$eval('dialog[open] input.name-in', i => { i.value = ''; });
  await page.type('dialog[open] input.name-in', 'set');
  const note = await page.$eval('dialog[open] .note', e => e.textContent);
  await shot('6-export-dialog');
  await clearStatus();
  await click('dialog[open] .btn', 'Export');
  const es = await waitStatus(/Exported|ERROR/, 120000);
  await sleep(1500);
  const got = readdirSync(DL).filter(n => /^set-\d\.stl$/.test(n)).sort();
  const reps = got.map(n => { const b = readFileSync(join(DL, n)); return report(readMeshSync(n, b)); });
  step('export selected, one file each: set-0 to set-2', got.join() === 'set-0.stl,set-1.stl,set-2.stl' && reps.every(r => r.watertight) && /set-0\.stl to set-2\.stl/.test(note), `${got.join(', ')}; ${note}; ${es.slice(0, 120)}`);

  // ---- no STEP export: the dialog offers STL, 3MF and OBJ only --------------------------
  await menuItem('File', 'Export...');
  await page.waitForSelector('dialog[open]');
  const types = await page.$$eval('dialog[open] .seg', s => [...s[0].querySelectorAll('button')].map(b => b.textContent));
  await page.keyboard.press('Escape'); await sleep(200);
  step('export types: STL, 3MF, OBJ, no STEP', types.join() === 'STL,3MF,OBJ', types.join(', '));

  // ---- STEP import -------------------------------------------------------------------------------------
  await clearStatus();
  await (await page.$('input[type=file][multiple]')).uploadFile(files.step);
  const si = await waitStatus(/Imported|ERROR/, 120000);
  await settle();
  const sv = await page.$$eval('.inspector .kv', els => { for (const e of els) { const t = e.innerText.split('\n'); const i = t.indexOf('volume'); if (i >= 0) return t[i + 1]; } return null; });
  step('STEP import: a 20 x 10 x 5 brick', /Imported brick\.step/.test(si) && parseFloat(sv) === 1, `${si}; volume ${sv}`);

  // ---- a picture traced into a part --------------------------------------------------------------------
  const png = await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 200), x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#000000'; x.beginPath(); x.arc(100, 100, 80, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(100, 100, 30, 0, Math.PI * 2); x.fill();
    const b = await c.convertToBlob({ type: 'image/png' });
    return btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())));
  });
  writeFileSync(files.png, Buffer.from(png, 'base64'));
  await clearStatus();
  await (await page.$('input[type=file][multiple]')).uploadFile(files.png);
  await page.waitForSelector('dialog.picdlg[open]');
  await sleep(500);
  const pnote = await page.$$eval('dialog.picdlg .note', e => e[e.length - 1].textContent);
  await shot('7-picture-dialog');
  await click('dialog.picdlg .btn', 'Add part');
  const ps = await waitStatus(/Traced|ERROR/, 60000);
  await settle();
  const pv = await page.$$eval('.inspector .kv', els => { for (const e of els) { const t = e.innerText.split('\n'); const i = t.indexOf('volume'); if (i >= 0) return parseFloat(t[i + 1]); } return NaN; });
  const want = Math.PI * (40 * 40 - 15 * 15) * 2 / 1000;   // 200 px = 100 mm: ring 40 mm out, 15 mm in, 2 mm high
  step('picture traced into a ring part', /Traced/.test(ps) && Math.abs(pv - want) / want < 0.03 && /2 outlines/.test(pnote), `${pnote}; ${pv} cm3 vs ${want.toFixed(2)}`);

  // ---- plate picture and background picture -------------------------------------------------------------
  const chooser = async (fn, f) => { const [fc] = await Promise.all([page.waitForFileChooser(), fn()]); await fc.accept([f]); await sleep(700); };
  await menuItem('View', 'Plate picture...');
  await chooser(() => click('.floatpanel .btn', 'Pick a picture...'), files.png);
  const plateOn = await page.evaluate(() => !!document.getElementById('view').viewer.plateImg);
  await shot('8-plate-picture');
  step('plate picture lies on the plate', plateOn);
  await menuItem('View', 'Background picture...');
  await chooser(() => click('.floatpanel .btn', 'Pick a picture...'), files.png);
  for (const f of await page.$$('.floatpanel .field')) if ((await f.$eval('label', l => l.textContent)) === 'Tilt back') { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('30'); await i.press('Enter'); break; }
  await sleep(300);
  const bd = await page.evaluate(() => { const i = document.querySelector('#view .backdrop'); return { shown: i.style.display !== 'none', tf: i.style.transform, alpha: document.getElementById('view').viewer.renderer.getClearAlpha() }; });
  await shot('9-background-picture');
  step('background picture behind the view, tilted', bd.shown && /rotateX\(30deg\)/.test(bd.tf) && bd.alpha === 0, JSON.stringify(bd));

  // ---- theme builder: a color changes the app live; saved, loaded ---------------------------------------
  await menuItem('View', 'Theme builder...');
  await sleep(300);
  for (const b of await page.$$('.rolelist .citem')) if ((await b.evaluate(n => n.querySelector('.rn').textContent)) === 'Background') { await b.click(); break; }
  const hex = await page.$('.themepanel .hex-in');
  await hex.evaluate(i => { i.focus(); i.select(); }); await hex.type('#202820'); await hex.press('Enter'); await sleep(300);
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const marked = await page.$$eval('.themeprev.uses, .themeprev .uses', e => e.length);
  await shot('10-theme-builder');
  rmSync(DL, { recursive: true, force: true }); mkdirSync(DL, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await page.$eval('.themepanel input[type=checkbox]', c => { if (!c.checked) c.click(); });
  await click('.themepanel .btn', 'Save theme...');
  await sleep(1500);
  const tf = readdirSync(DL).find(n => n.endsWith('.wt3dtheme'));
  const theme = tf && JSON.parse(readFileSync(join(DL, tf), 'utf8'));
  step('theme builder: live change, preview marked, saved with picture', bg === '#202820' && marked >= 1 && theme?.colors['--bg'] === '#202820' && /^data:image/.test(theme?.background?.data || ''), `--bg ${bg}; ${marked} marked; file ${tf}`);
  await click('.themepanel .btn', 'Back to built-in');
  const bg2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  if (tf) await chooser(() => click('.themepanel .btn', 'Load theme...'), join(DL, tf));
  const bg3 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  step('theme: back to built-in, then loaded from the file', bg2 === '#0a0a0a' && bg3 === '#202820', `${bg2} then ${bg3}`);
  await click('.themepanel .btn', 'Back to built-in');
  await click('.floatpanel .btn', 'Close');
  await menuItem('View', 'Background picture...');
  await click('.floatpanel .btn', 'Remove');
  await click('.floatpanel .btn', 'Close');

  // ---- the wheel carries on through a surface, into the part ---------------------------------------
  await addShape('Box');
  await setField('Width', 40); await setField('Depth', 40); await setField('Height', 40);
  await setField('Center X', 0); await setField('Center Y', 0);
  await settle();
  await page.click('.viewbtn[aria-label="Front"]'); await sleep(400);
  const boxName = await page.evaluate(() => { const v = document.getElementById('view').viewer; return v.objs.get([...v.selected][0])?.part.name; });
  const [fx, fy] = await onScreen(boxName, 0, -20, 20);
  await page.mouse.move(fx, fy);
  for (let i = 0; i < 300; i++) {
    await page.mouse.wheel({ deltaY: -100 }); await sleep(8);
    if (await page.evaluate(() => document.getElementById('view').viewer.camera.position.y > -15)) break;   // past the front wall (y = -20)
  }
  await sleep(600);
  const thru = await page.evaluate(n => { const v = document.getElementById('view').viewer; const [id] = [...v.objs].find(([, o]) => o.part?.name === n); const c = v.camera.position; return { y: +c.y.toFixed(2), inside: !!v.insideIds?.has(id) }; }, boxName);
  await shot('12-zoomed-through');
  step('the wheel goes on through a surface into the part', thru.y > -20 && thru.inside, JSON.stringify(thru));
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);

  // ---- plate to the middle; bring in parts wholly off the plate ----------------------------------------
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.controls.target.set(700, -400, 0); v.camera.position.set(900, -700, 300); v.controls.update(); v.request(); });
  await page.click('.viewbtn[aria-label="Plate to the middle"]'); await sleep(400);
  const tg = await page.evaluate(() => document.getElementById('view').viewer.controls.target.toArray());
  step('Plate to the middle centres the plate', tg.every(v => Math.abs(v) < 1e-6), tg.join(', '));
  await setField('Center X', 900); await setField('Center Y', -50);   // wholly off the 600 x 600 plate
  await settle();
  const [ox] = [await fieldVal('Center X')];
  await page.click('.viewbtn[aria-label="Bring parts onto the plate"]'); await sleep(600);
  await settle();
  const bx1 = await fieldVal('Center X'), by1 = await fieldVal('Center Y');
  const bs = await statusText();
  await shot('13-brought-in');
  step('Bring in moves a part wholly off the plate just inside its edge', ox === 900 && Math.abs(bx1 - (300 - 5 - 20)) < 0.05 && by1 === -50 && /Brought onto the plate/.test(bs), `${ox} -> ${bx1}, ${by1}; ${bs}`);
  await page.click('.viewbtn[aria-label="Bring parts onto the plate"]'); await sleep(300);
  step('Bring in leaves parts on the plate alone', /nothing to bring in/.test(await statusText()), await statusText());

  // ---- sizes: the panel, both flyouts, the dialogs, at three window sizes -----------------------------
  for (const [w, hh] of [[1256, 844], [1920, 1080], [3440, 1440], [1000, 600], [900, 520], [1600, 650]]) {
    await page.setViewport({ width: w, height: hh });
    await sleep(400);
    await click('.tabs button', 'Parts');
    if (await page.$eval('.partfly', e => e.style.display === 'none')) await click('.tabs button', 'Parts');
    for (const r of await page.$$('.partfly .prow')) if ((await r.evaluate(x => x.textContent)).includes('Torus 1')) { await r.click(); break; }
    await sleep(300);
    await page.click('.inspector .colorbtn'); await sleep(300);
    const fit = await page.evaluate(() => {
      const a = document.querySelector('aside').getBoundingClientRect(), out = [];
      for (const s of ['.partfly', '.colorfly']) { const r = document.querySelector(s).getBoundingClientRect(); if (r.right > a.left + 0.5 || r.bottom > innerHeight + 0.5 || r.top < 0) out.push(s); }
      if (document.documentElement.scrollWidth > innerWidth) out.push('page scrolls sideways');
      const p = document.querySelector('.partfly').getBoundingClientRect(), c = document.querySelector('.colorfly').getBoundingClientRect();
      if (c.right > p.left + 0.5) out.push('color list over the parts list');
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const tl = document.querySelector('.overlay.tl').getBoundingClientRect(), bl = document.querySelector('.overlay.bl').getBoundingClientRect(), cb = document.querySelector('.overlay.cutbar').getBoundingClientRect();
      if (hit(tl, bl)) out.push('view buttons run into the move steps');
      if (hit(bl, cb)) out.push('move steps run into the cut bar');
      return out;
    });
    await shot(`11-size-${w}x${hh}`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.querySelector('aside .pane:not([style*="none"])').scrollTo(0, 9999));
    await shot(`11-size-${w}x${hh}-scrolled`);
    step(`fits at ${w} x ${hh}`, !fit.length, fit.join(', '));
  }
  await page.setViewport({ width: 1256, height: 844 });

  // ---- Cut here: a box split at X into two closed parts, snapped to the move step -----------------------
  await addShape('Box');
  await setField('Center X', 0); await setField('Center Y', 0); await settle();
  const boxN = await page.evaluate(() => { const v = document.getElementById('view').viewer; return v.objs.get([...v.selected][0]).part.name; });
  await click('.cutbar button', 'X'); await sleep(300);
  for (const f of await page.$$('.cutbar .field')) { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('3.3'); await i.press('Enter'); break; }
  await sleep(300);
  const at = await page.$eval('.cutbar .field input', i => +i.value);
  await click('.cutbar .btn', 'Cut here');
  const cs = await waitStatus(/Cut at|ERROR|does not/, 60000);
  await settle();
  const halves = await page.evaluate(n => [...document.getElementById('view').viewer.objs.values()].filter(o => o.part.name.startsWith(n + ' ')).map(o => o.part.name), boxN);
  await shot('17-cut-here');
  await click('.cutbar button', 'Off');
  step('Cut here splits the part in two closed parts; the cut snaps to the step', at === 3 && halves.length === 2 && /split in two/.test(cs), `at ${at}; ${halves.join(', ')}; ${cs}`);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await settle();
  if (await page.$eval('.partfly', e => e.style.display === 'none')) await click('.tabs button', 'Parts');
  for (const r of await page.$$('.partfly .prow')) if ((await r.evaluate(x => x.textContent)).includes(boxN)) { await r.click(); break; }
  await sleep(300);
  // tool settings open in place, under Steps; the hollow box says Detail
  await click('.inspector .btn', 'Hollow');
  await sleep(300);
  const inPlace = await page.evaluate(() => { const c = [...document.querySelectorAll('.inspector .card')].find(x => /Hollow/.test(x.textContent)); return !!c && /Detail/.test(c.textContent) && !/Resolution/.test(c.textContent); });
  await click('aside .btn', 'Cancel');
  step('tool settings open in the part options, Detail not Resolution', inPlace);
  // View > Key bindings: a Keys tab beside Parts
  await menuItem('View', 'Key bindings');
  await sleep(300);
  const keysOn = await page.evaluate(() => { const b = document.querySelector('.tabs [data-v="keys"]'); return b.style.display !== 'none' && b.classList.contains('on') && /Ctrl \+ Z/.test(document.querySelector('aside').textContent); });
  await shot('18-keys-tab');
  await menuItem('View', 'Key bindings');
  const keysOff = await page.evaluate(() => document.querySelector('.tabs [data-v="keys"]').style.display === 'none');
  step('View > Key bindings shows a Keys tab, and hides it again', keysOn && keysOff);

  // ---- turning point: after a pan the view turns about what is in the middle, not empty space ----------
  const pivot = await page.evaluate(() => { const v = document.getElementById('view').viewer; v.controls.target.set(0, 0, 80); v.camera.position.set(150, -200, 230); v.controls.update(); v.request(); return true; });
  void pivot;
  await page.mouse.move(500, 400); await page.mouse.down({ button: 'right' }); await page.mouse.move(540, 400, { steps: 4 }); await page.mouse.up({ button: 'right' }); await sleep(400);
  const tz = await page.evaluate(() => { const v = document.getElementById('view').viewer; return +v.controls.target.z.toFixed(3); });
  step('turning starts about the middle of the screen (part or plate), not a point in the air', tz < 40, `target z ${tz} (was 80, in the air)`);
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);

  // ---- hollow: no open switch; faces clicked are openings, several allowed ---------------------------------
  await addShape('Box');
  await setField('Width', 40); await setField('Depth', 30); await setField('Height', 20); await settle();
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);
  await click('.inspector .btn', 'Hollow');
  await sleep(300);
  const noSwitch = await page.evaluate(() => ![...document.querySelectorAll('.inspector label')].some(l => /Open through/.test(l.textContent)));
  for (const [x, y, z] of [[0, 0, 20], [20, 0, 10]]) {   // top, and the +X side
    const bn = await page.evaluate(() => { const v = document.getElementById('view').viewer; return v.objs.get([...v.selected][0]).part.name; });
    const [sx, sy] = await onScreen(bn, x - (x ? 0.5 : 0), y, z - (z === 20 ? 0.5 : 0) + (x ? 0 : 0));
    await page.mouse.click(sx, sy); await sleep(300);
  }
  const facesPicked = await statusText();
  await page.$$eval('.inspector .field', fs => { const f = fs.find(x => x.querySelector('label').textContent === 'Detail'); const i = f.querySelector('input'); i.value = '0.5'; i.dispatchEvent(new Event('change')); });
  await sleep(200);
  await click('aside .btn', 'Apply');
  const hs2 = await waitStatus(/added to|ERROR|did not/, 180000);
  await settle();
  step('hollow: no switch, two picked faces open', noSwitch && /2 faces picked/.test(facesPicked) && /added to/.test(hs2), `${facesPicked}; ${hs2}`);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await settle();

  // ---- busy bar: shows and moves while work runs, gone after ---------------------------------------------
  await addShape('Box');
  await click('.inspector .btn', 'Hollow');
  await click('aside .btn', 'Apply');
  await sleep(600);
  const busyOn = await page.evaluate(() => { const f = document.querySelector('footer'), i = f.querySelector('.busybar i'); return { busy: f.classList.contains('busy'), moving: i.getAnimations().some(a => a.playState === 'running') }; });
  await shot('16-busy-bar');
  await waitStatus(/added to|ERROR/, 120000); await sleep(600);
  const busyOff = await page.evaluate(() => document.querySelector('footer').classList.contains('busy'));
  step('busy bar runs while a hollow works, gone after', busyOn.busy && busyOn.moving && !busyOff, `${JSON.stringify(busyOn)}, after ${busyOff}`);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await sleep(300);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await settle();

  // ---- 2026-10-16 round two -----------------------------------------------------------------------------
  if (await page.$eval('.partfly', e => e.style.display === 'none')) await click('.tabs button', 'Parts');
  await page.click('.viewbtn[aria-label="Fit (F)"]'); await sleep(300);
  const names = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].map(o => o.part.name));
  // the cut works on the selected parts only
  for (const r of await page.$$('.partfly .prow')) if ((await r.evaluate(x => x.textContent)).includes('Torus 1')) { await r.click(); break; }
  await sleep(300);
  await click('.cutbar button', 'X'); await sleep(400);
  const cutInfo = await page.evaluate(() => { const v = document.getElementById('view').viewer; const out = {}; for (const [, o] of v.objs) if (o.body) out[o.part.name] = !!o.body.clippingPlanes; return { cut: out, insideOpacity: v.mats.inside.opacity }; });
  await shot('14-cut-selected');
  await click('.cutbar button', 'Off');
  step('cut view cuts only the selected part; its inside barely there', cutInfo.cut['Torus 1'] && Object.entries(cutInfo.cut).filter(([n]) => n !== 'Torus 1').every(([, c]) => !c) && cutInfo.insideOpacity < 0.3, JSON.stringify(cutInfo).slice(0, 200));
  // Hide other parts acts at once (needs a part with history: change the torus once)
  await setField('Diameter', 24); await settle();
  await page.$$eval('.inspector label.check', ls => ls.find(l => l.textContent.includes('Hide other parts'))?.querySelector('input').click());
  await sleep(400);
  const solo = await page.evaluate(() => { const v = document.getElementById('view').viewer; return [...v.objs.values()].filter(o => o.group.visible).map(o => o.part.name); });
  await page.$$eval('.inspector label.check', ls => ls.find(l => l.textContent.includes('Hide other parts'))?.querySelector('input').click());
  await sleep(300);
  const shownBack = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(o => o.group.visible).length);
  step('Hide other parts hides the others at once, and back', solo.length === 1 && solo[0] === 'Torus 1' && shownBack === names.length, `${solo.join(', ')}; then ${shownBack} shown`);
  // grouping: the parts stay shown, striped, until the group is built
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(200);
  const stripes = page.evaluate(() => new Promise(res => { const v = document.getElementById('view').viewer; const t0 = performance.now(); let seen = 0, minShown = 1e9;
    const tick = () => { if (v.busy?.size) seen = Math.max(seen, v.busy.size); minShown = Math.min(minShown, [...v.objs.values()].filter(o => o.group.visible).length); if (performance.now() - t0 < 4000) requestAnimationFrame(tick); else res({ seen, minShown }); }; tick(); }));
  await page.keyboard.down('Control'); await page.keyboard.press('g'); await page.keyboard.up('Control');
  const st = await stripes;
  await settle();
  step('while a group builds its parts stay on screen, striped', st.seen > 0 && st.minShown > 0, JSON.stringify(st));
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await settle();
  // the same file imported twice: a second part with its own name, beside the first
  await clearStatus();
  await (await page.$('input[type=file][multiple]')).uploadFile(files.ball); await waitStatus(/Imported|ERROR/); await settle();
  const balls = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(o => /^ball/.test(o.part.name)).map(o => [o.part.name, o.part.xform.pos[0], o.part.xform.pos[1]]));
  step('same file twice: its own name, not on top', balls.length === 2 && balls[0][0] !== balls[1][0] && (balls[0][1] !== balls[1][1] || balls[0][2] !== balls[1][2]), JSON.stringify(balls));
  // plate picture mirror; theme picker by click; the panel drags
  await menuItem('View', 'Plate picture...');
  await chooser(async () => { const b = await page.$('.floatpanel .row .btn'); await b.click(); }, files.png);
  await page.$$eval('.floatpanel label.check', ls => ls.find(l => l.textContent.includes('Mirror left to right'))?.querySelector('input').click());
  await sleep(300);
  const mir = await page.evaluate(() => document.getElementById('view').viewer.plateImg?.scale.x < 0);
  step('plate picture mirrors', mir);
  await click('.floatpanel .btn', 'Remove');
  await menuItem('View', 'Theme builder...');
  await sleep(300);
  const bg0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glow').trim());
  const fr = await page.$eval('.themepanel .cpick', e => { const r = e.getBoundingClientRect(); return [r.left + r.width * 0.3, r.top + r.height * 0.4]; });
  await page.mouse.click(fr[0], fr[1]); await sleep(300);
  const bg1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glow').trim());
  const w0 = await page.$eval('.themepanel', e => [e.offsetLeft, e.offsetTop]);
  const hb = await page.$eval('.themepanel h3', e => { const r = e.getBoundingClientRect(); return [r.left + 40, r.top + 8]; });
  await page.mouse.move(hb[0], hb[1]); await page.mouse.down(); await page.mouse.move(hb[0] + 200, hb[1] + 120, { steps: 6 }); await page.mouse.up(); await sleep(200);
  const w1 = await page.$eval('.themepanel', e => [e.offsetLeft, e.offsetTop]);
  const selText = await page.evaluate(() => String(getSelection()));
  await shot('15-theme-picker-moved');
  step('theme: a click in the picker sets the color; the window drags, no text selected', bg0 !== bg1 && w1[0] - w0[0] > 150 && w1[1] - w0[1] > 80 && !selText, `${bg0} -> ${bg1}; ${w0} -> ${w1}`);
  await click('.themepanel .btn', 'Back to built-in');
  await click('.floatpanel .btn', 'Close');
  // every menu item: nothing throws (dialogs closed with Esc)
  const errs0 = errors.length;
  for (const m of ['File', 'Edit', 'View']) {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(80);
    const labels = await page.$$eval('.menu.open .mitem:not(:disabled) .mlabel', l => l.map(x => x.textContent));
    await page.keyboard.press('Escape');
    for (const l of labels) {
      if (/^(New|Import|Theme builder|Background|Plate|Keys)/.test(l)) continue;   // tested above, or opens a file chooser
      try { await menuItem(m, l); } catch { continue; }
      await sleep(250);
      await sleep(700);
      for (let k = 0; k < 6 && (await page.$('dialog[open]')); k++) { await page.keyboard.press('Escape'); await sleep(200); }
      await closeFloatIf();
    }
  }
  step('every menu item runs without an error', errors.length === errs0, errors.slice(errs0).join(' | '));

  // ---- autosave with no folder access (Firefox, Safari, Brave): kept in the browser, back on reload --
  await menuItem('File', 'Save as project...');
  await page.waitForSelector('dialog[open] input.name-in');
  const askText = await page.$eval('dialog[open]', d => d.textContent);
  await page.$eval('dialog[open] input.name-in', i => { i.value = ''; });
  await page.type('dialog[open] input.name-in', 'Auto test');
  await click('dialog[open] .btn', 'Save');
  await waitStatus(/Saving Auto test in this browser|ERROR/);
  await addShape('Wedge');
  await sleep(1500);
  const before = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].map(o => o.part.name).sort());
  const label = await page.title();
  await page.reload();
  await page.waitForSelector('footer .msg'); await sleep(1200);
  const emptyAfter = await page.evaluate(() => document.getElementById('view').viewer.objs.size);
  await menuItem('File', 'Reopen Auto test'); await page.waitForSelector('dialog[open]'); await click('dialog[open] .btn', 'Reopen');
  const reo = await waitStatus(/Opened Auto test|ERROR/, 60000);
  await settle(); await sleep(1500);
  const after = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].map(o => o.part.name).sort());
  step('autosave in browser storage: reload starts empty, Reopen brings it back', emptyAfter === 0 && /in this browser/.test(askText) && /saved/.test(label) && /Opened Auto test/.test(reo) && after.join() === before.join() && after.includes('Wedge 1'),
    `${label}; ${reo}; ${after.length} parts back of ${before.length}`);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await sleep(1200);
  await page.reload();
  await sleep(1200); await menuItem('File', 'Reopen Auto test'); await page.waitForSelector('dialog[open]'); await click('dialog[open] .btn', 'Reopen');
  await waitStatus(/Opened Auto test|ERROR/, 60000);
  await settle(); await sleep(1000);
  const afterUndo = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].map(o => o.part.name));
  step('autosave keeps undo too', !afterUndo.includes('Wedge 1') && afterUndo.length === before.length - 1, `${afterUndo.length} parts`);
  await menuItem('File', 'Open...');
  await page.waitForSelector('dialog[open] .projlist');
  const listed = await page.$$eval('dialog[open] .projlist .btn', b => b.map(x => x.textContent));
  const other = await page.$$eval('dialog[open] .btn', b => b.some(x => x.textContent === 'Other folder...'));
  await click('dialog[open] .btn', 'Cancel');
  step('Open lists the projects kept in the browser', listed.includes('Auto test') && !other, listed.join(', '));
} catch (e) {
  fail++;
  console.log('FAIL stopped: ' + e.message);
  await browser.pages().then(p => p[p.length - 1].screenshot({ path: join(OUT, 'stopped.png') })).catch(() => {});
} finally {
  await browser.close();
}
function readMeshSync(name, b) {
  // STL only here
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), n = dv.getUint32(80, true), t = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) t[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
  return t;
}
void readMesh;
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
