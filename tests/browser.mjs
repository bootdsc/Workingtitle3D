// Drive the built page headless and muted (no window on screen, no sound): add shapes, make a
// hole, group, add a fillet step, undo/redo, import an STL, drag a part, export by download
// and read the file back. Screenshots go to .tmp/browser for a look; delete them after.
// node tests/browser.mjs
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { extrude, rect, circle } from './shapes.mjs';
import { writeSTL, readSTL } from '../src/core/meshio.js';
import { report, describe } from '../src/core/meshcheck.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Needs puppeteer-core and a Chrome for Testing build, given by environment:
//   PUPPETEER_DIR  a folder whose node_modules holds puppeteer-core
//   CHROME_DIR     a folder that contains chrome.exe (searched recursively)
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) {
  console.log('Set PUPPETEER_DIR and CHROME_DIR to run the browser test.');
  process.exit(2);
}
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'browser');
const PROFILE = join(OUT, 'chrome');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'dl'), { recursive: true });
function findChrome(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const hit = findChrome(p); if (hit) return hit; } else if (e.name === 'chrome.exe') return p;
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const part = join(OUT, 'plate.stl');
writeFileSync(part, writeSTL(extrude(rect(-30, -15, 30, 15), [circle(-15, 0, 6)], 0, 8)));

