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
        if (cmd === 'transcribe_audio') {
          return { text: '转写结果', recognized: true };
        }
        if (cmd === 'translate_text') {
          return '译：' + (_args && _args.text ? _args.text : '');
        }
        if (cmd === 'interpret_start') {
          return 42;
        }
        if (cmd === 'interpret_text') {
          return { source_text: _args.text, target_text: '译：' + _args.text };
        }
        if (cmd === 'interpret_status') {
          return { session_id: 42, state: 'collecting', connected: true, source: 'auto', target: 'zh' };
        }
        if (cmd === 'tts_synthesize') {
          return { sample_rate: 16000, channels: 1, samples: new Array(160).fill(0) };
        }
        if (cmd === 'interpret_audio' || cmd === 'interpret_end_of_speech' || cmd === 'interpret_pause' || cmd === 'interpret_resume' || cmd === 'interpret_stop' || cmd === 'interpret_abort' || cmd === 'interpret_restart') {
          return { ok: true };
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
  run('cards.js'); // dynamic UI card renderer (semantic UI protocol)
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

// Walk a rendered node tree collecting elements whose className contains `cls`.
function walkClass(node, cls) {
  const out = [];
  const walk = (n) => {
    if (n && typeof n.className === 'string' && n.className.split(' ').includes(cls)) out.push(n);
    for (const c of (n && n.children) || []) walk(c);
  };
  walk(node);
  return out;
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
  // Locate the 主屏布局 reset button by text (robust to card ordering).
  const findBtn = (n) => {
    if (!n || !n.children) return null;
    for (const c of n.children) {
      if (c.tagName === 'button' && c.textContent === '重置') return c;
      const r = findBtn(c);
      if (r) return r;
    }
    return null;
  };
  const resetBtn = findBtn(content);
  assert(resetBtn, 'reset button present');
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

test('lock screen: shows and unlocks via button', () => {
  const e = fresh();
  const A = e.Amos;
  A.showLock();
  assert(A.isLocked === true, 'locked after showLock');
  assert(e.view.children[0].className === 'lock-screen', 'lock screen rendered into view');
  const btns = walkClass(e.view.children[0], 'unlock-btn');
  assert(btns.length === 1, 'one unlock button present');
  btns[0].dispatch('click', {});
  assert(A.isLocked === false, 'unlocked after tapping button');
  assert(e.view.children[0].className === 'home-scroll', 'home rendered after unlock');
});

test('lock screen: correct PIN unlocks, wrong PIN does not', () => {
  const e = fresh();
  e.localStorage.setItem('amos.lock', JSON.stringify({ enabled: true, pin: '1234' }));
  const A = e.Amos;
  A.showLock();
  assert(A.isLocked === true, 'locked with PIN enabled');
  const lockNode = e.view.children[0];
  const keys = {};
  walkClass(lockNode, 'pin-key').forEach((b) => { keys[b.children[0]] = b; });
  assert(keys['1'] && keys['✓'], 'pin pad has digit + confirm keys');

  // Wrong PIN first: still locked.
  keys['9'].dispatch('click', {});
  keys['✓'].dispatch('click', {});
  assert(A.isLocked === true, 'wrong PIN keeps device locked');

  // Correct PIN: unlocks.
  keys['1'].dispatch('click', {});
  keys['2'].dispatch('click', {});
  keys['3'].dispatch('click', {});
  keys['4'].dispatch('click', {});
  keys['✓'].dispatch('click', {});
  assert(A.isLocked === false, 'correct PIN unlocks the device');
});

test('recents: pushRecent dedupes and the switcher renders cards', () => {
  const e = fresh();
  const A = e.Amos;
  A.pushRecent('calculator');
  A.pushRecent('notes');
  A.pushRecent('calculator'); // move to front, dedupe
  const saved = JSON.parse(e.localStorage.getItem('amos.recents'));
  assert(saved.length === 2 && saved[0] === 'calculator', 'recents deduped and ordered');

  A.showRecents();
  const screen = e.view.children[0];
  assert(screen.className === 'recents-screen', 'recents screen rendered');
  const cards = screen.children[1].children; // the row
  assert(cards.length === 2, 'two recent cards shown');
  assert(cards[0].className === 'recents-card', 'first card is a recents-card');
});

test('applyTheme reads darkmode without throwing (no real DOM)', () => {
  const e = fresh();
  e.localStorage.setItem('amos.settings', JSON.stringify({ darkmode: true }));
  e.Amos.applyTheme(); // must not throw even though document.body is absent
  e.localStorage.setItem('amos.settings', JSON.stringify({ darkmode: false }));
  e.Amos.applyTheme();
});

test('openApp records the app into recents', () => {
  const e = fresh();
  e.Amos.openApp('weather');
  const saved = JSON.parse(e.localStorage.getItem('amos.recents') || '[]');
  assert(saved.includes('weather'), 'openApp pushes the app into recents');
});

test('onboarding: first-run flow persists and locks the device', () => {
  const e = fresh();
  const A = e.Amos;
  A.showOnboarding();
  let screen = e.view.children[0];
  assert(screen.className === 'onb-screen', 'onboarding rendered');

  // Welcome page → "开始" advances to the quick-settings page.
  const nexts = walkClass(screen, 'onb-next');
  assert(nexts.length === 1, 'one next button on welcome page');
  nexts[0].dispatch('click', {});
  screen = e.view.children[0];
  assert(screen.className === 'onb-screen', 'still onboarding after advancing');

  // Set a PIN, then finish.
  const pin = walkClass(screen, 'onb-pin')[0];
  pin.value = '4321';
  const finishBtn = walkClass(screen, 'onb-next')[0];
  finishBtn.dispatch('click', {});

  assert(e.localStorage.getItem('amos.onboarded') === '1', 'onboarding persisted as complete');
  const lock = JSON.parse(e.localStorage.getItem('amos.lock'));
  assert(lock.enabled === true && lock.pin === '4321', 'PIN saved from onboarding');
  assert(A.isLocked === true, 'device locked after onboarding');
});

test('onboarding: skip jumps straight to an unlocked home screen', () => {
  const e = fresh();
  const A = e.Amos;
  A.showOnboarding();
  const screen = e.view.children[0];
  const skip = walkClass(screen, 'onb-skip')[0];
  assert(skip, 'skip button present on welcome page');
  skip.dispatch('click', {});
  assert(e.localStorage.getItem('amos.onboarded') === '1', 'onboarding marked done on skip');
  assert(A.isLocked === false, 'not locked after skip');
  assert(e.view.children[0].className === 'home-scroll', 'home rendered after skip');
});

test('onboarding: finishing with no PIN lands on the unlocked home screen', () => {
  const e = fresh();
  const A = e.Amos;
  A.showOnboarding();
  walkClass(e.view.children[0], 'onb-next')[0].dispatch('click', {}); // → quick settings
  walkClass(e.view.children[0], 'onb-next')[0].dispatch('click', {}); // 完成, no PIN
  assert(e.localStorage.getItem('amos.onboarded') === '1', 'onboarding completed');
  assert(A.isLocked === false, 'unlocked with no PIN set');
  assert(e.view.children[0].className === 'home-scroll', 'home rendered after finish');
});

test('photos: gallery seeds and 拍照 adds a stored photo', () => {
  const e = fresh();
  const app = e.Amos.apps.get('photos');
  app.render(); // seeds the album on first open
  const before = JSON.parse(e.localStorage.getItem('amos.photos')).length;
  assert(before > 0, 'photos seeded on first open');

  const node = app.render();
  const addBtn = walkClass(node, 'btn').find((b) => b.children && b.children[0] === '＋ 拍照');
  assert(addBtn, 'photo add button present');
  addBtn.dispatch('click', {});
  const after = JSON.parse(e.localStorage.getItem('amos.photos')).length;
  assert(after === before + 1, 'adding a photo increments the gallery');
});

test('files: create folder and text file persist to the store', () => {
  const e = fresh();
  const app = e.Amos.apps.get('files');
  app.render(); // seeds demo entries
  assert(JSON.parse(e.localStorage.getItem('amos.files')).length > 0, 'files seeded');

  const node = app.render();
  // node = app-screen [titlebar, body]; body[0] = content; content[0] = root; root[0] = toolbar.
  const rootEl = node.children[1].children[0].children[0];
  const toolbar = rootEl.children[0];
  toolbar.children[0].dispatch('click', {}); // "＋ 文件夹"
  const nameInput = walkClass(node, 'field')[0];
  nameInput.value = '项目';
  const saveBtn = walkClass(node, 'btn').find((b) => b.children && b.children[0] === '保存');
  assert(saveBtn, 'save button present');
  saveBtn.dispatch('click', {});
  let files = JSON.parse(e.localStorage.getItem('amos.files'));
  assert(files.some((f) => f.name === '项目' && f.type === 'folder'), 'folder created and persisted');

  // Open the "＋ 文本" form (second toolbar button) and save a text file.
  toolbar.children[1].dispatch('click', {});
  const name2 = walkClass(node, 'field')[0];
  name2.value = '笔记.txt';
  const textArea = walkClass(node, 'field')[1];
  textArea.value = '你好 Amos';
  walkClass(node, 'btn').find((b) => b.children && b.children[0] === '保存').dispatch('click', {});
  files = JSON.parse(e.localStorage.getItem('amos.files'));
  assert(files.some((f) => f.name === '笔记.txt' && f.type === 'file' && f.content === '你好 Amos'), 'text file created and persisted');
});

test('camera: shutter saves a photo into the album store (demo fallback)', () => {
  const e = fresh();
  const app = e.Amos.apps.get('camera');
  const node = app.render();
  const before = JSON.parse(e.localStorage.getItem('amos.photos') || '[]').length;
  const shutter = walkClass(node, 'shutter')[0];
  assert(shutter, 'shutter button present');
  shutter.dispatch('click', {});
  const after = JSON.parse(e.localStorage.getItem('amos.photos') || '[]').length;
  assert(after === before + 1, 'capture saved one photo to the album');
});

test('maps: renders an OSM map with locate + zoom controls', () => {
  const e = fresh();
  const app = e.Amos.apps.get('maps');
  const node = app.render();
  assert(node && typeof node.appendChild === 'function', 'maps rendered without throwing');
  const locate = walkClass(node, 'btn').find((b) => b.children && b.children[0] === '📍 定位');
  assert(locate, 'locate button present');
  locate.dispatch('click', {}); // no navigator in tests → graceful "定位不可用"
  // zoom buttons exist and don't throw on click
  const zooms = walkClass(node, 'btn').filter((b) => b.children && (b.children[0] === '+' || b.children[0] === '−'));
  assert(zooms.length === 2, 'zoom in/out buttons present');
  zooms.forEach((z) => z.dispatch('click', {}));
});

test('music: seeds a playlist and play/pause + prev/next work', () => {
  const e = fresh();
  const app = e.Amos.apps.get('music');
  app.render(); // seeds the playlist
  assert(JSON.parse(e.localStorage.getItem('amos.music')).length >= 3, 'playlist seeded on first open');

  const node = app.render();
  const play = walkClass(node, 'ctl-play')[0];
  const prev = walkClass(node, 'ctl-prev')[0];
  const next = walkClass(node, 'ctl-next')[0];
  assert(play && prev && next, 'transport controls present');

  // Start playing (no AudioContext in tests → graceful fallback, no throw).
  play.dispatch('click', {});
  // Toggle to pause.
  play.dispatch('click', {});
  // Next / prev cycle without throwing.
  next.dispatch('click', {});
  prev.dispatch('click', {});
  assert(true, 'play/pause and prev/next ran without throwing');
});

test('semantic cards: AmosCards renders a dynamic UI card', () => {
  const e = fresh();
  const Cards = e.sandbox.window.AmosCards;
  assert(Cards && typeof Cards.render === 'function', 'AmosCards.render available');

  const node = Cards.render({ kind: 'weather', title: '今日天气', subtitle: '北京', fields: [{ key: '气温', value: '26°' }], actions: ['打开地图'] });
  assert(node && node.className.includes('ai-card'), 'weather card rendered');
  const title = node.children[0];
  assert(title.textContent === '今日天气', 'card title rendered in header');
  const actBtn = walkClass(node, 'btn').find((b) => b.children && b.children[0] === '打开地图');
  assert(actBtn, 'card action button present');

  // Unknown kind still renders a card (graceful fallback).
  const generic = Cards.render({ kind: 'anything', title: '通用' });
  assert(generic && generic.className.includes('ai-card'), 'generic card rendered');
  // Missing/invalid input returns null.
  assert(Cards.render(null) === null, 'null card renders nothing');
});

test('semantic cards: AI app renders a received card into the log', () => {
  const e = fresh();
  const app = e.Amos.apps.get('ai');
  const node = app.render();
  app.onMount(node);
  const AmosAi = e.sandbox.window.AmosAi;

  const log = e.document.getElementById('ai-log');
  const before = log.children.length;
  AmosAi.showCard({ kind: 'media', title: '播放《晨光》', fields: [{ key: '时长', value: '24 秒' }], actions: [] });
  assert(log.children.length === before + 1, 'card appended to the AI log');
  const card = log.children[log.children.length - 1];
  assert(card.className.includes('ai-card'), 'log contains an ai-card');
});

test('ai: conversation id is stable and reset starts a new one', () => {
  const e = fresh();
  const app = e.Amos.apps.get('ai');
  const node = app.render();
  app.onMount(node);
  const AmosAi = e.sandbox.window.AmosAi;
  const a = AmosAi.conversationId();
  const b = AmosAi.conversationId();
  assert(a === b, 'conversation id is stable within a conversation');
  assert(e.localStorage.getItem('amos.ai.session') === a, 'conversation id persisted');
  const c = AmosAi.newConversation();
  assert(c !== a, 'new conversation generates a fresh id');
  assert(AmosAi.conversationId() === c, 'new id reused after reset');
});

test('hardware buttons: home/voice/ai route to actions', () => {
  // Without Tauri, press() falls back to handle() and home goes to the launcher.
  const e = fresh({ noTauri: true });
  const B = e.sandbox.window.AmosButtons;
  assert(B && typeof B.handle === 'function', 'AmosButtons available');
  e.Amos.init(e.view);
  e.Amos.renderHome();
  B.handle('home');
  assert(e.view.children[0].className === 'home-scroll', 'home button returns to launcher');
  // voice / ai open the AI assistant without throwing.
  B.handle('voice');
  B.handle('ai');
  B.press('ai'); // no-Tauri fallback path
  assert(true, 'voice/ai handled without throwing');
});

test('hardware buttons: press goes through the Tauri command when available', () => {
  const e = fresh(); // Tauri internals present
  const B = e.sandbox.window.AmosButtons;
  assert(B && typeof B.press === 'function', 'AmosButtons.press available');
  // With Tauri, press() calls invoke('simulate_button', ...) — must not throw.
  B.press('home');
  B.press('voice');
  B.press('ai');
  assert(true, 'press() dispatched via Tauri command without throwing');
});

test('voice: transcribe and translate call the ASR/translate commands', async () => {
  const e = fresh(); // Tauri internals present
  const V = e.sandbox.window.AmosVoice;
  assert(V && typeof V.transcribe === 'function', 'AmosVoice available');

  const res = await V.transcribe([1, 2, 3], { language: 'zh', format: 'wav' });
  assert(res.recognized === true, 'transcription recognized via command');
  assert(res.text === '转写结果', 'transcription text returned');

  const translated = await V.translate('你好', { target_lang: 'en' });
  assert(translated === '译：你好', 'translate text returned');
});

test('voice: degrades gracefully without Tauri', async () => {
  const e = fresh({ noTauri: true });
  const V = e.sandbox.window.AmosVoice;
  const res = await V.transcribe([1, 2, 3]);
  assert(res.recognized === false && res.text === '', 'no-Tauri transcribe is empty');
  assert(await V.translate('x') === '', 'no-Tauri translate is empty');
});

test('interp: session lifecycle bridges commands', async () => {
  const e = fresh(); // Tauri present
  const AI = e.sandbox.window.AmosInterp;
  assert(AI && typeof AI.start === 'function', 'AmosInterp available');

  const id = await AI.start({ source: 'en', target: 'zh' });
  assert(id === 42 && AI.sessionId === 42, 'interpret_start returns the session id');

  await AI.text('hello');
  const status = await AI.status();
  assert(status && status.state === 'collecting', 'interpret_status returns the session state');

  // restart is exposed on the wrapper (no-throw).
  await AI.restart();

  // onOutput hook routes a segment_final event.
  let got = null;
  AI.onOutput = (p) => { got = p; };
  AI.onOutput({ kind: 'segment_final', source_text: 'hi', target_text: '你好', session_id: 42 });
  assert(got && got.target_text === '你好', 'onOutput receives segment_final payloads');
});

test('interp: degrades gracefully without Tauri', async () => {
  const e = fresh({ noTauri: true });
  const AI = e.sandbox.window.AmosInterp;
  assert(await AI.start() === null, 'no-Tauri start returns null');
  await AI.text('hi'); // no-throw
  assert(await AI.status() === null, 'no-Tauri status is null');
});

test('interpreter app: registers, renders, and wires session', () => {
  const e = fresh();
  const app = e.Amos.apps.get('interpreter');
  assert(app, 'interpreter app registered');
  const node = app.render();
  assert(node, 'interpreter rendered a node');
  app.onMount(node);
  const AI = e.sandbox.window.AmosInterp;
  assert(typeof AI.onOutput === 'function', 'onOutput wired');
  // Feed outputs through the app's handler (against the stub DOM, no throw).
  AI.onOutput({ kind: 'partial', text: '你好' });
  AI.onOutput({ kind: 'segment_final', source_text: 'hello', target_text: '你好', target_lang: 'zh', session_id: 1 });
  AI.onOutput({ kind: 'session_ended', session_id: 1 });
  assert(true, 'session outputs handled without throwing');
  app.onUnmount();
});

test('interpreter app degrades without Tauri', () => {
  const e = fresh({ noTauri: true });
  const app = e.Amos.apps.get('interpreter');
  const node = app.render();
  app.onMount(node); // must not throw; status shows "非 Tauri"
  assert(true, 'interpreter mounts without Tauri');
});

test('tts: synthesize returns playable audio via command', async () => {
  const e = fresh();
  const T = e.sandbox.window.AmosTts;
  const p = await T.synthesize('你好', { lang: 'zh' });
  assert(p && p.sample_rate === 16000 && Array.isArray(p.samples), 'tts payload is playable audio');

  const e2 = fresh({ noTauri: true });
  assert(await e2.sandbox.window.AmosTts.synthesize('x') === null, 'no-Tauri tts is null');
});

test('headless interp UI smoke: renders partial then a segment with speak button', () => {
  const e = fresh();
  const app = e.Amos.apps.get('interpreter');
  const node = app.render();
  app.onMount(node);
  const AI = e.sandbox.window.AmosInterp;
  const log = e.document.getElementById('interp-log');

  AI.onOutput({ kind: 'partial', text: '你好' });
  assert(log.children.length >= 1 && String(log.children[0].textContent).includes('你好'),
    'partial is rendered');

  AI.onOutput({ kind: 'segment_final', source_text: 'hello', target_text: '你好', target_lang: 'zh', session_id: 1 });
  const segRow = log.children[log.children.length - 1];
  const srcText = segRow.children[0] && String(segRow.children[0].textContent);
  const tgtText = segRow.children[1] && String(segRow.children[1].textContent);
  assert(srcText === 'hello' && tgtText === '你好',
    `segment shows source + target: src=${srcText} tgt=${tgtText}`);
  const btn = segRow.children && segRow.children[2];
  assert(btn && btn.tagName === 'button', 'segment has a 🔊 朗读 button');
  btn.dispatch('click', {}); // speak() must not throw (no AudioContext in tests)
  app.onUnmount();
});

test('headless interp UI: auto-speak synthesizes each translation', () => {
  const e = fresh();
  const app = e.Amos.apps.get('interpreter');
  const node = app.render();
  app.onMount(node);
  let spoken = [];
  e.sandbox.window.AmosTts.synthesize = async (text) => { spoken.push(text); return { sample_rate: 16000, channels: 1, samples: [] }; };
  // Enable auto-read-aloud.
  e.document.getElementById('interp-autospeak').checked = true;

  const AI = e.sandbox.window.AmosInterp;
  AI.onOutput({ kind: 'segment_final', source_text: 'hello', target_text: '你好', target_lang: 'zh', session_id: 1 });
  assert(spoken.includes('你好'), 'auto-speak synthesized the translation: ' + JSON.stringify(spoken));
  app.onUnmount();
});

test('headless interp UI: restores a running session on mount', async () => {
  const e = fresh();
  const app = e.Amos.apps.get('interpreter');
  const node = app.render();
  app.onMount(node);
  // interpret_status mock reports an active session (id 42, collecting).
  await new Promise((r) => setTimeout(r, 0)); // flush the async status()
  const startBtn = e.document.getElementById('interp-start');
  assert(startBtn.disabled === true, 'start is disabled when a session is running');
  assert(
    String(e.document.getElementById('interp-status').textContent).includes('会话运行中'),
    'status reflects the running session'
  );
  app.onUnmount();
});

test('interp UI: level meter, copy button, and clear controls', () => {
  const e = fresh();
  const app = e.Amos.apps.get('interpreter');
  const node = app.render();
  app.onMount();
  const meter = findEl(node, 'interp-meter');
  assert(meter && meter.children.length === 10, 'recording level meter renders 10 bars');

  const AI = e.sandbox.window.AmosInterp;
  AI.onOutput({ kind: 'segment_final', source_text: 'hello', target_text: '你好', target_lang: 'zh', session_id: 1 });
  const log = e.document.getElementById('interp-log');
  const seg = log.children[log.children.length - 1];
  assert(seg.children[0].textContent === 'hello', 'source is segment child [0]');
  assert(seg.children[1].textContent === '你好', 'translation is segment child [1]');
  assert(seg.children[2] && seg.children[2].tagName === 'button' && seg.children[2].textContent.includes('朗读'),
    'speak button stays at segment child [2]');
  assert(seg.children[3] && seg.children[3].tagName === 'button' && seg.children[3].textContent.includes('复制'),
    'copy button added at segment child [3]');

  seg.children[3].dispatch('click', {}); // must not throw when clipboard is unavailable

  const clearBtn = findEl(node, 'interp-clear');
  assert(clearBtn, 'clear button present');
  clearBtn.dispatch('click', {});
  assert(log.children.length === 0, 'clear empties the transcript');
  app.onUnmount();
});

test('interp UI: restores saved language pair and auto-speak, persists edits', () => {
  const e = fresh();
  e.localStorage.setItem('amos.interp', JSON.stringify({ source: 'en', target: 'ja', autospeak: true }));
  const app = e.Amos.apps.get('interpreter');
  app.render();
  app.onMount();
  assert(e.document.getElementById('interp-source').value === 'en', 'source restored from prefs');
  assert(e.document.getElementById('interp-target').value === 'ja', 'target restored from prefs');
  assert(e.document.getElementById('interp-autospeak').checked === true, 'auto-speak restored from prefs');
  e.document.getElementById('interp-target').value = 'fr';
  e.document.getElementById('interp-target').dispatch('change', {});
  const saved = JSON.parse(e.localStorage.getItem('amos.interp'));
  assert(saved && saved.target === 'fr', 'changing the target persists the preference');
  app.onUnmount();
});

test('theme: automatic appearance follows local hour', () => {
  const e = fresh();
  const A = e.Amos;
  assert(A.decideDark(false, false, 14) === true, 'default (no darkmode) is dark');
  assert(A.decideDark(true, false, 14) === false, 'darkmode on => light');
  assert(A.decideDark(false, true, 3) === true, 'auto at 03:00 => dark');
  assert(A.decideDark(false, true, 14) === false, 'auto at 14:00 => light');
  assert(A.decideDark(false, true, 21) === true, 'auto at 21:00 => dark');
  assert(A.decideDark(true, true, 12) === false, 'auto overrides darkmode at noon => light');
  assert(A.decideDark(false, true, 6.9) === true, 'auto at 06:54 still dark');
  assert(A.decideDark(false, true, 7.1) === false, 'auto at 07:06 light');
});

test('wallpaper: resolution, presets, and custom URLs', () => {
  const e = fresh();
  const A = e.Amos;
  assert(Array.isArray(A.wallpaperPresets) && A.wallpaperPresets.length >= 4, 'wallpaper presets exported');
  assert(A.resolveWallpaper(true, undefined).includes('dark'), 'dark theme default → dark wallpaper');
  assert(A.resolveWallpaper(false, undefined).includes('light'), 'light theme default → light wallpaper');
  assert(A.resolveWallpaper(false, 'landscape').includes('landscape'), 'landscape preset resolves');
  assert(A.resolveWallpaper(false, 'dark').includes('dark'), 'explicit dark preset wins in light theme');
  assert(A.resolveWallpaper(false, 'https://x/img.jpg') === 'https://x/img.jpg', 'custom http url passes through');
  assert(A.isCustomWallpaper('data:image/png;base64,AAAA') === true, 'data: url is treated as custom');
  assert(A.isCustomWallpaper('dark') === false, 'built-in ids are not custom');
});

// ---------------------------------------------------------------------------
await runAll();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:\n  ' + failures.join('\n  '));
  process.exit(1);
}
