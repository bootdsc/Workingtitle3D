// STEP import, in a worker of its own. The CAD reader is large, so this worker is only started
// when a STEP file is opened, and stopped again once idle. (STEP export was removed 2026-10-16.)
import occtimportjs from 'occt-import-js';
import wasmBinary from 'occt-import-js/dist/occt-import-js.wasm';
import { stepToTris } from './cadread.js';

let occt = null;
const reader = () => (occt ||= occtimportjs({ wasmBinary }));

self.onmessage = async e => {
  const m = e.data, id = m.id;
  const progress = (frac, text) => self.postMessage({ id, type: 'progress', frac, text });
  try {
    if (m.type === 'read') {
      progress(0.1, 'reading the STEP file');
      const tris = stepToTris(await reader(), new Uint8Array(m.buf));
      self.postMessage({ id, type: 'done', tris }, [tris.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', user: true, message: err.message || String(err) });
  }
};
