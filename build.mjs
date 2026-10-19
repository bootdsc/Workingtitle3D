// Builds Workingtitle3D.html: one self-contained file, double-click to run, offline.
// The worker is bundled first and handed to the main bundle as a string.
// Every folder in src/tools/ is a plugin: index.js (panel, main thread) and
// compute.js (worker). Both lists are generated, so a new tool is a new folder.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.join(root, 'src');
const out = path.join(root, 'Workingtitle3D.html');
const watch = process.argv.includes('--watch');

function toolIds() {
  const dir = path.join(src, 'tools');
  return fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'index.js'))).sort();
}

function virtuals(workerSource, cadSource = '') {
  return {
    name: 'virtuals',
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, a => ({ path: a.path, namespace: 'virtual' }));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, a => {
        const ids = toolIds();
        const rel = f => JSON.stringify(path.join(src, 'tools', f).replace(/\\/g, '/'));
        if (a.path === 'virtual:tools-ui') {
          return { contents: ids.map((id, i) => `import t${i} from ${rel(id + '/index.js')};`).join('\n')
            + `\nexport default [${ids.map((_, i) => 't' + i).join(',')}];`, resolveDir: src };
        }
        if (a.path === 'virtual:tools-compute') {
          return { contents: ids.map((id, i) => `import * as t${i} from ${rel(id + '/compute.js')};`).join('\n')
            + `\nexport default {${ids.map((id, i) => JSON.stringify(id) + ':t' + i).join(',')}};`, resolveDir: src };
        }
        if (a.path === 'virtual:worker-src') {
          return { contents: `export default ${JSON.stringify(workerSource)};`, resolveDir: src };
        }
        if (a.path === 'virtual:cad-src') {
          return { contents: `export default ${JSON.stringify(cadSource)};`, resolveDir: src };
        }
      });
    },
  };
}

// the boolean library's engine is embedded as bytes; its Node-only branches are never taken here
const common = { bundle: true, format: 'iife', target: 'es2022', minify: !watch, legalComments: 'none', write: false, logLevel: 'silent',
  loader: { '.wasm': 'binary' }, external: ['node:*', 'module'], define: { 'import.meta.url': '"file:///app/"' } };

async function build() {
  const t0 = Date.now();
  const w = await esbuild.build({ ...common, entryPoints: [path.join(src, 'core', 'worker.js')], plugins: [virtuals('')] });
  const workerSource = w.outputFiles[0].text;
  // the STEP worker: the CAD reader's Node-only branches (fs, path) are never taken in a page
  const c = await esbuild.build({ ...common, entryPoints: [path.join(src, 'core', 'cadworker.js')], plugins: [virtuals('')],
    external: [...common.external, 'fs', 'path', 'crypto', 'url', 'worker_threads', 'child_process'] });
  const cadSource = c.outputFiles[0].text;
  const m = await esbuild.build({ ...common, entryPoints: [path.join(src, 'core', 'main.js')], plugins: [virtuals(workerSource, cadSource)] });
  const js = m.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(src, 'core', 'theme.css'), 'utf8');
  // the licences travel inside the one file: our notice and licence (AGPL-3.0-or-later), and every
  // bundled library's (their terms ask for it)
  const legal = ['NOTICE', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n\n')
    .replace(/<\/script/gi, '<\\/script');
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
    .replace('/*CSS*/', () => css)
    .replace('/*JS*/', () => js)
    .replace('</body>', () => `<script type="text/plain" id="licences">\n${legal}</script>\n</body>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Workingtitle3D.html  ${(html.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms  tools: ${toolIds().join(', ')}`);
}

try {
  await build();
} catch (e) {
  console.error(e.errors ? e.errors.map(x => `${x.location?.file}:${x.location?.line} ${x.text}`).join('\n') : e);
  if (!watch) process.exit(1);
}
if (watch) {
  let timer = null;
  fs.watch(src, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch(e => console.error(e.message)), 100);
  });
  console.log('watching src/');
}