const browser = await puppeteer.launch({
  executablePath: findChrome(process.env.CHROME_DIR),
  headless: true, userDataDir: PROFILE,
  env: { ...process.env, TEMP: OUT, TMP: OUT, APPDATA: join(PROFILE, 'appdata'), LOCALAPPDATA: join(PROFILE, 'local') },
  args: ['--mute-audio', '--no-first-run', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-crash-reporter', '--disable-breakpad'],
});
let fail = 0;
const errors = [];
let page, server;
try {
  page = await browser.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`); });
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(OUT, 'dl') });
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });

  const statusText = () => page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  const waitStatus = async (re, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = await statusText(); if (re.test(s)) return s; await sleep(80); }
    throw new Error(`timed out waiting for ${re}; status: ${await statusText()}`);
  };
  const click = async (sel, text) => {
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text) { await e.click(); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const shot = async name => { await sleep(400); await page.screenshot({ path: join(OUT, name + '.png') }); };
  // a menu item: open the menu by its title, click the item by its label
  const menuItem = async (m, item) => {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(100);
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)) === item) { await b.click(); await sleep(150); return; }
    throw new Error(`no menu item ${m} > ${item}`);
  };
  const step = (name, ok, info = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); };
  const parts = () => page.$$eval('.prow', r => r.map(x => x.textContent));
  const field = async (label, value) => {
    const inputs = await page.$$('.inspector .field');
    for (const f of inputs) if ((await f.$eval('label', l => l.textContent)) === label) {
      const i = await f.$('input');
      await i.click(); await i.type(String(value)); await i.press('Enter');
      await sleep(300);   // the inspector rebuilds once focus leaves it
      return;
    }
    throw new Error('no field ' + label);
  };
  // shapes live on the Shape tools tab; come back to Parts, where the options are
  const addShape = async name => { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', name); await sleep(300); await page.keyboard.press('Enter'); await click('.tabs button', 'Parts'); };
  const keys = async (...k) => { for (const x of k) await page.keyboard.down(x); for (const x of k.reverse()) await page.keyboard.up(x); await sleep(150); };

  await shot('0-empty');
  await addShape('Box');
  await page.waitForSelector('dialog[open]');
  await shot('1-folder-ask');
  await click('dialog .btn', 'Cancel');
  await addShape('Cylinder');
  await sleep(500);
  step('two shapes', (await parts()).length === 2, (await parts()).join(' | '));

  // cylinder: a hole through the box centre, taller than the box
  await field('Center X', 0); await field('Center Y', 0);
  await field('Diameter', 16); await field('Height', 30); await field('Bottom Z', -5);
  await keys('h');
  step('hole', (await parts()).some(t => t.includes('Cylinder 1') && t.includes('hole')));
  await keys('Control', 'a');
  await keys('Control', 'g');
  await sleep(1000);
  const p1 = await parts();
  step('group', p1.length === 1 && p1[0].includes('Group'), p1.join(' | '));
  const vol = async () => +(await page.$eval('.inspector .kv', e => e.textContent.match(/([\d.]+) cm3/)?.[1] || 'NaN'));
  const v1 = await vol();
  const hole64 = 0.5 * 64 * 64 * Math.sin((2 * Math.PI) / 64) * 20;   // 64-sided cylinder, d 16, through 20 mm
  step("group volume = box minus hole", Math.abs(v1 - (8000 - hole64) / 1000) < 0.01, `${v1} cm3 vs ${((8000 - hole64) / 1000).toFixed(2)}`);
  await shot('2-group');
  step('group shows Ungroup', await page.$$eval('.inspector button', bs => bs.some(b => b.textContent === 'Ungroup')));

  // fillet step on the group
  await click('.inspector .btn', 'Edge shaper');
  await waitStatus(/preview ready|ERROR/);
  await shot('3-step-preview');
  await click('aside .btn', 'Apply');
  await waitStatus(/added to|ERROR/);
  const steps1 = await page.$$eval('.inspector .steprow', r => r.map(x => x.textContent));
  step('fillet step added', steps1.some(t => t.includes('Fillet top')), steps1.join(' | '));
  const v2 = await vol();
  step('fillet removed material', v2 < v1, `${v1} -> ${v2}`);
  await keys('Control', 'z');
  await sleep(800);
  step('undo removes the step', (await vol()) === v1);
  await keys('Control', 'y');
  await sleep(800);
  step('redo brings it back', (await vol()) === v2);

  // history slider: the group's forms (made, then filleted), not where it has been. Setting
  // step 1 takes the fillet off and leaves the group where it is; step 2 puts it back (the list
  // keeps later forms); Ctrl+Z undoes a step. Other parts stay shown unless Hide other parts.
  const cx = async () => page.$$eval('.inspector .field', fs => +fs.find(f => f.querySelector('label').textContent === 'Center X').querySelector('input').value);
  const n = await page.$$eval('.inspector .slider input[type=range]', r => +r[0].max);
  const hx0 = await cx();
  await field('Step (of ' + n + ')', 1);
  await waitStatus(/history step 1|ERROR/);
  await sleep(500);
  const vk = await vol(), hx1 = await cx();
  const lab1 = await page.$eval('.inspector .slider + .note', e => e.textContent);
  await shot('3b-history-step1');
  step('history: step 1 is the form before the fillet, in place', n === 2 && vk === v1 && Math.abs(hx1 - hx0) < 0.05 && /Group 2 parts/.test(lab1), `${n} forms; "${lab1}"; vol ${vk} (want ${v1}); centre X ${hx0} -> ${hx1}`);
  await field('Step (of ' + n + ')', 2);
  await waitStatus(/history step 2|ERROR/);
  await sleep(500);
  step('history: forward again to the fillet', (await vol()) === v2, `${await vol()} (want ${v2})`);
  await keys('Control', 'z');
  await sleep(800);
  step('history: Ctrl+Z undoes a history step', (await vol()) === v1, `${await vol()}`);
  await keys('Control', 'y');
  await sleep(800);

  // import, drag
  await (await page.$('input[type=file]')).uploadFile(part);
  await waitStatus(/Imported|ERROR/);
  step('import', (await parts()).length === 2, await statusText());
  // a mesh that will not close still loads, with a note, and Ctrl+Z takes it away again
  const fins = join(OUT, 'fins.stl');
  writeFileSync(fins, writeSTL(Float32Array.from([0,0,0, 10,0,0, 5,8,0])));
  await (await page.$('input[type=file]')).uploadFile(fins);
  await waitStatus(/Imported fins|ERROR/);
  const finMsg = await statusText();
  step('open mesh loads with a note', (await parts()).length === 3 && /Imported fins.*Not fully closed/.test(finMsg) && !/^ERROR/.test(finMsg), finMsg);
  await keys('Control', 'z');
  await sleep(800);
  await page.click('.viewbtn[aria-label="Top"]');
  await sleep(500);
  // drag the selected part by its middle, with a tool panel open: it must move
  for (const r of await page.$$('.prow')) if ((await r.evaluate(n => n.textContent)).includes('plate')) { await r.click(); break; }
  await sleep(300);
  const dragId = await page.evaluate(() => document.getElementById('view').viewer.handleFor);
  await click('.inspector .btn', 'Simplify');
  const at = await page.evaluate(id => {
    const v = document.getElementById('view').viewer, o = v.objs.get(id), b = o.mesh.geometry.boundingBox;
    o.group.updateMatrixWorld();
    const c = b.getCenter(o.mesh.position.clone()).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
  }, dragId);
  const dragX = () => page.evaluate(id => document.getElementById('view').viewer.objs.get(id).group.position.x, dragId);
  const x0 = await dragX();
  await page.mouse.move(...at);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(at[0] + i * 8, at[1]); await sleep(20); }
  await page.mouse.up();
  await sleep(500);
  const x1 = await dragX();
  await keys('Escape');
  step('drag moves a part, tool panel open', x1 !== x0, `x ${x0} -> ${x1}; ${await statusText()}`);
  await shot('4-scene-1366');
  await page.setViewport({ width: 1920, height: 1080 });
  await shot('4-scene-1920');
  await page.setViewport({ width: 1366, height: 768 });

  // color: one button reading "Color", the color's name in its tooltip; its list opens to the left
  // of the panel and the panel does not move; a part with no color reads Gray
  const colorOf = () => page.$eval('.inspector .colorbtn', e => e.textContent === 'Color' ? e.title.replace(/^Color: (.*?)\. .*$/, '$1') : 'button text ' + e.textContent);
  const name0 = await colorOf();
  const panelH0 = await page.$eval('aside .pane:not([style*="none"])', e => e.scrollHeight);
  await page.click('.inspector .colorbtn');
  await sleep(200);
  const fly = await page.evaluate(() => { const f = document.querySelector('.colorfly'), a = document.querySelector('aside'); const r = f.getBoundingClientRect(); return { shown: f.style.display !== 'none', right: r.right, left: a.getBoundingClientRect().left, bottom: r.bottom, h: innerHeight }; });
  const panelH1 = await page.$eval('aside .pane:not([style*="none"])', e => e.scrollHeight);
  await shot('4a-color-list');
  for (const b of await page.$$('.colorfly .citem')) if ((await b.evaluate(n => n.textContent)).endsWith('Red')) { await b.click(); break; }
  await sleep(400);
  const name1 = await colorOf();
  step('color: named button, list left of the panel, panel still', name0 === 'Gray' && name1 === 'Red' && fly.shown && fly.right <= fly.left && fly.bottom <= fly.h && panelH1 === panelH0,
    `${name0} -> ${name1}; list right ${fly.right} vs panel ${fly.left}; panel ${panelH0} -> ${panelH1}`);

  // the parts list: a flyout left of the panel; double-click renames in place; Close shuts
  // it and the Parts tab opens it again; All and None select
  const pf = await page.evaluate(() => { const f = document.querySelector('.partfly'), a = document.querySelector('aside'); return f.style.display !== 'none' && f.getBoundingClientRect().right <= a.getBoundingClientRect().left; });
  await (await page.$('.prow.on')).click({ count: 2 });
  await page.waitForSelector('.parts > input.name-in');
  await page.$eval('.parts > input.name-in', i => { i.value = ''; });
  await page.type('.parts > input.name-in', 'Lid');
  await page.keyboard.press('Enter');
  await sleep(400);
  const renamed = (await parts()).some(t => t.includes('Lid'));
  await click('.partfly .btn', 'Close');
  const shut = await page.$eval('.partfly', e => e.style.display === 'none');
  await click('.tabs button', 'Parts');
  const back = await page.$eval('.partfly', e => e.style.display !== 'none');
  await click('.partfly .btn', 'All');
  await sleep(300);
  const nAll = await page.$$eval('.prow.on', r => r.length);
  await click('.partfly .btn', 'None');
  await sleep(300);
  const nNone = await page.$$eval('.prow.on', r => r.length);
  step('parts list beside the panel, rename, close, reopen, all, none', pf && renamed && shut && back && nAll === 2 && nNone === 0, `beside ${pf}, renamed ${renamed}, shut ${shut}, back ${back}, all ${nAll}, none ${nNone}`);
  for (const r of await page.$$('.prow')) if ((await r.evaluate(n => n.textContent)).includes('Lid')) { await r.click(); break; }
  await sleep(300);
  await shot('4b-parts-panel');

  // arrows follow the view: top view right = +X; right view right = +Y
  const posOf = () => page.$$eval('.inspector .field', fs => fs.filter(f => ['Center X', 'Center Y'].includes(f.querySelector('label').textContent)).slice(0, 2).map(f => +f.querySelector('input').value));
  await page.click('.viewbtn[aria-label="Top"]'); await sleep(300);
  const a0 = await posOf();
  await page.click('#view canvas', { offset: { x: 5, y: 5 } }).catch(() => {});
  await click('.prow', 'plateRedsolid').catch(async () => { const r = await page.$$('.prow'); await r[r.length - 1].click(); });
  await keys('ArrowRight');
  const a1 = await posOf();
  await page.click('.viewbtn[aria-label="Right"]'); await sleep(300);
  await keys('ArrowRight');
  const a2 = await posOf();
  step('arrows follow the view', a1[0] - a0[0] === 1 && a1[1] === a0[1] && a2[1] - a1[1] === 1 && a2[0] === a1[0], `${a0} -> ${a1} -> ${a2}`);
  // from below: front view, then right-drag the camera under the plate
  await page.click('.viewbtn[aria-label="Front"]'); await sleep(300);
  const vb = await (await page.$('#view canvas')).boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2 - 150, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await sleep(800);
  await shot('5-from-below');
  const b0 = await posOf();
  await keys('ArrowRight');
  const b1 = await posOf();
  await keys('ArrowUp');
  const b2 = await posOf();
  // seen from below, a part nearer the viewer sits higher on screen, so up = toward the viewer (-Y)
  step('arrows from below', b1[0] - b0[0] === 1 && b2[1] - b1[1] === -1, `${b0} -> ${b1} -> ${b2}`);

  // move step 0.5 mm: an arrow moves 0.5, Shift + arrow 5; then back to 1.0
  await click('.movestep', '0.5');
  const m0 = await posOf();
  await keys('ArrowRight');
  const m1 = await posOf();
  await keys('Shift', 'ArrowRight');
  const m2 = await posOf();
  await click('.movestep', '1.0');
  step('move step', Math.abs(m1[0] - m0[0] - 0.5) < 1e-6 && Math.abs(m2[0] - m1[0] - 5) < 1e-6, `${m0} -> ${m1} -> ${m2}`);

  // grid size from the header
  await menuItem('View', 'Grid...');
  const wIn = await page.evaluateHandle(() => [...document.querySelectorAll('.pop .field')].find(f => f.querySelector('label').textContent === 'Width').querySelector('input'));
  await wIn.click(); await wIn.type('300'); await wIn.press('Enter');
  const gs = await waitStatus(/Grid \d/, 5000).catch(() => '');
  await shot('5b-grid');
  await click('.pop .btn', 'Done');
  step('grid size', /Grid 300 x 600 mm/.test(gs), gs);

  // a small box that only clips the edge of a part selects it
  await page.click('.viewbtn[aria-label="Top"]'); await sleep(300);
  await keys('Escape');
  const cv = await (await page.$('#view canvas')).boundingBox();
  const edge = await page.evaluate(() => null);
  void edge;
  // a small box from empty plate onto the edge of a part
  const pc = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, o = [...v.objs.values()][0], b = o.mesh.geometry.boundingBox;
    o.group.updateMatrixWorld();
    const c = b.getCenter(o.mesh.position.clone()).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
  });
  await page.keyboard.press('Escape');
  await page.mouse.move(pc[0] - 120, pc[1] - 5);
  await page.mouse.down();
  await page.mouse.move(pc[0] + 2, pc[1] + 5, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const selCount = await page.$$eval('.prow.on', r => r.length);
  step('small box touching a part selects it', selCount >= 1, `${selCount} selected`);

  // no folder access in this browser: a plain message, not a raw error
  await page.evaluate(() => { delete window.showDirectoryPicker; window.showDirectoryPicker = undefined; });
  await click('header .btn', 'Save as project');
  await page.waitForSelector('dialog[open]');
  const msg = await page.$eval('dialog[open]', d => d.textContent);
  step('no folder access: projects kept in the browser, and it says so', /in this browser/.test(msg) && /no folder access/.test(msg), msg.slice(0, 120));
  await click('dialog .btn', 'Cancel');

  // rotation turns about the part's middle; Bottom Z shows where it really sits
  await addShape('Box');
  await sleep(600);
  const fv = async l => page.$$eval('.inspector .field', (fs, l) => +fs.find(f => f.querySelector('label').textContent === l)?.querySelector('input').value, l);
  const cx0 = await fv('Center X'), z0 = await fv('Bottom Z');
  // the Rotation row: a heading, then X Y Z boxes on one row
  const rotX = await page.evaluateHandle(() => [...document.querySelectorAll('.inspector .trio')].find(t => t.querySelector('.sub')?.textContent.startsWith('Rotation'))?.querySelector('.trio-row input'));
  const rotIn = rotX.asElement();
  if (rotIn) { await rotIn.click({ clickCount: 3 }); await rotIn.type('45'); await rotIn.press('Enter'); }
  await sleep(500);
  const cx1 = await fv('Center X'), z1 = await fv('Bottom Z');
  step('rotate about the middle', Math.abs(cx1 - cx0) < 1e-3 && Math.abs(z1 - (10 - 10 * Math.SQRT2)) < 0.01 && z0 === 0, `centre X ${cx0} -> ${cx1}, bottom Z ${z0} -> ${z1}`);
  await keys('d');
  await sleep(400);
  step('D drops the rotated part onto the plate', Math.abs(await fv('Bottom Z')) < 1e-3, `bottom Z ${await fv('Bottom Z')}`);

  // handles on a fresh 20 mm box, from the top: drag the +X cube, the lift cone, the Z ring
  await addShape('Box');
  await sleep(600);
  await page.click('.viewbtn[aria-label="Top"]'); await sleep(400);
  const scr = (what) => page.evaluate(w => {
    const v = document.getElementById('view').viewer;
    v.updateHandles();
    const r = v.renderer.domElement.getBoundingClientRect();
    const to = p => { const q = p.clone().project(v.camera); return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]; };
    if (w === 'x') return to(v.hparts[0].getWorldPosition(v.hparts[0].position.clone()));
    if (w === 'lift') return to(v.hparts[5].getWorldPosition(v.hparts[5].position.clone()));
    const ring = v.handles.children.find(c => c.userData.axis === 2), m = ring.position, R = ring.userData.radius;
    return [to(m.clone().setX(m.x + R)), to(m.clone().setY(m.y + R)), to(m.clone().setX(m.x + R * 0.7071).setY(m.y + R * 0.7071))];
  }, what);
  const dragPath = async pts => { await page.mouse.move(...pts[0]); await page.mouse.down(); for (const p of pts.slice(1)) { await page.mouse.move(...p, { steps: 6 }); await sleep(30); } await page.mouse.up(); await sleep(700); };
  const w0 = await fv('Width'), cx0b = await fv('Center X');
  const hx = await scr('x');
  await dragPath([hx, [hx[0] + 20, hx[1]], [hx[0] + 60, hx[1]]]);
  const w1 = await fv('Width'), cx1b = await fv('Center X');
  step('size handle: wider, far side stays', w1 > w0 && Number.isInteger(w1) && Math.abs((cx1b - w1 / 2) - (cx0b - w0 / 2)) < 1e-3, `width ${w0} -> ${w1}, left side ${cx0b - w0 / 2} -> ${cx1b - w1 / 2}`);
  await page.click('.viewbtn[aria-label="Front"]'); await sleep(400);
  const hl = await scr('lift');
  await dragPath([hl, [hl[0], hl[1] - 20], [hl[0], hl[1] - 50]]);
  const zl = await fv('Bottom Z');
  step('lift cone raises the part', zl > 0 && Number.isInteger(zl), `bottom Z ${zl}`);
  await page.click('.viewbtn[aria-label="Top"]'); await sleep(400);
  const ringsOff = await page.evaluate(() => !document.getElementById('view').viewer.ringsOn);
  await page.keyboard.down('r'); await sleep(200);   // hold R: the rings show
  const [r0, r90, r45] = await scr('ring');
  await dragPath([r0, r45, r90]);
  await page.keyboard.up('r'); await sleep(200);
  const ringsGone = await page.evaluate(() => !document.getElementById('view').viewer.ringsOn);
  step('rings hidden until R is held, gone after', ringsOff && ringsGone);
  const rz = await fv('Z');
  step('Z ring turns in 15 degree steps', Math.abs(Math.abs(rz) - 90) < 1e-3, `rotation Z ${rz}`);
  await shot('5c-handles');
  // the Rotation Rings button: lit and the rings on until pressed again, through a change of part
  const ringState = () => page.evaluate(() => { const b = [...document.querySelectorAll('.inspector .btn')].find(n => n.textContent === 'Rotation Rings'); return { on: document.getElementById('view').viewer.ringsOn, lit: !!b?.classList.contains('go'), found: !!b }; });
  await click('.inspector .btn', 'Rotation Rings'); await sleep(200);
  const rOn = await ringState();
  await addShape('Cylinder'); await sleep(600);
  const rKept = await ringState();
  await click('.inspector .btn', 'Rotation Rings'); await sleep(200);
  const rOff = await ringState();
  await keys('Control', 'z'); await sleep(500);   // the cylinder away again: later steps count parts
  step('Rotation Rings button: lit while on, stays on for another part, off when pressed again',
    rOn.on && rOn.lit && rKept.on && rKept.lit && !rOff.on && !rOff.lit, JSON.stringify({ rOn, rKept, rOff }));

  // edge shaper on one picked wall: a fresh 20 mm box, fillet the top edge of its front wall only
  await addShape('Box');
  await sleep(600);
  const bid = await page.evaluate(() => document.getElementById('view').viewer.handleFor);
  await click('.inspector .btn', 'Edge shaper');
  await click('aside .seg button', 'Picked');
  await page.click('.viewbtn[aria-label="Front"]'); await sleep(400);
  const fp = await page.evaluate(id => {
    const v = document.getElementById('view').viewer, o = v.objs.get(id), b = o.mesh.geometry.boundingBox;
    o.group.updateMatrixWorld();
    const p = o.mesh.position.clone().set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2).applyMatrix4(o.group.matrixWorld).project(v.camera);
    const r = v.renderer.domElement.getBoundingClientRect();
    return [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
  }, bid);
  await page.mouse.click(...fp);
  await sleep(300);
  const note = await page.$$eval('aside .note', ns => ns.map(n => n.textContent).find(t => /picked/.test(t)) || '');
  await click('aside .btn', 'Apply');
  await waitStatus(/added to|ERROR/);
  const vf = await vol();
  await keys('f'); await page.evaluate(() => document.getElementById('view').viewer.view('iso', [document.getElementById('view').viewer.handleFor].filter(Boolean))); await shot('5d-picked-edge');
  step('edge shaper: one picked wall', /1 wall picked/.test(note) && vf < 8 && vf > 7.97, `${note.slice(0, 20)} | vol ${vf} cm3`);

  // projects: home folder picked once, project named, reopened by itself after a reload.
  // The picker is stood in by the browser's private storage, so no dialog is needed. That
  // storage is refused to file:// pages, so this part loads the same page from 127.0.0.1.
  await page.evaluateOnNewDocument(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('home', { create: true });
  });
  const html = readFileSync(join(ROOT, 'Workingtitle3D.html'));
  server = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await sleep(800);
  await addShape('Box');
  await page.waitForSelector('dialog[open]');
  await click('dialog .btn', 'Pick folder');
  await page.waitForSelector('dialog[open] input.name-in');
  await page.$eval('dialog[open] input.name-in', i => { i.value = 'Test case'; });
  await click('dialog .btn', 'Save');
  await waitStatus(/Saving to projects|ERROR/);
  await addShape('Cylinder');
  await sleep(1500);
  await page.reload();
  // a reload starts empty (it is nearly always after a crash); File > Reopen brings it back
  await sleep(1500);
  const empty = await page.evaluate(() => document.getElementById('view').viewer.objs.size);
  await menuItem('File', 'Reopen Test case');
  await page.waitForSelector('dialog[open]');
  await click('dialog[open] .btn', 'Reopen');
  const reopened = await waitStatus(/Opened|ERROR/, 15000).catch(e => e.message);
  step('reload starts empty; File > Reopen brings the project back', empty === 0 && /Opened Test case: 2 parts/.test(reopened), `${empty} parts after reload; ${reopened}`);
  // Reopen with "Undo last action before loading": the last step (the cylinder) is not built
  await page.reload();
  await sleep(1500);
  await menuItem('File', 'Reopen Test case');
  await page.waitForSelector('dialog[open]');
  await page.$eval('dialog[open] input[type=checkbox]', c => c.click());
  await click('dialog[open] .btn', 'Reopen');
  const undone = await waitStatus(/Opened|ERROR/, 15000).catch(e => e.message);
  step('Reopen with the last action undone first', /Opened Test case: 1 parts/.test(undone) && /undone: Add Cylinder/.test(undone), undone);
  await keys('Control', 'y'); await sleep(800);
  await menuItem('File', 'Open...');
  await page.waitForSelector('dialog[open] .projlist');
  const listed = await page.$$eval('dialog[open] .projlist .btn', b => b.map(x => x.textContent));
  step('Open lists the projects', listed.includes('Test case'), listed.join(', '));
  await click('dialog .btn', 'Cancel');

  // export: into exports/, never over an existing file (-1, -2 ...), and a closed solid
  await keys('Control', 'e');
  const e1 = await waitStatus(/Exported|ERROR/);
  await page.evaluate(() => { document.querySelector('footer .msg').textContent = ''; });
  await keys('Control', 'e');
  const e2 = await waitStatus(/Exported|ERROR/);
  step('export names never collide', /exports\/Test case\.stl/.test(e1) && /exports\/Test case-1\.stl/.test(e2), `${e1.slice(0, 40)} | ${e2.slice(0, 40)}`);
  const bytes = await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('home')).getDirectoryHandle('exports');
    return [...new Uint8Array(await (await (await dir.getFileHandle('Test case-1.stl')).getFile()).arrayBuffer())];
  });
  const r = report(readSTL(Uint8Array.from(bytes).buffer));
  step('export + read back', r.watertight, `${r.triangles} tris  ${describe(r)}  vol ${r.volume.toFixed(0)}`);

  // no project name box in the view at all: the name and saved state are in the window title
  step('no name box in the view; name in the title', !(await page.$('header .file')) && /Test case-?\d*|Test case/.test(await page.title()), await page.title());
  // rename: File > Rename project; the folder moves, the next step lands in the new one
  await menuItem('File', 'Rename project...');
  await page.waitForSelector('dialog[open] input.name-in');
  await page.$eval('dialog[open] input.name-in', i => { i.value = 'Renamed case'; });
  await click('dialog .btn', 'Save');
  const rn = await waitStatus(/renamed|ERROR/);
  await addShape('Sphere');
  await sleep(1500);
  const after = await page.evaluate(async () => {
    const pd = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('home')).getDirectoryHandle('projects');
    const names = []; for await (const [n] of pd.entries()) names.push(n);
    const j = await (await (await (await pd.getDirectoryHandle('Renamed case')).getFileHandle('journal.ndjson')).getFile()).text();
    return { names, label: document.title, lastStep: j.trim().split('\n').pop() };
  });
  step('rename the project', /Renamed case/.test(after.label) && after.names.includes('Renamed case') && !after.names.includes('Test case') && /Sphere/.test(after.lastStep),
    `${rn.slice(0, 50)} | ${after.names.join(', ')} | ${after.label}`);

  // a shape added on Shape tools is edited there, no tab change; Parts takes the options back
  await click('.tabs button', 'Shape tools');
  await click('.shapes .btn', 'Cylinder');
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(800);
  await shot('shape-tab-opts');
  // (the Shapes card heads both tabs and moves with them: the pane shown is the one to read)
  const shownOpts = () => page.evaluate(() => { const pane = [...document.querySelectorAll('aside .pane')].find(p => p.style.display !== 'none'); const o = pane?.querySelector('.shapeopts');
    return o ? { shown: o.style.display !== 'none', inspector: !!o.querySelector('.inspector') && o.querySelector('.inspector').style.display !== 'none', text: o.textContent } : null; });
  const s = await shownOpts();
  const onShapes = !!s && s.shown && s.inspector && /Diameter/.test(s.text) && /Color/.test(s.text);
  await click('.tabs button', 'Parts');
  const pp = await shownOpts();
  const onParts = !!pp && pp.shown && pp.inspector && /Diameter/.test(pp.text);
  step('options under Shape tools after adding, then on Parts', onShapes && onParts, `${onShapes} ${onParts}`);

  // a driver reset (resume from sleep) loses the GL context: say so, then redraw on restore
  await page.evaluate(() => { window._lc = document.querySelector('#view canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window._lc.loseContext(); });
  const lostMsg = await waitStatus(/graphics driver reset/);
  await page.evaluate(() => window._lc.restoreContext());
  const backMsg = await waitStatus(/view is back/);
  await sleep(300);
  await page.screenshot({ path: join(OUT, 'restored.png') });
  step('GL context lost and restored', /driver reset/.test(lostMsg) && /back/.test(backMsg), backMsg);

  // a browser that refuses WebGL at load says so instead of looking ready
  const nogl = await browser.newPage();
  await nogl.evaluateOnNewDocument(() => { const g = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); }; });
  await nogl.goto(pathToFileURL(join(ROOT, 'Workingtitle3D.html')).href);
  await sleep(1000);
  const fat = await nogl.$eval('.fatal', e => e.style.display !== 'none' && e.textContent).catch(() => '');
  await nogl.close();
  step('no WebGL at load shows the error', /3D graphics/.test(fat), fat.slice(0, 60));
} catch (e) {
  fail++;
  const st = await page.$eval('footer .msg', e => e.textContent).catch(() => '');
  await page.screenshot({ path: join(OUT, 'fail.png') }).catch(() => {});
  console.log('FAIL ' + e.message + (st ? `  (status: ${st})` : ''));
} finally {
  await browser.close();
  server?.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
