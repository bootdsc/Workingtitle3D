// Walk through every function of the built page, headless and muted (no window, no mouse
// taken): every shape, every part command and key, every tool, open meshes, every file
// type in and out, the project file. Complements tests/browser.mjs. Screenshots go to
// .tmp/walk; delete them after.
// node tests/walk.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { writeSTL, writeOBJ, write3MF, readMesh } from '../src/core/meshio.js';
import { report, describe } from '../src/core/meshcheck.js';
import { unpackProject } from '../src/core/project.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'walk');
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

// test meshes: a sphere with a hole (open), and closed boxes as OBJ and 3MF
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
const files = {
  holed: join(OUT, 'holed.stl'), obj: join(OUT, 'block.obj'), tmf: join(OUT, 'block.3mf'),
};
// a holed sphere plus a Moebius strip: a strip has one side, so no repair can close it and
// the part stays open
const sheet = (() => {
  const t = [], n = 40, P = (i, s) => { const a = 2 * Math.PI * i / n, w = s * 3; return [30 + (8 + w * Math.cos(a / 2)) * Math.cos(a), (8 + w * Math.cos(a / 2)) * Math.sin(a), 10 + w * Math.sin(a / 2)]; };
  for (let i = 0; i < n; i++) { const a = P(i, -1), b = P(i, 1), c = P(i + 1, -1), d = P(i + 1, 1); t.push(...a, ...c, ...b, ...b, ...c, ...d); }
  return Float32Array.from(t);
})();
const holedT = sphere(15, 48, true), both = new Float32Array(holedT.length + sheet.length);
both.set(holedT); both.set(sheet, holedT.length);
writeFileSync(files.holed, writeSTL(both));
writeFileSync(files.obj, writeOBJ(box(12, 8, 6)));
writeFileSync(files.tmf, write3MF(box(10, 10, 4)));

