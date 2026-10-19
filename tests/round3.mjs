// 2026-10-17 round: key strip, copy and paste by key, the auto save line, scroll to zoom speed.
// Headless and muted; screenshots to .tmp/round3, delete after.
// node tests/round3.mjs   (same PUPPETEER_DIR / CHROME_DIR as browser.mjs)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PUPPETEER_DIR || !process.env.CHROME_DIR) { console.log('Set PUPPETEER_DIR and CHROME_DIR.'); process.exit(2); }
const { default: puppeteer } = await import(pathToFileURL(createRequire(join(process.env.PUPPETEER_DIR, 'package.json')).resolve('puppeteer-core')).href);
const OUT = join(ROOT, '.tmp', 'round3'), PROFILE = join(OUT, 'chrome');
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
    for (const e of await page.$$(sel)) if ((await e.evaluate(n => n.textContent.trim())) === text && await e.evaluate(n => n.getClientRects().length > 0)) { await e.click(); await sleep(200); return; }
    throw new Error(`no ${sel} "${text}"`);
  };
  const menuItem = async (m, item) => {
    for (const t of await page.$$('.menubar .mtitle')) if ((await t.evaluate(n => n.textContent)) === m) { await t.click(); break; }
    await sleep(150);
    for (const b of await page.$$('.menu.open .mitem')) if ((await b.$eval('.mlabel', n => n.textContent)).startsWith(item)) { await b.click(); await sleep(250); return; }
    throw new Error(`no menu item ${m} > ${item}`);
  };
  const parts = () => page.evaluate(() => document.getElementById('view').viewer.objs.size);
  const shown = sel => page.$eval(sel, e => e.style.display !== 'none' && e.getClientRects().length > 0);

  // the auto save line: none on an empty start; there after the first change
  step('no auto save line before any work', !(await shown('.autosave-note')));
  await click('.tabs button', 'Shape tools'); await click('.shapes .btn', 'Box'); await page.keyboard.press('Enter'); await sleep(400);
  // the first change asks about saving: say no, as a user who denied storage would
  for (const b of await page.$$('dialog[open] .btn')) { await b.click(); break; }
  await sleep(500);
  step('auto save line shows once there is unsaved work', await shown('.autosave-note'), await page.$eval('.autosave-note', e => e.textContent));
  await page.screenshot({ path: join(OUT, 'autosave-1256.png') });
  await click('.autosave-note', 'Auto save is turned off, click here to enable');
  await sleep(500);
  const asked = await page.evaluate(() => !!document.querySelector('dialog[open]'));
  step('clicking it starts saving (asks for a name)', asked);
  for (const b of await page.$$('dialog[open] .btn')) if ((await b.evaluate(n => n.textContent)) === 'Cancel') { await b.click(); break; }
  await sleep(300);

  // copy and paste by key
  await click('.tabs button', 'Parts');
  const n0 = await parts();
  await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.press('v'); await page.keyboard.up('Control');
  await sleep(600);
  step('Ctrl+C then Ctrl+V makes a copy', (await parts()) === n0 + 1, `${n0} -> ${await parts()} parts`);

  // the key strip
  step('key strip off at the start', !(await shown('.keystrip')));
  await menuItem('View', 'Key strip');
  const strip = await page.$eval('.keystrip', e => ({ text: e.textContent, pe: getComputedStyle(e).pointerEvents, r: e.getBoundingClientRect().toJSON() }));
  step('View > Key strip shows the keys, and the mouse goes through it', (await shown('.keystrip')) && /fit/.test(strip.text) && /undo/.test(strip.text) && strip.pe === 'none', strip.text.slice(0, 80));
  await page.screenshot({ path: join(OUT, 'keystrip-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(500);
  await page.screenshot({ path: join(OUT, 'keystrip-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(500);

  // scroll to zoom: one notch in pixels and one in lines zoom the same; speed 10 twice speed 5
  const zoomBy = (deltaY, deltaMode) => page.evaluate((deltaY, deltaMode) => {
    const v = document.getElementById('view').viewer, c = v.renderer.domElement, r = c.getBoundingClientRect();
    v.view('iso');
    const d0 = v.camera.position.distanceTo(v.controls.target);
    c.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, clientX: r.left + r.width / 2, clientY: r.top + 30, bubbles: true, cancelable: true }));
    return d0 / v.camera.position.distanceTo(v.controls.target);
  }, deltaY, deltaMode);
  const px = await zoomBy(-100, 0), lines = await zoomBy(-3, 1);
  step('a notch zooms the same in pixels and in lines', Math.abs(px - lines) < 1e-6, `${px.toFixed(4)} vs ${lines.toFixed(4)}`);
  await menuItem('View', 'Accessibility');
  const sliderShown = await page.$$eval('.pop .field label', l => l.map(x => x.textContent).includes('Scroll to zoom speed'));
  await page.screenshot({ path: join(OUT, 'access-1256.png') });
  await page.$$eval('.pop .field', fs => { const f = fs.find(x => x.querySelector('label').textContent === 'Scroll to zoom speed'); const i = f.querySelector('input'); i.value = '10'; i.dispatchEvent(new Event('change')); });
  await sleep(300);
  const fast = await zoomBy(-100, 0);
  // a notch moves this share of the way in: 15% at 5, 30% at 10
  const share = r => 1 - 1 / r;
  step('View > Accessibility: speed 10 zooms twice as far a notch as 5', sliderShown && Math.abs(share(fast) / share(px) - 2) < 0.01, `5: ${(share(px) * 100).toFixed(1)}%, 10: ${(share(fast) * 100).toFixed(1)}% of the way`);
  await page.$$eval('.pop .field', fs => { const f = fs.find(x => x.querySelector('label').textContent === 'Scroll to zoom speed'); const i = f.querySelector('input'); i.value = '5'; i.dispatchEvent(new Event('change')); });
  await click('.pop .btn', 'Done');

  // measure: T, two clicks 3 px off two top corners of a 20 mm box snap to them: 20.00 mm
  await page.evaluate(() => document.getElementById('view').viewer.view('iso'));
  await sleep(400);
  await page.keyboard.press('t'); await sleep(200);
  const corners = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, [o] = [...v.objs.values()], r = v.renderer.domElement.getBoundingClientRect();
    o.mesh.geometry.computeBoundingBox(); o.mesh.updateMatrixWorld();
    const b = o.mesh.geometry.boundingBox.clone().applyMatrix4(o.mesh.matrixWorld);
    return [[b.min.x, b.min.y, b.max.z], [b.max.x, b.min.y, b.max.z]].map(([x, y, z]) => {
      const s = new b.min.constructor(x, y, z).project(v.camera);
      return [(s.x + 1) / 2 * r.width + r.left, (1 - s.y) / 2 * r.height + r.top];
    });
  });
  for (const [x, y] of corners) { await page.mouse.click(x + 3, y + 3); await sleep(250); }
  const readout = await page.$eval('.measurebox', e => e.textContent);
  step('T, then two clicks near two corners of a 20 mm box: 20.00 mm', /^20\.00 mm/.test(readout), readout);
  await page.screenshot({ path: join(OUT, 'measure-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(500);
  await page.screenshot({ path: join(OUT, 'measure-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(500);
  const selBefore = await page.evaluate(() => document.getElementById('view').viewer.selected.size);
  await page.keyboard.press('Escape'); await sleep(150); await page.keyboard.press('Escape'); await sleep(150);
  const off = await page.$eval('.measurebox', e => e.style.display === 'none');
  const selAfter = await page.evaluate(() => document.getElementById('view').viewer.selected.size);
  step('Esc clears, Esc again ends it, the selection untouched', off && selBefore === selAfter, `measure off ${off}, selected ${selBefore} -> ${selAfter}`);

  // path: P, four clicks on the corners of a 20 mm square on the plate, a click on the first closes it
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.camera.position.set(-45, -120, 120); v.controls.target.set(-45, -40, 0); v.camera.up.set(0, 0, 1); v.controls.update(); v.request(); });
  await sleep(400);
  // plate points to the screen; each must land on the view itself (not under the Path list)
  const scr = async pts => {
    const out = await page.evaluate(pts => {
      const v = document.getElementById('view').viewer, r = v.renderer.domElement.getBoundingClientRect(), V = v.camera.position.constructor;
      return pts.map(([x, y]) => { const s = new V(x, y, 0).project(v.camera); const sx = (s.x + 1) / 2 * r.width + r.left, sy = (1 - s.y) / 2 * r.height + r.top; return [sx, sy, document.elementFromPoint(sx, sy)?.tagName]; });
    }, pts);
    for (const [x, y, tag] of out) if (tag !== 'CANVAS') throw new Error(`a test click would land on ${tag}, not the view (at ${Math.round(x)}, ${Math.round(y)}; plate ${JSON.stringify(pts)})`);
    return out;
  };
  await page.keyboard.press('p'); await sleep(200);
  // (checked with the Path list open: it opens beside the Path button, on either tab)
  const sq = await scr([[-70, -70], [-50, -70], [-50, -50], [-70, -50], [-70, -70]]);
  const pathUi = await page.evaluate(() => ({
    lit: [...document.querySelectorAll('.shapes .btn')].find(b => b.textContent === 'Path')?.classList.contains('go'),
    fly: (() => { const f = document.querySelector('.pathfly'); return f && f.style.display !== 'none' ? [...f.querySelectorAll('.pathtools .btn')].map(b => b.textContent).join(' ') : ''; })(),
    hint: getComputedStyle(document.querySelector('#view > .drop, .drop')).display,
  }));
  step('P lights the Path button and opens its list (tools with their keys); the drop hint hides', pathUi.hint === 'none' && pathUi.lit &&/LineL/.test(pathUi.fly) && /ArcA/.test(pathUi.fly) && /CircleC/.test(pathUi.fly) && /RectangleR/.test(pathUi.fly) && /Finish lineF/.test(pathUi.fly) && /Undo last pointU/.test(pathUi.fly) && /Cancel lineX/.test(pathUi.fly), JSON.stringify(pathUi));
  // 3D path is a work in progress: off by default (no 3D frame in the list, 3 does nothing), on from View
  await page.keyboard.press('3'); await sleep(150);
  const keysText = () => page.evaluate(() => [...document.querySelectorAll('.pane')].find(p => /^Keys/.test(p.textContent.trim()))?.textContent || 'no keys pane');
  await page.keyboard.press('v'); await sleep(150);
  const offV = await page.$eval('.pathfly', e => e.textContent), keysOff = await keysText();
  await page.keyboard.press('l'); await sleep(150);
  const off3 = await page.$eval('.pathfly', e => e.textContent);
  step('3D path off: no 3D frame word in the Keys tab or the Pointer hint', !/3D frame|frame part/.test(keysOff) && /^Keys/.test(keysOff.trim()) && !/frame/.test(offV), `${/3D frame/.test(keysOff)} ${/frame/.test(offV)}`);
  await menuItem('View', '3D path'); await sleep(200);
  const on3 = await page.$eval('.pathfly', e => e.textContent);
  step('3D path on: the Keys tab lists the 3D frame keys', /3D frame \(in Path\)/.test(await keysText()));
  step('3D path off by default: no 3D frame, 3 ignored; View > 3D path brings it', !/3D frame/.test(off3) && /LineL/.test(off3) && /3D frame3/.test(on3), `${/3D frame/.test(off3)} -> ${/3D frame3/.test(on3)}`);
  for (const [x, y] of sq) { await page.mouse.click(x, y); await sleep(200); }
  const made = await page.evaluate(() => { const v = document.getElementById('view').viewer; const o = [...v.objs.values()].find(q => q.part.kind === 'path'); return o && { closed: o.part.params.closed, n: o.part.params.pts.length }; });
  await sleep(800);
  const vol = () => page.evaluate(() => { const t = document.querySelector('.inspector .infobox .kv'); return +t.textContent.match(/([\d.]+) cm3/)[1] * 1000; });
  // a closed 20 mm square of a 1 mm line, 1 mm high: 4 stadiums joined, about 4 x 20 x 1 minus the corners' overlap
  const v0 = await vol();
  step('P and four clicks round a square, a click on the first: a closed path', made?.closed && made.n === 4 && Math.abs(v0 - 79.79) < 10 /* the panel shows cm3 to 0.01: 10 mm3 */, `${JSON.stringify(made)}, ${v0.toFixed(2)} mm3`);
  await page.screenshot({ path: join(OUT, 'path-1256.png') });
  await click('.inspector .seg button', 'Fill'); await sleep(900);
  const v1 = await vol();
  step('Inside: Fill fills the square', Math.abs(v1 - v0 - 19 * 19) < 10, `${v0.toFixed(2)} -> ${v1.toFixed(2)} mm3`);
  await click('.inspector .seg button', 'Clear'); await sleep(600);
  const hole = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].find(q => q.part.kind === 'path').part.hole);
  step('Inside: Clear makes it a hole', hole === true);
  await page.screenshot({ path: join(OUT, 'path-clear-1256.png') });
  // with a step on the part, Hollow (the line alone) is grayed out and says why; Fill and Clear stay
  await click('.inspector .seg button', 'Fill'); await sleep(900);
  await click('.inspector .btn', 'Simplify'); await sleep(400);
  await click('aside .btn', 'Apply'); await sleep(2500);
  const insideBtns = await page.$$eval('.inspector .seg button', b => b.filter(x => ['Hollow', 'Fill', 'Clear'].includes(x.textContent)).map(x => `${x.textContent}:${x.classList.contains('off') ? 'off ' + x.dataset.tip : 'on'}`));
  await click('.inspector .seg button', 'Hollow'); await sleep(600);
  const afterHollow = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].find(q => q.part.kind === 'path').part.params.fill);
  const whyMsg = await page.$eval('footer .msg', e => e.textContent);
  step('a Path with a step: Hollow grayed out; a click on it changes nothing and says why; Fill and Clear can be picked',
    insideBtns.length === 3 && /^Hollow:off .*remove them under Steps/.test(insideBtns[0]) && insideBtns[1] === 'Fill:on' && insideBtns[2] === 'Clear:on' && afterHollow === 'fill' && /^Hollow is off/.test(whyMsg), `${insideBtns.join(' | ')} | fill ${afterHollow} | ${whyMsg}`);
  await page.screenshot({ path: join(OUT, 'path-inside-steps-1256.png') });
  for (let i = 0; i < 2; i++) { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await sleep(700); }
  // Path stays open: an open line, two clicks and Enter
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.camera.position.set(-48, -200, 170); v.controls.target.set(-48, -80, 0); v.camera.up.set(0, 0, 1); v.controls.update(); v.request(); });
  await sleep(400);
  // Ctrl+Z with a line under way drops that line, and leaves the finished square alone
  const pathCount = () => page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(q => q.part.kind === 'path').length);
  const kinds0 = await pathCount();
  const ln0 = await scr([[-120, -40], [-95, -40]]);
  await page.mouse.click(ln0[0][0], ln0[0][1]); await sleep(200);
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); await sleep(500);
  const kinds1 = await pathCount(), zmsg = await page.$eval('footer .msg', e => e.textContent);
  step('Ctrl+Z with a line under way drops the line, the finished square stays', kinds1 === kinds0 && /piece dropped/.test(zmsg), `${kinds0} -> ${kinds1} | ${zmsg}`);
  const ln = await scr([[-120, -40], [-95, -40]]);
  // one shape: 3 mid-line, the line joins the 3D frame as a strand (no part made), the frame carrying
  // on from its last point; 3 again, flat from that point; 3 again, the flat stretch joins too
  await page.mouse.click(ln[0][0], ln[0][1]); await sleep(200);
  await page.mouse.click(ln[1][0], ln[1][1]); await sleep(200);
  const n3 = await pathCount();
  const counts3 = () => page.$eval('.pathfly', e => e.textContent.match(/(\d+) points, (\d+) edges/)?.slice(1).join(' '));
  await page.keyboard.press('3'); await sleep(200);
  const c3 = await counts3(), n3b = await pathCount();
  step('3 mid-line: the line joins the 3D frame (2 points, 1 edge), no part made', c3 === '2 1' && n3 === n3b, `${c3} | ${n3} -> ${n3b}`);
  await page.keyboard.press('3'); await sleep(150);
  const lit3 = await page.$$eval('.pathfly .pathtools .btn.go', b => b.map(x => x.textContent).join());
  const ln2 = await scr([[-95, -20]]);
  await page.mouse.click(ln2[0][0], ln2[0][1]); await sleep(200);
  await page.keyboard.press('3'); await sleep(200);
  const c3b = await counts3();
  step('3 again: flat from the frame\'s last point; a click, then 3: one more point and edge, joined', lit3 === 'LineL' && c3b === '3 2' && (await pathCount()) === n3, `${lit3} | ${c3b}`);
  await page.screenshot({ path: join(OUT, 'flat-to-frame-1256.png') });
  await click('.pathfly .btn', 'Clear frame'); await page.keyboard.press('3'); await sleep(150);
  for (const [x, y] of ln) { await page.mouse.click(x, y); await sleep(200); }
  await page.keyboard.press('f'); await sleep(800);   // F: finish the line
  const kinds = () => page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(q => q.part.kind === 'path').map(q => q.part.params.closed));
  step('Path stays open; two clicks and F: an open line', (await kinds()).join() === 'true,false', (await kinds()).join());
  // C: a circle, middle then a point 10 mm out: a closed ring of a 1 mm line, about 2 pi 10 mm3
  const cc = await scr([[-110, -75], [-100, -75]]);
  await page.keyboard.press('c'); await sleep(150);
  for (const [x, y] of cc) { await page.mouse.click(x, y); await sleep(250); }
  await sleep(800);
  const v3 = await vol();
  step('C, middle and a point 10 mm out: a closed circle', (await kinds()).join() === 'true,false,true' && Math.abs(v3 - 2 * Math.PI * 10) < 10, `${(await kinds()).join()}, ${v3.toFixed(1)} mm3`);
  // R: a rectangle, two corners
  const rc = await scr([[-80, -70], [-50, -55]]);
  await page.keyboard.press('r'); await sleep(150);
  for (const [x, y] of rc) { await page.mouse.click(x, y); await sleep(250); }
  await sleep(800);
  const dims = await page.$$eval('.inspector .dims b', b => b.map(x => x.textContent).join(' '));
  step('R, two corners: a 30 x 15 rectangle (31 x 16 outside, a 1 mm line)', (await kinds()).length === 4 && dims.startsWith('31.00 16.00'), dims);
  // A: an arc, start, a point it passes, end: half a circle of radius 10 (21 x 11 outside), then Enter
  const ac = await scr([[-115, -15], [-105, -5], [-95, -15]]);
  await page.keyboard.press('a'); await sleep(150);
  for (const [x, y] of ac) { await page.mouse.click(x, y); await sleep(250); }
  await page.keyboard.press('f'); await sleep(900);
  const adims = await page.$$eval('.inspector .dims b', b => b.map(x => x.textContent).join(' '));
  step('A, start, through, end: a half circle of radius 10', (await kinds()).length === 5 && adims.startsWith('21.00 11.00'), adims);
  await page.screenshot({ path: join(OUT, 'pathfly-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(500);
  await page.screenshot({ path: join(OUT, 'pathfly-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(300);
  // V: the pointer back, Path open: a click on the rectangle's line selects it; L draws again
  await page.keyboard.press('v'); await sleep(200);
  const [[ex, ey]] = await scr([[-80, -62.5]]);
  await page.mouse.click(ex, ey); await sleep(400);
  const picked = await page.evaluate(() => { const v = document.getElementById('view').viewer, id = [...v.selected][0], o = v.objs.get(id); return o ? `${o.part.kind} ${o.part.params?.pts?.length}` : 'none'; });
  const litV = await page.$$eval('.pathfly .pathtools .btn.go', b => b.map(x => x.textContent).join());
  step('V: Pointer lit, and a click selects the rectangle under it', picked === 'path 4' && /^PointerV$/.test(litV), `${picked} | lit ${litV}`);
  await page.keyboard.press('l'); await sleep(200);
  const litL = await page.$$eval('.pathfly .pathtools .btn.go', b => b.map(x => x.textContent).join());
  step('L: back to drawing lines', /^LineL/.test(litL), litL);
  await page.keyboard.press('Escape'); await sleep(200);
  const closed = await page.evaluate(() => ({ lit: [...document.querySelectorAll('.shapes .btn')].find(b => b.textContent === 'Path')?.classList.contains('go'), fly: document.querySelector('.pathfly').style.display }));
  step('Esc with nothing being drawn closes Path, the button goes dark', !closed.lit && closed.fly === 'none', JSON.stringify(closed));

  // 3D frame: a tetrahedron. Base triangle A B C on the plate (legs 20), a strand from C straight up
  // with Shift to D (20 high), joined to A and B; four faces; Make solid: 200 x 20 / 3 = 1333 mm3
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.camera.position.set(-20, -190, 140); v.controls.target.set(-20, -40, 25); v.camera.up.set(0, 0, 1); v.controls.update(); v.request(); });
  await sleep(400);
  const W = { A: [-60, -50, 0], B: [-40, -50, 0], C: [-60, -30, 0], D: [-60, -30, 20] };
  const at = async name => { const [x, y, z] = W[name]; const s = await page.evaluate(([x, y, z]) => { const v = document.getElementById('view').viewer, r = v.renderer.domElement.getBoundingClientRect(); const q = new v.camera.position.constructor(x, y, z).project(v.camera); const sx = (q.x + 1) / 2 * r.width + r.left, sy = (1 - q.y) / 2 * r.height + r.top; return [sx, sy, document.elementFromPoint(sx, sy)?.tagName]; }, [x, y, z]); if (s[2] !== 'CANVAS') throw new Error(`frame point ${name} would land on ${s[2]}`); return s; };
  const tap = async (name, shift) => { const [x, y] = await at(name); if (shift) await page.keyboard.down('Shift'); await page.mouse.move(x, y); await page.mouse.click(x, y); if (shift) await page.keyboard.up('Shift'); await sleep(150); };
  await page.keyboard.press('p'); await sleep(150); await page.keyboard.press('3'); await sleep(150);
  const shiftLine = await page.$eval('.pathfly', e => e.querySelector('.keyhint')?.textContent || '');
  step('the 3D frame list says what Shift does', /^Shift hold: mouse up or down lifts or lowers the point; over a point, straight up from it$/.test(shiftLine), shiftLine);
  for (const n of ['A', 'B', 'C', 'A']) await tap(n);
  // the upright reference grid: shown with the 3D frame, through the point, below and above the plate
  const [mx, my] = await at('B'); await page.mouse.move(mx + 30, my - 40); await sleep(200);
  const grid = await page.evaluate(() => { const g = document.getElementById('view').viewer.refGrid; if (!g?.visible) return null; const b = new (g.children[0].geometry.boundingBox?.constructor || Object)(); g.children[0].geometry.computeBoundingBox(); const bb = g.children[0].geometry.boundingBox; return [bb.min.z, bb.max.z].map(z => +z.toFixed(1)); });
  step('3D frame shows an upright grid from the plate to 150 mm over it (none below)', grid && grid[0] === 0 && grid[1] === 150, JSON.stringify(grid));
  // with Path open, zooming in stops above the build plate: 40 notches in at the plate, camera Z stays at 1 mm or more
  const camZ = await page.evaluate(() => {
    const v = document.getElementById('view').viewer, c = v.renderer.domElement, r = c.getBoundingClientRect(), saved = [v.camera.position.clone(), v.controls.target.clone()];
    for (let i = 0; i < 40; i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.8, bubbles: true, cancelable: true }));
    const z = v.camera.position.z;
    v.camera.position.copy(saved[0]); v.controls.target.copy(saved[1]); v.controls.update(); v.request();
    return +z.toFixed(3);
  });
  step('Path open: zooming in at the plate stops above it', camZ >= 1, `camera Z ${camZ} mm after 40 notches in`);
  // the grid turns in whole degrees with a ring gauge on the plate, its angle in the Path list
  const angle = async () => page.$eval('.pathfly', e => e.textContent.match(/Upright grid: (\d+)°/)?.[1]);
  const a0 = await angle();
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.controls.rotateLeft?.(0.3); const c = v.camera.position.clone().sub(v.controls.target); c.applyAxisAngle(new c.constructor(0, 0, 1), 0.3); v.camera.position.copy(v.controls.target).add(c); v.controls.update(); v.request(); });
  await page.mouse.move(mx + 31, my - 40); await sleep(250);
  const a1 = await angle();
  const ring = await page.evaluate(() => document.getElementById('view').viewer.refGrid.children[2].geometry.attributes.position.count);
  step('the grid turns in whole degrees as the view turns, with a ring gauge', a0 != null && a1 != null && a0 !== a1 && ring > 360 * 2, `${a0}° -> ${a1}°, ${ring} gauge and grid vertices`);
  await page.screenshot({ path: join(OUT, 'gauge-1256.png') });
  await page.screenshot({ path: join(OUT, 'frame-grid-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(400);
  await page.screenshot({ path: join(OUT, 'frame-grid-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(400);
  await page.keyboard.press('n'); await sleep(100);   // N: end the strand
  // D: from C, hold Shift and move the mouse up by 20 mm at the view's scale there, then click
  const lift = async (from, mm) => {
    const [x, y] = await at(from);
    const mmPx = await page.evaluate(([x0, y0, z0]) => { const v = document.getElementById('view').viewer; return v.pxAt(new v.camera.position.constructor(x0, y0, z0)); }, W[from]);
    const top = await page.evaluate(() => document.getElementById('view').viewer.renderer.domElement.getBoundingClientRect().top);
    if (y - mm / mmPx < top + 5) throw new Error(`lifting ${mm} mm from ${from} would take the mouse off the top of the view`);
    await page.mouse.move(x, y); await sleep(100);
    const z0 = +(await page.$eval('footer .msg', e => e.textContent)).match(/Z (-?[\d.]+)/)[1];
    // Shift goes down 6 px off the point, as a hand would: the lift starts from the point itself
    await page.keyboard.down('Shift'); await page.mouse.move(x + 6, y); await sleep(50);
    await page.mouse.move(x + 6, y - mm / mmPx, { steps: 6 }); await sleep(100);
    const z = await page.$eval('footer .msg', e => e.textContent);
    await page.mouse.click(x + 6, y - mm / mmPx); await page.keyboard.up('Shift'); await sleep(150);
    return [z0, z];
  };
  await tap('C');
  const [zBase, zLift] = await lift('C', 20);
  const rise = +zLift.match(/Z (-?[\d.]+)/)[1] - zBase;
  const dots = await page.evaluate(() => [...document.getElementById('view').viewer.frameMarks.children[1].geometry.attributes.position.array].map(v => +v.toFixed(2)));
  const cxy = dots.slice(6, 8).join(), dxy = dots.slice(-3, -1).join();   // C is the third point, the lifted one the last
  step('Shift held over C, mouse up 20 mm: the point rises 20 mm straight above C', Math.abs(rise - 20) < 1e-6 && cxy === dxy, `${zBase} -> ${zLift}; C ${cxy}, new ${dxy}`);
  // the raised point has a stem to the plate: from Z 21 down to Z 0, and only that one is raised
  const stemZ = await page.evaluate(() => { const g = document.getElementById('view').viewer.frameMarks.children[4].geometry; g.computeBoundingBox(); return [g.boundingBox.min.z, g.boundingBox.max.z].map(z => +z.toFixed(2)); });
  step('the raised point has a stem down to the plate', stemZ[0] === 0 && Math.abs(stemZ[1] - (zBase + 20)) < 1e-6, `stem from Z ${stemZ[1]} to Z ${stemZ[0]}`);
  await tap('A'); await tap('D'); await tap('B');
  // the same lift from straight above (the view where an upright plane would run away)
  await page.evaluate(([x, y]) => { const v = document.getElementById('view').viewer; v.view('top'); const d = v.camera.position.clone().sub(v.controls.target); v.controls.target.set(x + 60, y + 20, 0); v.camera.position.copy(v.controls.target).add(d); v.controls.update(); v.request(); }, W.B); await sleep(400);
  await page.keyboard.press('n'); await sleep(100);
  await tap('B');
  const [zb2, zl2] = await lift('B', 15);
  step('from straight above too: Shift and the mouse up 15 mm lifts the point 15 mm', Math.abs(+zl2.match(/Z (-?[\d.]+)/)[1] - zb2 - 15) < 1e-6, `${zb2} -> ${zl2}`);
  await page.keyboard.press('u'); await sleep(100);   // take that test point back
  // and down: never under the plate
  await page.keyboard.press('n'); await sleep(100);
  await tap('B');
  const [zb3, zl3] = await lift('B', -20);
  step('Shift and the mouse down 20 mm from 1 mm up stops at the plate (Z 0)', /Z 0\.00/.test(zl3), `${zb3} -> ${zl3}`);
  await page.keyboard.press('u'); await sleep(100);
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.camera.position.set(-20, -190, 140); v.controls.target.set(-20, -40, 25); v.camera.up.set(0, 0, 1); v.controls.update(); v.request(); });
  await sleep(400);
  const counts = await page.$eval('.pathfly', e => e.textContent.match(/(\d+) points, (\d+) edges/)?.slice(1).join(' '));
  step('3D frame: four points and six edges, one of them climbing with Shift', counts === '4 6', counts);
  await page.keyboard.press('f'); await sleep(100);
  const face = async list => { for (const n of list) await tap(n); };
  await face(['A', 'B', 'C', 'A']); await face(['A', 'C', 'D', 'A']); await face(['A', 'D', 'B', 'A']);
  await page.keyboard.press('b'); await sleep(300);
  const err = await page.$eval('footer .msg', e => (e.classList.contains('err') ? 'ERROR ' : '') + e.textContent);
  step('three faces only: Make solid says it is not closed, and how many edges', /^ERROR Not closed: 3 edges/.test(err), err);
  await page.screenshot({ path: join(OUT, 'frame-open-1256.png') });
  await face(['B', 'C', 'D', 'B']);
  await page.screenshot({ path: join(OUT, 'frame-1256.png') });
  await page.keyboard.press('b'); await sleep(1200);
  const solid = await page.evaluate(() => { const v = document.getElementById('view').viewer; const o = [...v.objs.values()].find(q => /^Frame/.test(q.part.name)); return o ? o.part.name : null; });
  const fv = await vol();
  step('the fourth face, then Make solid: a closed part of 1333 mm3', solid === 'Frame 1' && Math.abs(fv - 200 * 20 / 3) < 10, `${solid}, ${fv.toFixed(1)} mm3`);
  await page.screenshot({ path: join(OUT, 'frame-solid-1256.png') });
  // the frame stays after Make solid; B again updates the same part (no Frame 2); the part keeps its
  // frame, and Edit frame brings it back
  const kept = await page.$eval('.pathfly', e => e.textContent.match(/(\d+) points, (\d+) edges, (\d+) faces/)?.slice(1).join(' '));
  await page.keyboard.press('b'); await sleep(1200);
  const frames = await page.evaluate(() => [...document.getElementById('view').viewer.objs.values()].filter(q => /^Frame/.test(q.part.name)).map(q => q.part.name).join());
  step('after Make solid the frame stays; B again updates Frame 1, no second part', kept === '4 6 4' && frames === 'Frame 1', `${kept} | ${frames}`);
  await page.keyboard.press('v'); await sleep(200);
  const editBtn = await page.$$eval('.inspector .btn', b => b.some(x => x.textContent === 'Edit frame'));
  step('the made part has Edit frame in its panel', editBtn);
  await click('.inspector .btn', 'Edit frame'); await sleep(300);
  const back = await page.$eval('.pathfly', e => `${[...e.querySelectorAll('.pathtools .btn.go')].map(b => b.textContent).join()} ${e.textContent.match(/(\d+) points, (\d+) edges, (\d+) faces/)?.slice(1).join(' ')}`);
  step('Edit frame: back in 3D frame with the same frame', /^3D frame3,DrawD 4 6 4$/.test(back), back);
  // from the Path list too: Clear frame, Pointer, a click on the part: Edit frame (E) shows there; E brings the frame back
  await click('.pathfly .btn', 'Clear frame'); await page.keyboard.press('v'); await sleep(150);
  W.FC = [-53.3, -50, 6.7];
  const [cx, cy] = await at('FC'); await page.mouse.click(cx, cy); await sleep(300);
  const efBtn = await page.$$eval('.pathfly .btn', b => b.map(x => x.textContent).find(t => /^Edit frame/.test(t)) || 'none');
  await page.screenshot({ path: join(OUT, 'editframe-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(300);
  await page.screenshot({ path: join(OUT, 'editframe-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(300);
  await page.keyboard.press('e'); await sleep(300);
  const back2 = await page.$eval('.pathfly', e => `${[...e.querySelectorAll('.pathtools .btn.go')].map(b => b.textContent).join()} ${e.textContent.match(/(\d+) points, (\d+) edges, (\d+) faces/)?.slice(1).join(' ')}`);
  step('Pointer, click the frame part: Edit frame (E) in the Path list; E: its frame back', efBtn === 'Edit frame: Frame 1E' && /^3D frame3,DrawD 4 6 4$/.test(back2), `${efBtn} | ${back2}`);
  // locks: G draws on the plate (a point aimed 15 mm up lands at Z 0); Space locks the plane
  const boxes2 = () => page.$$eval('.pathfly label.check input', i => i.map(x => x.checked).join());
  await page.keyboard.press('g'); await sleep(150);
  await tap('A');
  W.U = [-40, -50, 15];
  const [ux, uy] = await at('U');
  await page.mouse.move(ux, uy); await sleep(200);
  const zPlate = await page.$eval('footer .msg', e => e.textContent);
  step('G: Draw on the plate is ticked, and a point aimed 15 mm up lands at Z 0', (await boxes2()) === 'true,false' && /Z 0\.00/.test(zPlate), `${await boxes2()} | ${zPlate}`);
  await page.keyboard.press(' '); await sleep(150);
  step('Space: Lock plane is ticked, and the plate lock lets go', (await boxes2()) === 'false,true', await boxes2());
  // the locked plane is the upright grid: aimed 30 mm straight over A, the point is there, upright
  W.UA = [W.A[0], W.A[1], 30];
  const [lx, ly] = await at('UA');
  await page.mouse.move(lx, ly); await sleep(200);
  const zLock = await page.$eval('footer .msg', e => e.textContent);
  // (A itself sits a step off the lattice, 1 mm up: within 0.5 mm across, 1.5 mm up)
  const [lX, lY, lZ] = (zLock.match(/X (\S+)\s+Y (\S+)\s+Z (\S+)/) || []).slice(1).map(Number);
  step('locked: a point aimed 30 mm over A lands straight over A (the plane is upright)', Math.abs(lX - W.A[0]) < 0.5 && Math.abs(lY - W.A[1]) < 1.5 && Math.abs(lZ - 30) < 1.5, zLock);
  await page.screenshot({ path: join(OUT, 'frame-lock-1256.png') });
  await page.keyboard.press(' '); await sleep(150);
  step('Space again unlocks', (await boxes2()) === 'false,false', await boxes2());
  // Space on and off with the mouse still: the grid on screen does not move, by a hair, either way
  // (from a low view, the one in the owner's screenshots)
  const cam0 = await page.evaluate(() => { const v = document.getElementById('view').viewer; return [v.camera.position.toArray(), v.controls.target.toArray()]; });
  await page.evaluate(() => { const v = document.getElementById('view').viewer; v.camera.position.set(-20, -140, 25); v.controls.target.set(-50, -40, 5); v.controls.update(); v.request(); });
  await page.mouse.move(ux, uy); await page.mouse.move(ux + 1, uy); await sleep(150);
  const gridNow = () => page.evaluate(() => { const g = document.getElementById('view').viewer.refGrid; return g.visible ? g.children.slice(0, 3).map(c => [...(c.geometry.attributes.position?.array || [])].map(x => x.toFixed(3)).join()).join('|') : 'hidden'; });
  const g0 = await gridNow(), deg0 = await page.$eval('.pathfly .note .mono', e => e.textContent);
  await page.keyboard.press(' '); await sleep(150);
  const g1 = await gridNow(), deg1 = await page.$eval('.pathfly .note .mono', e => e.textContent);
  await page.keyboard.press(' '); await sleep(150);
  const g2 = await gridNow();
  step('Space locks the grid where it stands: on and off, the grid does not move', g0 !== 'hidden' && g0 === g1 && g1 === g2 && deg0 === deg1, `${deg0} -> ${deg1}, same ${g0 === g1} ${g1 === g2}`);
  for (const [w, hh] of [[1256, 844], [1920, 1080]]) {
    await page.setViewport({ width: w, height: hh }); await sleep(300);
    await page.mouse.move(ux, uy); await sleep(150);
    await page.screenshot({ path: join(OUT, `space-off-${w}.png`) });
    await page.keyboard.press(' '); await sleep(150); await page.mouse.move(ux + 1, uy); await sleep(150);
    await page.screenshot({ path: join(OUT, `space-on-${w}.png`) });
    await page.keyboard.press(' '); await sleep(150);
  }
  await page.setViewport({ width: 1256, height: 844 }); await sleep(300);
  // fine angles: aimed 7.2 across and 3.1 along from the last point (at -59.7, -51, 1), the step is a
  // line of whole millimeters at a whole degree (8 mm at 23°), not the blocky 7 x 3 grid corner
  W.FA = [-59.7 + 7.2, -51 + 3.1, 1];
  const [fx, fy] = await at('FA'); await page.mouse.move(fx, fy); await sleep(150);
  const [qx, qy] = ((await page.$eval('footer .msg', e => e.textContent)).match(/X (\S+)\s+Y (\S+)/) || []).slice(1).map(Number);
  const len = Math.hypot(qx + 59.7, qy + 51), ang = Math.atan2(qy + 51, qx + 59.7) * 180 / Math.PI;
  step('a step from the last point is a whole-mm line at a whole degree', Math.abs(len - 8) < 0.02 && Math.abs(ang - 23) < 0.05, `${len.toFixed(3)} mm at ${ang.toFixed(2)}°`);
  await page.evaluate(([p, t]) => { const v = document.getElementById('view').viewer; v.camera.position.fromArray(p); v.controls.target.fromArray(t); v.controls.update(); v.request(); }, cam0);
  await sleep(150);
  // editing as you go: in Pointer (V) a frame point drags across its level, Shift lifts it; U takes it back
  await page.keyboard.press('v'); await sleep(150);
  const before = (await page.evaluate(() => [...document.getElementById('view').viewer.frameMarks.children[1].geometry.attributes.position.array].slice(0, 3))).map(v => +v.toFixed(2));
  const [ax, ay] = await at('A');
  const target = await page.evaluate(([x, y, z]) => { const v = document.getElementById('view').viewer, r = v.renderer.domElement.getBoundingClientRect(); const q = new v.camera.position.constructor(x + 10, y, z).project(v.camera); return [(q.x + 1) / 2 * r.width + r.left, (1 - q.y) / 2 * r.height + r.top]; }, before);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(target[0], target[1], { steps: 8 }); await page.mouse.up(); await sleep(200);
  const movedTo = await page.$eval('footer .msg', e => e.textContent);
  const pts = () => page.evaluate(() => [...document.getElementById('view').viewer.frameMarks.children[1].geometry.attributes.position.array].map(v => +v.toFixed(2)));
  const p1 = await pts();
  step('Pointer: a frame point drags 10 mm along X on its level', /Point moved/.test(movedTo) && p1.slice(0, 3).join() === [+(before[0] + 10).toFixed(2), before[1], before[2]].join(), `${p1.slice(0, 3).join()} | ${movedTo}`);
  await page.keyboard.press('3'); await sleep(100);
  await page.keyboard.press('u'); await sleep(150);
  const p2 = await pts();
  step('U takes the move back', p2.slice(0, 3).join() === before.join(), p2.slice(0, 3).join());
  // a scattered frame at several heights, for the eye: stems show which way each point went
  await page.keyboard.press('n'); await sleep(100);
  Object.assign(W, { P: [-90, -20, 0], Q: [-70, -5, 0], R2: [-45, -25, 0], S: [-25, -5, 0] });
  await tap('P');
  await lift('Q', 25); await lift('R2', 8); await lift('S', 40);
  await page.screenshot({ path: join(OUT, 'frame-scatter-1256.png') });
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(400);
  await page.screenshot({ path: join(OUT, 'frame-scatter-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(400);
  await page.keyboard.press('Escape'); await sleep(150);   // ends the strand
  await page.keyboard.press('Escape'); await sleep(150);   // closes Path

  // a typed height: the part never shows its old height while the new one builds
  await page.evaluate(() => { const v = document.getElementById('view').viewer; const o = [...v.objs.values()].find(q => q.part.kind === 'path'); v.onPick(o.part.id, 0, { shiftKey: false }); });
  await sleep(300);
  const heights = page.evaluate(() => new Promise(res => {
    const v = document.getElementById('view').viewer, id = [...v.selected][0], seen = [];
    const t0 = performance.now();
    const tick = () => {
      const o = v.objs.get(id);
      if (o) { o.mesh.geometry.computeBoundingBox(); o.mesh.updateMatrixWorld(); const b = o.mesh.geometry.boundingBox.clone().applyMatrix4(o.mesh.matrixWorld); seen.push(+(b.max.z - b.min.z).toFixed(3)); }
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(seen);
    };
    requestAnimationFrame(tick);
  }));
  for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', x => x.textContent)) === 'Height') { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('5'); await i.press('Enter'); break; }
  const hs = await heights;
  const after = hs.slice(hs.findIndex(x => x !== 1));
  step('typed height 1 -> 5: after the change it is always 5, never back to 1', after.length > 0 && after.every(x => Math.abs(x - 5) < 1e-3), [...new Set(hs)].join(', '));

  // align names, and snap faces: two boxes; the right face of the first, then the top of the
  // second: the second turns on its side, flush against that face, centered on it; Bottom then
  // puts it flush with the face's bottom edge
  await page.evaluate(() => { const v = document.getElementById('view').viewer; for (const id of [...v.objs.keys()]) if (v.objs.get(id).part.kind === 'path') v.onPick(id, 0, { shiftKey: false }); });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(200);
  await page.keyboard.press('Delete'); await sleep(400);
  for (const s of ['Box', 'Box']) { await click('.tabs button', 'Shape tools'); await click('.shapes .btn', s); await page.keyboard.press('Enter'); await sleep(600); }
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await sleep(300);
  await click('.tabs button', 'Parts');
  const names = await page.$$eval('.inspector .row.align', rows => rows.map(r => [...r.querySelectorAll('.btn')].map(b => b.textContent).join(' ')).join(' | '));
  step('align buttons say what they do', names === 'Left Middle Right | Front Middle Back | Bottom Middle Top', names);
  const faceOf = (k, nx, ny, nz) => page.evaluate((k, nx, ny, nz) => {
    const v = document.getElementById('view').viewer, o = [...v.objs.values()][k], t = o.tris;
    for (let f = 0; f < t.length / 9; f++) {
      const i = f * 9, ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], wx = t[i + 6] - t[i], wy = t[i + 7] - t[i + 1], wz = t[i + 8] - t[i + 2];
      const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx], l = Math.hypot(...n);
      if (Math.abs(n[0] / l - nx) + Math.abs(n[1] / l - ny) + Math.abs(n[2] / l - nz) < 1e-6) return [o.part.id, f];
    }
    return null;
  }, k, nx, ny, nz);
  // the moving box 8 mm, so centered and flush are different places
  const ids = await page.evaluate(() => [...document.getElementById('view').viewer.objs.keys()]);
  await page.evaluate(id => document.getElementById('view').viewer.onPick(id, 0, { shiftKey: false }), ids[1]);
  await sleep(300);
  for (const l of ['Width', 'Depth', 'Height']) {
    for (const f of await page.$$('.inspector .field')) if ((await f.$eval('label', x => x.textContent)) === l) { const i = await f.$('input'); await i.click({ clickCount: 3 }); await i.type('8'); await i.press('Enter'); await sleep(700); break; }
  }
  const [aId, aF] = await faceOf(0, 1, 0, 0), [bId, bF] = await faceOf(1, 0, 0, 1);
  await page.evaluate(() => document.getElementById('view').viewer.view('iso'));   // seen from the usual corner: up is Z
  await sleep(300);
  await menuItem('Edit', 'Snap faces');
  await page.evaluate((aId, aF, bId, bF) => { const v = document.getElementById('view').viewer; v.onPick(aId, aF, {}); v.onPick(bId, bF, {}); }, aId, aF, bId, bF);
  await sleep(800);
  const boxes = () => page.evaluate((aId, bId) => {
    const v = document.getElementById('view').viewer;
    return [aId, bId].map(id => { const o = v.objs.get(id); o.mesh.geometry.computeBoundingBox(); o.mesh.updateMatrixWorld(); const b = o.mesh.geometry.boundingBox.clone().applyMatrix4(o.mesh.matrixWorld); return [b.min.toArray(), b.max.toArray()].map(q => q.map(x => +x.toFixed(3))); });
  }, aId, bId);
  const [A, B] = await boxes();
  const ok1 = Math.abs(B[0][0] - A[1][0]) < 1e-3 && Math.abs(B[1][0] - B[0][0] - 8) < 1e-3 && Math.abs((B[0][1] + B[1][1]) / 2 - (A[0][1] + A[1][1]) / 2) < 1e-3 && Math.abs((B[0][2] + B[1][2]) / 2 - 10) < 1e-3;
  step('snap faces: the second box against the first\'s right face, centered', ok1, `A ${JSON.stringify(A)} B ${JSON.stringify(B)}`);
  await page.screenshot({ path: join(OUT, 'snap-1256.png') });
  const bar = await page.$eval('.snapbar', e => `${e.style.display} ${JSON.stringify(e.getBoundingClientRect())} ${e.textContent} parent ${e.parentElement?.id || e.parentElement?.className}`);
  if (!/Center/.test(bar)) console.log('     snap bar: ' + bar);
  await click('.snapbar .seg button', 'Bottom'); await sleep(600);
  const [, B2] = await boxes();
  step('then Bottom: flush with the face\'s bottom edge', Math.abs(B2[0][2] - A[0][2]) < 1e-3 && Math.abs(B2[0][0] - A[1][0]) < 1e-3, JSON.stringify(B2));
  await page.setViewport({ width: 1920, height: 1080 }); await sleep(500);
  await page.screenshot({ path: join(OUT, 'snap-1920.png') });
  await page.setViewport({ width: 1256, height: 844 }); await sleep(300);
  await click('.snapbar .btn', 'Done');
} catch (e) {
  fail++;
  console.log('FAIL stopped: ' + e.message);
} finally {
  await browser.close();
}
for (const e of errors) console.log('  ' + e);
console.log(fail || errors.length ? `${fail} FAILED, ${errors.length} page errors` : 'all passed');
if (fail || errors.length) process.exitCode = 1;
