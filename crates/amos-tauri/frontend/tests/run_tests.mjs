// Amos System UI — comprehensive unit tests (Node, no browser needed).
// Run with:  npm test   (or:  node tests/run_tests.mjs)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.resolve(__dirname, '../js');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
const cases = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function test(name, fn) {
  cases.push({ name, fn });
}
async function runAll() {
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`  \u2713 ${name}`);
    } catch (e) {
      failed++;
      failures.push(`${name} -> ${e.message}`);
      console.error(`  \u2717 ${name}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this._listeners = {};
    this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
    this._innerHTML = '';
    this._className = '';
    this._text = '';
    this.scrollTop = 0;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) {
    if (typeof c === 'string') this._text += c; // mirror DOM text propagation
    this.children.push(c);
    return c;
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, evt) { (this._listeners[type] || []).forEach((fn) => fn(evt || {})); }
  set className(v) { this._className = v; } get className() { return this._className; }
  set textContent(v) { this._text = v; } get textContent() { return this._text; }
  set innerHTML(v) { this._innerHTML = v; this.children = []; this._text = ''; } get innerHTML() { return this._innerHTML; }
}

function makeDocument() {
  const byId = new Map();
  const getById = (id) => {
    if (!byId.has(id)) byId.set(id, new El(id));
    return byId.get(id);
  };
  return {
    createElement: (t) => new El(t),
    createTextNode: (t) => String(t),
    getElementById: getById,
    querySelector: () => null,
  };
}
function makeStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

// Build a fresh environment (core + apps) so tests are independent.
// Scripts are plain browser globals, so we run them via `new Function` with a
// per-test sandbox — this works under both bun and node (no node:vm needed).
function fresh(opts = {}) {
  const document = makeDocument();
  const localStorage = opts.noStorage
    ? {
        getItem: () => { throw new Error('storage blocked'); },
        setItem: () => { throw new Error('storage blocked'); },
        removeItem: () => { throw new Error('storage blocked'); },
      }
    : makeStorage();
  const windowObj = {
    Amos: null,
    AmosDock: ['phone', 'messages', 'camera', 'settings', 'ai'],
    __TAURI_INTERNALS__: opts.noTauri ? undefined : {
      invoke: async (cmd, _args) => {
        if (cmd === 'get_android_apps') {
          return [
            { name: '微信', package_name: 'com.tencent.mm', icon_path: '', activity: '' },
            { name: '淘宝', package_name: 'com.taobao.taobao', icon_path: '', activity: '' },
          ];
        }
        if (cmd === 'launch_android_app') {
          return { success: true, window_id: 'waydroid_demo_com.tencent.mm', error: '' };
        }
        if (cmd === 'get_android_app_icon') {
          return [137, 80, 78, 71]; // PNG signature
        }
        if (cmd === 'store_snapshot') {
          return { 'amos.settings': '{"wifi":true}', 'amos.notifications': '[]' };
        }
        if (cmd === 'system_peek_context') {
          return { source_window: 'notes', text: 'hello context for ai', timestamp_ms: 1 };
        }
        return { model: 'test', active_sessions: 0, uptime_seconds: 1 };
      },
      listen: async () => () => {},
    },
  };
  const deps = {
    window: windowObj, document, localStorage, console,
    setTimeout, clearTimeout, clearInterval, setInterval: () => 1, Date,
  };
  const names = Object.keys(deps);
  const run = (file) => {
    const src = fs.readFileSync(path.join(JS_ROOT, file), 'utf8');
    new Function(...names, src)(...names.map((n) => deps[n]));
  };
  run('core.js');
  for (const f of fs.readdirSync(path.join(JS_ROOT, 'apps'))) run('apps/' + f);
  run('nc.js'); // notification center (uses core helpers)
  const view = new El('main');
  windowObj.Amos.init(view);
  return { Amos: windowObj.Amos, AmosNc: windowObj.AmosNc, view, document, localStorage, sandbox: deps };
}

const scrollOf = (view) => view.children[0];
const gridOf = (view) => scrollOf(view).children[0];
const dockOf = (view) => scrollOf(view).children[1];

// Walk a rendered node tree looking for an element with a given `id` attribute.
function findEl(node, id) {
  if (node && node.attrs && node.attrs.id === id) return node;
  for (const c of (node && node.children) || []) {
    const r = findEl(c, id);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('\ncore');
test('el() builds nodes, sets attributes and binds events', () => {
  const e = fresh();
  const btn = e.Amos.el('button', { class: 'x', 'data-id': '1', onclick: () => {} }, 'Hi');
  assert(btn.className === 'x', 'className set');
  assert(btn.getAttribute('data-id') === '1', 'attr set');
  assert(btn.children[0] === 'Hi', 'text child appended');
  btn.dispatch('click', {});
});

test('all apps register', () => {
  const e = fresh();
  const ids = [...e.Amos.apps.keys()];
  for (const id of ['ai','calculator','camera','clock','files','maps','messages','music','notes','phone','photos','settings','weather']) {
    assert(ids.includes(id), `missing app ${id}`);
  }
});

console.log('\nhome screen');
test('home renders grid + dock with correct counts', () => {
  const e = fresh();
  const dockCount = e.sandbox.window.AmosDock.length;
  const expectedGrid = e.Amos.apps.size - dockCount;
  e.Amos.renderHome();
  assert(gridOf(e.view).children.length === expectedGrid, `grid=${gridOf(e.view).children.length}, expected ${expectedGrid}`);
  assert(dockOf(e.view).children.length === dockCount, `dock=${dockOf(e.view).children.length}`);
});

test('layout persists to localStorage', () => {
  const e = fresh();
  e.Amos.renderHome();
  const saved = e.localStorage.getItem('amos.home.layout');
  assert(saved && saved.includes('"dock"'), 'layout persisted');
});

test('jiggle mode adds remove badges and can exit', () => {
  const e = fresh();
  e.Amos.enterJiggle();
  assert(e.Amos.jiggling === true, 'entered jiggle');
  e.Amos.renderHome();
  const icons = gridOf(e.view).children;
  assert(icons.every((c) => c.children.some((cc) => cc.className === 'remove-badge')), 'badges present');
  e.Amos.exitJiggle();
  assert(e.Amos.jiggling === false, 'exited jiggle');
});

test('drag and drop moves an icon from dock to page', () => {
  const e = fresh();
  e.Amos.enterJiggle();
  e.Amos.renderHome();
  const beforeDock = dockOf(e.view).children.length;
  const beforeGrid = gridOf(e.view).children.length;
  const src = dockOf(e.view).children[0];
  const dst = gridOf(e.view).children[0];
  src.dispatch('dragstart', { dataTransfer: { setData() {} }, preventDefault() {}, classList: { add() {}, remove() {} } });
  dst.dispatch('drop', { dataTransfer: { getData: () => 'phone' }, preventDefault() {}, classList: { add() {}, remove() {} } });
  assert(dockOf(e.view).children.length === beforeDock - 1, 'dock lost one icon');
  assert(gridOf(e.view).children.length === beforeGrid + 1, 'page gained one icon');
});

test('deleting a page icon hides it and persists', () => {
  const e = fresh();
  e.Amos.enterJiggle();
  e.Amos.renderHome();
  const before = gridOf(e.view).children.length;
  const icon = gridOf(e.view).children[0];
  const badge = icon.children.find((c) => c.className === 'remove-badge');
  badge.dispatch('click', { stopPropagation() {} });
  assert(gridOf(e.view).children.length === before - 1, 'grid shrank after delete');
  const saved = JSON.parse(e.localStorage.getItem('amos.home.layout'));
  assert(saved.hidden.length === 1, 'hidden list persisted');
});

console.log('\napps');
test('every app renders and mounts/unmounts without throwing', () => {
  const e = fresh();
  for (const id of e.Amos.apps.keys()) {
    const app = e.Amos.apps.get(id);
    const node = app.render();
    assert(node && typeof node.appendChild === 'function', `${id} render returned a node`);
    if (app.onMount) app.onMount(node);
    if (app.onUnmount) app.onUnmount(node);
  }
});

console.log('\nrobustness');
test('ai app degrades gracefully without Tauri internals', () => {
  const e = fresh({ noTauri: true });
  const app = e.Amos.apps.get('ai');
  const node = app.render();
  app.onMount(node);
  assert(true, 'mount did not throw');
});

test('notes/settings/home survive blocked localStorage', () => {
  const e = fresh({ noStorage: true });
  e.Amos.renderHome();
  for (const id of ['notes', 'settings']) {
    const app = e.Amos.apps.get(id);
    const node = app.render();
    assert(node, `${id} rendered without throwing on blocked storage`);
  }
  assert(true, 'no storage access threw');
});

console.log('\nnotification center');
test('nc seeds notifications on first run', () => {
  const e = fresh();
  const notifs = JSON.parse(e.localStorage.getItem('amos.notifications'));
  assert(Array.isArray(notifs) && notifs.length === 3, 'seeded 3 notifications');
});

test('nc show/hide toggle open state', () => {
  const e = fresh();
  const nc = e.AmosNc;
  assert(nc.open === false, 'starts closed');
  nc.show();
  assert(nc.open === true, 'show opens');
  const overlay = e.document.getElementById('nc-overlay');
  assert(overlay.className.includes('open'), 'overlay has open class');
  nc.hide();
  assert(nc.open === false, 'hide closes');
});

test('nc post adds and persists a notification (newest first)', () => {
  const e = fresh();
  const before = JSON.parse(e.localStorage.getItem('amos.notifications')).length;
  e.AmosNc.post('测试', '标题', '正文', '🧪');
  const after = JSON.parse(e.localStorage.getItem('amos.notifications'));
  assert(after.length === before + 1, 'added one');
  assert(after[0].title === '标题', 'newest notification is first');
});

test('nc clearAll empties the notification list', () => {
  const e = fresh();
  e.AmosNc.clearAll();
  const after = JSON.parse(e.localStorage.getItem('amos.notifications'));
  assert(after.length === 0, 'empty after clearAll');
});

test('nc quick settings render 6 tiles in the panel', () => {
  const e = fresh();
  const overlay = e.document.getElementById('nc-overlay');
  const panel = overlay.children.find((c) => c.className === 'nc-panel');
  const quick = panel && panel.children.find((c) => c.className === 'nc-quick');
  assert(quick && quick.children.length === 6, 'rendered 6 quick-setting tiles');
});

// ---------------------------------------------------------------------------
console.log('\napp logic');
test('calculator computes 2 + 3 = 5', () => {
  const e = fresh();
  const node = e.Amos.apps.get('calculator').render();
  const content = node.children[1].children[0];
  const display = content.children[0];
  const grid = content.children[1];
  const btn = (t) => grid.children.find((b) => b.children[0] === t);
  btn('2').dispatch('click', {});
  btn('+').dispatch('click', {});
  btn('3').dispatch('click', {});
  btn('=').dispatch('click', {});
  assert(display.textContent === '5', `expected 5, got ${display.textContent}`);
});

test('calculator handles decimal and clear', () => {
  const e = fresh();
  const node = e.Amos.apps.get('calculator').render();
  const content = node.children[1].children[0];
  const display = content.children[0];
  const grid = content.children[1];
  const btn = (t) => grid.children.find((b) => b.children[0] === t);
  btn('1').dispatch('click', {});
  btn('.').dispatch('click', {});
  btn('5').dispatch('click', {});
  assert(display.textContent === '1.5', `expected 1.5, got ${display.textContent}`);
  btn('C').dispatch('click', {});
  assert(display.textContent === '0', 'clear resets to 0');
});

test('notes: adding a note persists and renders', () => {
  const e = fresh();
  const node = e.Amos.apps.get('notes').render();
  const content = node.children[1].children[0];
  const input = content.children[0];
  const saveBtn = content.children[1];
  const list = content.children[2];
  input.value = 'hello 世界';
  saveBtn.dispatch('click', {});
  assert(list.children.length === 1, 'one note rendered');
  const saved = JSON.parse(e.localStorage.getItem('amos.notes'));
  assert(saved.length === 1 && saved[0].text === 'hello 世界', 'note persisted');
});

test('messages: sending appends a user bubble', () => {
  const e = fresh();
  const node = e.Amos.apps.get('messages').render();
  const content = node.children[1].children[0];
  const body = content.children[0];
  const row = content.children[1];
  const input = row.children[0];
  const sendBtn = row.children[1];
  const before = body.children.length;
  input.value = '在吗？';
  sendBtn.dispatch('click', {});
  assert(body.children.length === before + 1, 'a bubble was appended');
});

test('settings: toggling wifi persists to amos.settings', () => {
  const e = fresh();
  const node = e.Amos.apps.get('settings').render();
  const content = node.children[1].children[0];
  const firstCard = content.children[0]; // wifi toggle
  const switchLabel = firstCard.children[1];
  const input = switchLabel.children[0];
  input.dispatch('change', { target: { checked: true } });
  const saved = JSON.parse(e.localStorage.getItem('amos.settings'));
  assert(saved.wifi === true, 'wifi toggled and persisted');
});

test('android app lists installed apps and launches via gRPC', async () => {
  const e = fresh();
  const node = e.Amos.apps.get('android').render();
  const content = node.children[1].children[0];
  const status = content.children[0];
  const recent = content.children[1];
  const grid = content.children[2];
  await new Promise((r) => setTimeout(r, 0)); // flush the invoke() promise
  assert(grid.children.length === 2, `expected 2 apps, got ${grid.children.length}`);
  // Icons are fetched and rendered as PNG data URIs.
  const img = grid.children[0].children[0].children[1]; // tile -> img
  assert(String(img.src || '').startsWith('data:image/png;base64,'), 'real icon rendered as data URI');
  const tile = grid.children[0];
  tile.dispatch('click', {});
  await new Promise((r) => setTimeout(r, 0));
  assert(status.textContent.startsWith('已启动'), `status: ${status.textContent}`);
  // Successful launch is recorded in "最近启动" and rendered.
  const recents = JSON.parse(e.localStorage.getItem('amos.android.recent'));
  assert(recents.length === 1 && recents[0].package_name === 'com.tencent.mm', 'recent launch recorded');
  assert(recent.children.some((c) => c.className === 'recent-chip'), 'recent chip rendered');
});

test('phone dialer accumulates digits', () => {
  const e = fresh();
  const node = e.Amos.apps.get('phone').render();
  const content = node.children[1].children[0];
  const display = content.children[0];
  const grid = content.children[1];
  const key = (t) => grid.children.find((b) => b.children[0] === t);
  key('1').dispatch('click', {});
  key('2').dispatch('click', {});
  key('3').dispatch('click', {});
  assert(display.textContent === '号码123', `expected 号码123, got ${display.textContent}`);
});

test('notes: deleting a note removes it', () => {
  const e = fresh();
  const node = e.Amos.apps.get('notes').render();
  const content = node.children[1].children[0];
  const input = content.children[0];
  const saveBtn = content.children[1];
  const list = content.children[2];
  input.value = 'temp';
  saveBtn.dispatch('click', {});
  assert(list.children.length === 1, 'one note added');
  const card = list.children[0];
  const delBtn = card.children[1].children[1]; // row -> delete button
  delBtn.dispatch('click', {});
  assert(!list.children.some((c) => c.className === 'card'), 'note card removed after delete');
  const saved = JSON.parse(e.localStorage.getItem('amos.notes'));
  assert(saved.length === 0, 'persisted list empty after delete');
});

test('nc dismiss removes a single notification', () => {
  const e = fresh();
  const nc = e.AmosNc;
  const before = JSON.parse(e.localStorage.getItem('amos.notifications')).length;
  nc.post('测试', '标题', '正文', '🧪');
  nc.render();
  const panel = e.document.getElementById('nc-overlay').children.find((c) => c.className === 'nc-panel');
  const notifBox = panel.children.find((c) => c.className === 'nc-notifs');
  const firstNotif = notifBox.children[0];
  const dismiss = firstNotif.children.find((c) => c.className === 'nc-dismiss');
  dismiss.dispatch('click', { stopPropagation() {} });
  const after = JSON.parse(e.localStorage.getItem('amos.notifications'));
  assert(after.length === before, 'one posted then dismissed -> net same as before');
});

test('settings: reset home layout clears it', () => {
  const e = fresh();
  e.Amos.renderHome(); // persists the default layout
  assert(e.localStorage.getItem('amos.home.layout'), 'layout exists before reset');
  const node = e.Amos.apps.get('settings').render();
  const content = node.children[1].children[0];
  const resetCard = content.children[6]; // wifi/bt/airplane/dark/brightness/volume/reset/about
  const resetBtn = resetCard.children[0].children[1];
  resetBtn.dispatch('click', {});
  assert(e.localStorage.getItem('amos.home.layout') === '', 'layout cleared after reset');
});

test('user journey: home -> calculator -> home -> android launch', async () => {
  const e = fresh();
  const A = e.Amos;
  A.renderHome();
  assert(e.view.children[0].className === 'home-scroll', 'starts on home');

  // Open calculator, compute 1+1.
  A.navigate('calculator');
  assert(e.view.children[0].className === 'app-screen', 'calculator opened');
  const cContent = e.view.children[0].children[1].children[0];
  const display = cContent.children[0];
  const grid = cContent.children[1];
  const btn = (t) => grid.children.find((b) => b.children[0] === t);
  btn('1').dispatch('click', {});
  btn('+').dispatch('click', {});
  btn('1').dispatch('click', {});
  btn('=').dispatch('click', {});
  assert(display.textContent === '2', `calculator 1+1=2, got ${display.textContent}`);

  // Back home.
  A.goHome();
  assert(e.view.children[0].className === 'home-scroll', 'back on home');

  // Open Android app and launch one.
  A.navigate('android');
  const aContent = e.view.children[0].children[1].children[0];
  const status = aContent.children[0];
  const gridA = aContent.children[2];
  await new Promise((r) => setTimeout(r, 0));
  assert(gridA.children.length === 2, 'android apps listed in journey');
  gridA.children[0].dispatch('click', {});
  await new Promise((r) => setTimeout(r, 0));
  assert(status.textContent.startsWith('已启动'), `android launched in journey: ${status.textContent}`);
});

test('multi-window helpers: exported and fall back to SPA without Tauri', () => {
  const e = fresh({ noTauri: true });
  const A = e.Amos;
  assert(typeof A.openApp === 'function', 'openApp exported');
  assert(typeof A.systemHome === 'function', 'systemHome exported');
  assert(typeof A.routeFromUrl === 'function', 'routeFromUrl exported');
  assert(A.routeFromUrl() === false, 'routeFromUrl is inert without a location');

  A.renderHome();
  A.openApp('calculator'); // no Tauri -> in-place SPA routing
  assert(e.view.children[0].className === 'app-screen', 'openApp falls back to SPA routing');
  A.systemHome(); // no Tauri -> in-place goHome
  assert(e.view.children[0].className === 'home-scroll', 'systemHome falls back to goHome');
});

test('shared store: storeWrite persists locally and applyStoreUpdate fires handlers', () => {
  const e = fresh();
  const A = e.Amos;
  let fired = null;
  const off = A.onStore('amos.settings', (v) => { fired = v; });

  A.storeWrite('amos.settings', '{"wifi":true}');
  assert(e.localStorage.getItem('amos.settings') === '{"wifi":true}', 'storeWrite persists locally');

  A.applyStoreUpdate('amos.settings', '{"wifi":false}');
  assert(fired === '{"wifi":false}', 'applyStoreUpdate fired handler');
  assert(e.localStorage.getItem('amos.settings') === '{"wifi":false}', 'local cache refreshed');

  off();
  A.applyStoreUpdate('amos.settings', '{}');
  assert(fired === '{"wifi":false}', 'handler unsubscribed after off');
});

test('hydrateStore seeds the local cache from the Rust snapshot', async () => {
  const e = fresh();
  await e.Amos.hydrateStore();
  assert(e.localStorage.getItem('amos.settings') === '{"wifi":true}', 'hydrated settings from snapshot');
  assert(e.localStorage.getItem('amos.notifications') === '[]', 'hydrated notifications from snapshot');
});

test('settings: window-manager debug card renders and degrades without Tauri', () => {
  const e = fresh({ noTauri: true });
  const node = e.Amos.apps.get('settings').render();
  const content = node.children[1].children[0];
  const wmCard = content.children[content.children.length - 1];
  const list = wmCard.children[1];
  const refreshBtn = wmCard.children[0].children[1];
  assert(list.textContent.includes('非 Tauri'), 'auto-refresh shows non-Tauri message');
  refreshBtn.dispatch('click', {});
  assert(list.textContent.includes('非 Tauri'), 'refresh keeps non-Tauri message');
});

test('home layout is store-backed and re-renders on remote reset', () => {
  const e = fresh();
  const A = e.Amos;
  A.renderHome(); // establishes + persists the default layout via storeWrite
  const persisted = e.localStorage.getItem('amos.home.layout');
  assert(persisted && persisted.includes('"dock"'), 'layout persisted via storeWrite');

  // Simulate "重置主屏布局" arriving from the Settings window.
  A.applyStoreUpdate('amos.home.layout', '');
  const after = e.localStorage.getItem('amos.home.layout');
  assert(after !== '', 'home re-rendered and re-established a default layout');
});

test('ai app shows attached system context hint', async () => {
  const e = fresh();
  const app = e.Amos.apps.get('ai');
  const node = app.render();
  app.onMount(node);
  await new Promise((r) => setTimeout(r, 0));
  const ctx = e.document.getElementById('ai-ctx');
  assert(ctx.textContent.includes('hello context'), 'context hint shown from peek');
  assert(ctx.textContent.includes('来自 notes'), 'hint names the source window');
});

test('ai app stop button aborts token rendering', () => {
  const e = fresh();
  const app = e.Amos.apps.get('ai');
  const node = app.render();
  app.onMount(node);

  const input = findEl(node, 'ai-input');
  input.value = 'hello';
  findEl(node, 'ai-send').onclick(); // .onclick is set directly (not via addEventListener)
  const log = e.document.getElementById('ai-log');
  const stop = e.document.getElementById('ai-stop');
  const AmosAi = e.sandbox.window.AmosAi;
  assert(stop.disabled === false, 'stop enabled while busy');

  const before = log.children.length; // send() appended the user's "me" bubble
  AmosAi.pushToken('第一段');
  assert(log.children.length === before + 1, 'agent token rendered before stop');

  AmosAi.stop();
  assert(stop.disabled === true, 'stop disabled after stopping');

  AmosAi.pushToken('第二段');
  assert(log.children.length === before + 1, 'no tokens rendered after stop');
});

test('notes: each note has a send-to-AI button and delete still works', () => {
  const e = fresh();
  const node = e.Amos.apps.get('notes').render();
  const content = node.children[1].children[0];
  const input = content.children[0];
  const addBtn = content.children[1];
  input.value = 'hello note';
  addBtn.dispatch('click', {});
  const card = content.children[2].children[0];
  const row = card.children[1];
  const delBtn = row.children[1]; // delete stays at index 1
  const sendBtn = row.children[2]; // send-to-AI added at index 2
  assert(sendBtn.children[0] === '发送到 AI', 'send-to-AI button present');
  assert(Array.isArray(sendBtn._listeners.click), 'send button has a click handler');
  delBtn.dispatch('click', {});
  assert(!content.children[2].children.some((c) => c.className === 'card'), 'delete still removes note');
});

// ---------------------------------------------------------------------------
await runAll();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