const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR), headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0;
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('dialog', d => d.dismiss());
  await page.setViewport({ width: 1366, height: 768 });
  // no folder access, so nothing asks for a project folder: files only
  await page.evaluateOnNewDocument(() => { window.showSaveFilePicker = undefined; window.showDirectoryPicker = undefined; });
  await page.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  const statusText = () => page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  const clearStatus = () => page.evaluate(() => { document.querySelector('footer .msg').textContent = ''; });
  const waitStatus = async (re, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = await statusText(); if (re.test(s)) return s; await sleep(80); }
    return `TIMEOUT waiting for ${re}; status: ${await statusText()}`;
  };
  const click = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.offsetParent !== null)) { await e.click(); await sleep(120); return true; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const has = async (sel, text) => { for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text) return true; return false; };
  const shot = async name => { await sleep(300); await page.screenshot({ path: join(OUT, name + '.png') }); };
  // a menu item: open the menu by its title, click the item by its label
  const menuItem = async (m, item) => {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(100);
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)) === item) { await b.click(); await sleep(150); return; }
    throw new Error(`no menu item ${m} > ${item}`);
  };
  const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + String(info).slice(0, 220) : ''}`); };
  const parts = () => page.$$eval('.prow', r => r.map(x => x.textContent));
  const keys = async (...k) => { for (const x of k) await page.keyboard.down(x); for (const x of [...k].reverse()) await page.keyboard.up(x); await sleep(200); };
  const field = async (label, value) => {
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input');
      await i.click({ clickCount: 3 }); await i.type(String(value)); await i.press('Enter');
      await sleep(400);
      return;
    }
    throw new Error('no field ' + label);
  };
  const kv = async name => page.$$eval('.inspector .kv', (els, name) => {
    for (const e of els) { const t = e.innerText.split('\n'); const i = t.indexOf(name); if (i >= 0) return t[i + 1]; }
    return null;
  }, name);
  const vol = async () => parseFloat((await kv('volume')) || 'NaN');
  const tris = async () => parseInt(((await kv('triangles')) || 'NaN').replace(/[^\d]/g, ''), 10);
  const settle = async () => { for (let i = 0; i < 100; i++) { const s = await statusText(); if (!/\.\.\.$/.test(s)) break; await sleep(100); } await sleep(300); };
  const selectRow = async (name, add = false) => {
    for (const r of await page.$$('.prow')) if ((await r.evaluate(n => n.textContent)).includes(name)) {
      if (add) await page.keyboard.down('Shift');
      await (await r.$('.pname') || r).click();
      if (add) await page.keyboard.up('Shift');
      await sleep(250);
      return;
    }
    throw new Error('no row ' + name);
  };
  // the first change asks about a project folder (folder access is off here): say OK once
  const closeAsk = async () => { await sleep(150); for (const b of await page.$$('dialog[open] .btn')) { await b.click(); await sleep(150); break; } };
  const addShape = async name => { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', name); await sleep(300); await page.keyboard.press('Enter'); await closeAsk(); await click('.tabs button', 'Parts'); await settle(); };
  const upload = async (sel, file) => { await (await page.$(sel)).uploadFile(file); };
  const download = async (name, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = readdirSync(DL).find(n => n === name || (n.startsWith(name.replace(/\.[^.]+$/, '')) && n.endsWith(name.slice(name.lastIndexOf('.'))) && !n.endsWith('.crdownload'))); if (f && existsSync(join(DL, f))) { await sleep(300); return join(DL, f); } await sleep(150); }
    return null;
  };

  // ---- every shape --------------------------------------------------------------------------
  const kinds = ['Box', 'Cylinder', 'Cone', 'Sphere', 'Torus', 'Wedge', 'Tube'];
  for (const k of kinds) await addShape(k);
  await settle();
  const p0 = await parts();
  const bad0 = (await statusText()).startsWith('ERROR');
  step('every shape adds', p0.length === kinds.length && !bad0, p0.join(' | '));
  const vols = [];
  for (const k of kinds) { await selectRow(`${k} 1`); vols.push(await vol()); }
  step('every shape has a volume', vols.every(v => v > 0), vols.join(', '));
  await selectRow('Sphere 1');
  const vs0 = await vol();
  await field('Diameter', 30);
  await settle();
  const vs1 = await vol();
  step('a size field rebuilds the shape', vs1 > vs0 * 3, `${vs0} -> ${vs1} cm3`);
  await shot('1-shapes');

  // ---- place on a face: a cylinder dropped on the box's top sits on it, and slides on it
  await selectRow('Box 1'); await field('Center X', 60); await field('Center Y', 60);
  await click('.tabs button', 'Shape tools'); await click('.shapes .btn', 'Cylinder'); await sleep(500);
  const top = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, o = [...v.objs.values()].find(x => x.part?.name === 'Box 1');
    o.group.updateMatrixWorld();
    const c = new o.mesh.position.constructor(0, 0, 20).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
  });
  await page.mouse.move(top[0] + 3, top[1] + 3); await sleep(200);
  await page.mouse.click(top[0] + 3, top[1] + 3); await sleep(800);
  await click('.tabs button', 'Parts'); await settle();
  const bz = await page.$$eval('.inspector .field', fs => +fs.find(f => f.querySelector('label').textContent === 'Bottom Z').querySelector('input').value);
  await keys('ArrowRight'); await settle();
  const bz2 = await page.$$eval('.inspector .field', fs => +fs.find(f => f.querySelector('label').textContent === 'Bottom Z').querySelector('input').value);
  step('place on a face, slide along it', Math.abs(bz - 20) < 0.05 && Math.abs(bz2 - 20) < 0.05 && (await parts()).length === kinds.length + 1, `bottom Z ${bz} then ${bz2}`);
  await keys('Delete'); await settle();

  // ---- part commands ------------------------------------------------------------------------
  await keys('Control', 'a');
  await click('.inspector .btn', 'Group');
  await settle();
  step('group from the panel', (await parts()).length === 1 && !(await statusText()).startsWith('ERROR'), (await parts()).join(' | '));
  step('Ungroup button on a selected group', await has('.inspector .btn', 'Ungroup'));
  await click('.inspector .btn', 'Ungroup');
  await settle();
  step('ungroup from the panel', (await parts()).length === kinds.length, (await parts()).length);

  // align: two parts, Z max lines their tops up; Ungroup greyed with no group selected
  await selectRow('Box 1'); await selectRow('Cone 1', true);
  const ugOff = await page.$$eval('.inspector .btn', bs => bs.find(b => b.textContent === 'Ungroup')?.disabled);
  const rows = await page.$$('.inspector .row.align');
  for (const b of await rows[0].$$('.btn')) if ((await b.evaluate(n => n.textContent)) === 'Left') { await b.click(); break; }   // X: Left (was Min)
  await settle();
  const xs = [];
  for (const nm of ['Box 1', 'Cone 1']) { await selectRow(nm); xs.push(await page.$$eval('.inspector .field', fs => { const f = fs.find(f => /^(Width|Diameter|Bottom diameter)$/.test(f.querySelector('label').textContent)); const c = fs.find(f => f.querySelector('label').textContent === 'Center X'); return [+c.querySelector('input').value, +(f?.querySelector('input').value || 0)]; })); }
  const left = xs.map(([c, w]) => c - w / 2);
  step('align X min lines up the left sides; Ungroup greyed', ugOff === true && Math.abs(left[0] - left[1]) < 1e-3, `${left.join(' vs ')}, ungroup disabled ${ugOff}`);
  await keys('Control', 'z'); await settle();

  // intersect: box and sphere on the same spot
  await selectRow('Box 1'); await field('Center X', 0); await field('Center Y', 0);
  await selectRow('Sphere 1'); await field('Center X', 0); await field('Center Y', 0);
  await selectRow('Box 1'); await selectRow('Sphere 1', true);
  await keys('Control', 'i');
  await settle();
  const vi = await vol();
  step('intersect keeps the overlap', vi > 0 && vi <= 8.0001, `${vi} cm3; ${await statusText()}`);
  await keys('Control', 'z'); await settle();

  await selectRow('Cylinder 1');
  await keys('h'); await settle();
  step('H makes a hole', (await parts()).some(t => t.includes('Cylinder 1') && /hole/i.test(t)));
  await keys('s'); await settle();
  step('S makes it solid again', (await parts()).some(t => t.includes('Cylinder 1') && !/hole/i.test(t)));

  await selectRow('Cone 1');
  const n0 = (await parts()).length;
  await keys('Control', 'd'); await settle();
  step('Ctrl+D duplicates', (await parts()).length === n0 + 1);
  await keys('Control', 'c'); await keys('Control', 'v'); await settle();
  step('Ctrl+C, Ctrl+V pastes', (await parts()).length === n0 + 2);
  await keys('Delete'); await settle();
  step('Delete removes', (await parts()).length === n0 + 1);
  await selectRow('Wedge 1');
  const wv = await vol();
  await keys('m'); await settle();
  step('M mirrors and keeps the volume', Math.abs((await vol()) - wv) < 0.01 && !(await statusText()).startsWith('ERROR'), `${wv} -> ${await vol()}`);
  await keys('Control', 'h'); await settle();
  const hidden = await page.evaluate(() => { const v = document.getElementById('view').viewer; return [...v.objs.values()].filter(o => !o.group.visible).length; });
  await keys('Control', 'Shift', 'h'); await settle();
  const hidden2 = await page.evaluate(() => { const v = document.getElementById('view').viewer; return [...v.objs.values()].filter(o => !o.group.visible).length; });
  step('Ctrl+H hides, Ctrl+Shift+H shows', hidden >= 1 && hidden2 === 0, `${hidden} then ${hidden2}`);
  await selectRow('Torus 1');
  await keys('Control', 'l'); await settle();
  const cx0 = await page.$eval('.inspector .field input', i => i.value).catch(() => null);
  await keys('ArrowRight'); await settle();
  const lockedNote = await page.$$eval('.inspector .note', ns => ns.some(n => /Locked/.test(n.textContent)));
  step('Ctrl+L locks', lockedNote, cx0);
  await keys('Control', 'l'); await settle();

  // ---- views and the cut ----------------------------------------------------------------------
  for (const v of ['Top', 'Front', 'Left', 'Right', 'Fit (F)']) { await page.click(`.viewbtn[aria-label="${v}"]`); await sleep(100); }
  step('view buttons', !(await statusText()).startsWith('ERROR'));
  await click('.cutbar button', 'X'); await sleep(300);
  await shot('2-cut-x');
  await click('.cutbar button', 'Off');
  step('cut view on and off', !(await statusText()).startsWith('ERROR'));

  // ---- tools ----------------------------------------------------------------------------------
  await selectRow('Box 1');
  await field('Width', 30).catch(() => {});
  const bv = await vol();
  await click('.inspector .btn', 'Hollow');
  await click('aside .btn', 'Apply');
  const hs = await waitStatus(/added to|ERROR/);
  await settle();
  step('hollow', /added to/.test(hs) && (await vol()) < bv, `${bv} -> ${await vol()}; ${hs}`);
  await selectRow('Sphere 1');
  const st0 = await tris();
  await click('.inspector .btn', 'Simplify');
  await click('aside .check', 'Preserve surface').catch(async () => { for (const c of await page.$$('aside input[type=checkbox]')) await c.click(); });
  await click('aside .btn', 'Preview');
  const sp = await waitStatus(/preview ready|ERROR/);
  await click('aside .btn', 'Apply');
  await waitStatus(/added to|ERROR/);
  await settle();
  const st1 = await tris();
  step('simplify', st1 < st0 && /triangles/.test(sp), `${st0} -> ${st1}; ${sp}`);
  const stepRows = await page.$$('.inspector .steprow');
  if (stepRows.length) { await (await stepRows[stepRows.length - 1].$('.btn')).click(); await settle(); }
  step('remove a step', (await tris()) === st0, `${await tris()}`);
  await shot('3-tools');

  // ---- open mesh: import, group, hole, repair ---------------------------------------------------
  await clearStatus();
  await upload('input[accept*=".stl"]', files.holed);
  const im = await waitStatus(/Imported|ERROR/);
  await settle();
  step('open STL imports with a note', /Imported holed/.test(im) && !im.startsWith('ERROR'), im);
  const openNote = await page.$$eval('.inspector .note', ns => ns.some(n => /Not closed/.test(n.textContent)));
  const toolsOnOpen = await page.$$eval('.inspector .row.wrap .btn', b => b.map(x => x.textContent));
  // fault highlight: off by default, on shows yellow marks and names the faults
  for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === 'View') { await t.click(); break; }
  const offAtStart = await page.$$eval('.menu.open .mitem', bs => bs.find(b => b.textContent.includes('Show faults')).getAttribute('aria-checked') === 'false');
  await page.keyboard.press('Escape');
  await menuItem('View', 'Show faults');
  await sleep(500);
  const fs = await statusText();
  const marks = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(o => o.faults?.visible && o.faults.children.length).length);
  await shot('3b-faults');
  await menuItem('View', 'Show faults');
  step('show faults: off by default, marks the open mesh', offAtStart && marks === 1 && /holed: .*open/.test(fs), `${marks} marked; ${fs}`);
  step('open mesh: every tool offered', openNote && ['Repair', 'Simplify', 'Hollow', 'Edge shaper'].every(t => toolsOnOpen.includes(t)), toolsOnOpen.join(', '));
  await field('Center X', 0); await field('Center Y', 0);
  await selectRow('Cylinder 1'); await field('Center X', 0); await field('Center Y', 0); await keys('h');
  await selectRow('holed'); await selectRow('Cylinder 1', true);
  await clearStatus();
  await keys('Control', 'g');
  const tg = Date.now();
  for (let i = 0; i < 1200 && Number.isNaN(await vol()); i++) await sleep(100);
  const gs = await statusText();
  console.log(`     (group with an open mesh took ${((Date.now() - tg) / 1000).toFixed(1)} s)`);
  step('open mesh grouped with a hole cuts', !gs.startsWith('ERROR') && (await vol()) > 0, `${gs}; vol ${await vol()}`);
  await keys('Control', 'z'); await settle();
  await selectRow('holed');
  await click('.inspector .btn', 'Repair');
  await click('aside .btn', 'Preview');
  const rp = await waitStatus(/preview ready|ERROR/);
  step('repair leaves the sheet open, says so', /Still not closed/.test(rp), rp);
  await page.$$eval('aside input[type=checkbox]', cs => cs.find(c => c.closest('label')?.textContent.includes('Make solid'))?.click());
  await sleep(200);
  await click('aside .btn', 'Apply');
  const ra = await waitStatus(/added to|ERROR/, 120000);
  await settle();
  const stillOpen = await page.$$eval('.inspector .note', ns => ns.some(n => /Not closed/.test(n.textContent)));
  step('repair, make solid', /added to/.test(ra) && !stillOpen, ra);
  await shot('4-repaired');

  // ---- other file types in --------------------------------------------------------------------
  await clearStatus();
  await upload('input[accept*=".stl"]', files.obj);
  const io = await waitStatus(/Imported|ERROR/);
  await clearStatus();
  await upload('input[accept*=".stl"]', files.tmf);
  const i3 = await waitStatus(/Imported|ERROR/);
  step('OBJ and 3MF import', /Imported block\.obj/.test(io) && /Imported block\.3mf/.test(i3), `${io} | ${i3}`);

  // ---- export, every type, read back ----------------------------------------------------------
  for (const f of ['STL', '3MF', 'OBJ']) {
    rmSync(DL, { recursive: true, force: true }); mkdirSync(DL, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    await clearStatus();
    await menuItem('File', 'Export...');
    await page.waitForSelector('dialog[open]');
    await click('dialog[open] .seg button', f);
    await click('dialog[open] .seg button', 'All');   // a part is selected: the dialog starts on Selected
    await click('dialog[open] .btn', 'Export');
    const es = await waitStatus(/Exported|ERROR/, 120000);
    const file = await download('model.' + f.toLowerCase());
    let rb = null;
    if (file) { const b = readFileSync(file); rb = report(await readMesh(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.length))); }
    step(`export ${f}, read back`, /Exported/.test(es) && rb && rb.triangles > 0, `${es.slice(0, 120)} | ${rb ? describe(rb) + ', ' + rb.triangles + ' tris' : 'no file'}`);
  }

  // ---- project file: save, open, import ---------------------------------------------------------
  rmSync(DL, { recursive: true, force: true }); mkdirSync(DL, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  const before = await parts();
  await menuItem('File', 'Save file...');
  const pf = await download('Untitled.wt3d');
  let pk = null;
  if (pf) { const b = readFileSync(pf); pk = await unpackProject(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
  step('save a .wt3d', pk && pk.snap.parts.length === before.length, `${pk ? pk.snap.parts.length + ' parts, ' + pk.blobs.size + ' meshes' : 'no file'}`);
  if (pf) {
    await keys('Control', 'a'); await keys('Delete'); await settle();
    await clearStatus();
    await upload('input[accept=".wt3d"]', pf);
    await page.waitForSelector('dialog[open]', { timeout: 3000 }).then(() => click('dialog[open] .btn', 'Drop them')).catch(() => {});
    const op = await waitStatus(/Opened|ERROR/);
    await settle();
    const after = await parts();
    step('open the .wt3d: same parts', after.length === before.length && /Opened/.test(op), `${op}`);
    const repaired = after.find(t => t.includes('holed'));
    await selectRow('holed');
    const stepsBack = await page.$$eval('.inspector .steprow', r => r.map(x => x.textContent));
    step('the repair step comes back', stepsBack.some(t => /Repair/.test(t)), stepsBack.join(' | ') || repaired);
    await clearStatus();
    await upload('input[accept*=".stl"]', pf);
    const ip = await waitStatus(/Imported|ERROR/);
    await settle();
    step('import a .wt3d adds its parts', (await parts()).length === before.length * 2, ip);
  }

  // ---- panel, undo all --------------------------------------------------------------------------
  await closeAsk();
  await click('aside .fold', '▴');
  const folded = await page.$eval('#app', a => a.classList.contains('folded'));
  await click('aside .fold', '▾');
  step('panel rolls up and down', folded && !(await page.$eval('#app', a => a.classList.contains('folded'))));
  for (let i = 0; i < 120; i++) await keys('Control', 'z');
  await settle();
  step('undo all the way back', !(await statusText()).startsWith('ERROR'), `${(await parts()).length} parts left; ${await statusText()}`);
  await shot('5-end');
} catch (e) {
  fail++;
  console.log('FAIL walk stopped: ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
