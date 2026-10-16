// A projects folder inside the browser's own storage (IndexedDB), for browsers without folder
// access (Firefox; Brave unless its flag is on). It answers the same calls as a real folder
// handle, as far as project.js and folders.js use them, so autosave, reopen on launch and the
// projects list work the same. Files are kept as Blobs under their path; a folder is a marker
// key ending in '/'. It stays on this computer, in this browser, for this page's address.

const DB = 'workingtitle3d-files', STORE = 'files';
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => { dbp = null; rej(open.error); };
    open.onsuccess = () => res(open.result);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Browser storage refused the write (it may be full).'));
  });
}
const get = k => tx('readonly', s => s.get(k));
const put = (k, v) => tx('readwrite', s => s.put(v, k));
const keysFrom = prefix => tx('readonly', s => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));
const notFound = name => Object.assign(new Error(`${name} was not found.`), { name: 'NotFoundError' });

class FileHandle {
  constructor(path, name) { this.kind = 'file'; this.path = path; this.name = name; }
  async getFile() {
    const b = await get(this.path);
    if (b == null) throw notFound(this.name);
    return new File([b], this.name);
  }
  async createWritable({ keepExistingData = false } = {}) {
    const old = keepExistingData ? (await get(this.path)) || new Blob([]) : new Blob([]);
    const parts = [], path = this.path;
    let at = old.size, head = old;   // writes after a seek to the end append; a seek inside cuts there
    return {
      async seek(n) { if (n < head.size) head = head.slice(0, n); at = n; },
      async write(data) {
        if (data && typeof data === 'object' && 'type' in data && data.type === 'write') data = data.data;
        parts.push(data instanceof Blob || typeof data === 'string' ? data : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
        void at;
      },
      async close() { await put(path, new Blob([head, ...parts])); },
      async abort() {},
    };
  }
}

export class DirHandle {
  constructor(path = '', name = 'browser storage') { this.kind = 'directory'; this.path = path; this.name = name; this.virtual = true; }
  child(name) { return (this.path ? this.path + '/' : '') + name; }
  async getDirectoryHandle(name, { create = false } = {}) {
    const p = this.child(name);
    const there = (await get(p + '/')) != null || (await keysFrom(p + '/')).length > 0;
    if (!there) { if (!create) throw notFound(name); await put(p + '/', ''); }
    return new DirHandle(p, name);
  }
  async getFileHandle(name, { create = false } = {}) {
    const p = this.child(name);
    if ((await get(p)) == null) { if (!create) throw notFound(name); await put(p, new Blob([])); }
    return new FileHandle(p, name);
  }
  async removeEntry(name, { recursive = false } = {}) {
    const p = this.child(name);
    const under = await keysFrom(p + '/');
    if (under.length > 1 && !recursive) throw Object.assign(new Error(`${name} is not empty.`), { name: 'InvalidModificationError' });
    await tx('readwrite', s => { s.delete(p); for (const k of under) s.delete(k); });
  }
  /** Direct children: [name, handle] pairs. */
  async *entries() {
    const pre = this.path ? this.path + '/' : '';
    const seen = new Set();
    for (const k of await keysFrom(pre)) {
      const rest = k.slice(pre.length);
      if (!rest) continue;
      const i = rest.indexOf('/');
      const name = i < 0 ? rest : rest.slice(0, i);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      yield [name, i < 0 ? new FileHandle(pre + name, name) : new DirHandle(pre + name, name)];
    }
  }
  /** The path from here to a handle inside, as names, or null. */
  async resolve(h) {
    if (!h?.path || !(h.path === this.path || h.path.startsWith(this.path ? this.path + '/' : ''))) return null;
    const rest = this.path ? h.path.slice(this.path.length + 1) : h.path;
    return rest ? rest.split('/') : [];
  }
  async isSameEntry(h) { return h?.path === this.path; }
}

/** The home folder in browser storage, with projects/ inside. Asks the browser to keep it
 *  rather than clear it when space runs low (some browsers ask the user first). */
export async function browserHome() {
  const home = new DirHandle();
  await home.getDirectoryHandle('projects', { create: true });
  navigator.storage?.persist?.().catch(() => {});
  return home;
}
