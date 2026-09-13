/*
 * 浏览器层：存储损坏 → 显式恢复页 → QA 备份并恢复 → 系统可用
 *   node tests/corrupt.ui.test.js
 * 同时验证：非 QA 角色在损坏页看不到恢复按钮；运行中他页签写坏数据时本页签收到提示。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.error('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
const root = path.join(__dirname, '..');
const dataCode = fs.readFileSync(path.join(root, 'js/data.js'), 'utf8');
const storeCode = fs.readFileSync(path.join(root, 'js/store.js'), 'utf8');
const appCode = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const KEY = 'sr_system_state_v1';

function boot(initialRaw, roleUsername) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (initialRaw !== undefined) w.localStorage.setItem(KEY, initialRaw);
  w.eval(dataCode); w.eval(storeCode);
  if (roleUsername) {
    const u = w.SRData.USERS.find(x => x.username === roleUsername);
    w.sessionStorage.setItem('sr_user_id', u.id);
  }
  w.eval(appCode);
  return w;
}

function click(w, el) { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); }
function text(w, sel) { const el = w.document.querySelector(sel); return el ? el.textContent : ''; }

console.log('损坏启动：');
const corrupt = '{ "batches": [ {"id":"BAT-1", CORRUPTED';
const w1 = boot(corrupt, 'qa01');
check('损坏时显示显式报错页（非静默空库）', text(w1, '#view').includes('持久化数据已损坏'));
check('报错信息说明是 JSON 损坏', text(w1, '#view').includes('JSON'));
check('QA 可见“备份损坏数据并恢复空库”按钮', !!w1.document.querySelector('#corruptForceReset'));
check('损坏期间徽标等仍可渲染但不会自动灌演示数据', w1.SRStore.getState().batches.length === 0);

// 损坏期间写操作被领域层拒绝
let blocked = null;
try {
  w1.SRStore.createBatch({ lineId: 'L01', product: 'X', quantity: 1, sampleCount: 1 }, w1.SRData.USERS[0]);
} catch (e) { blocked = e; }
check('损坏期间登记批次被 STATE_CORRUPT 拒绝', blocked && blocked.code === 'STATE_CORRUPT');
check('损坏原文仍保留在主存储键中（未被覆盖）', w1.localStorage.getItem(KEY) === corrupt);

console.log('\n恢复：');
click(w1, w1.document.querySelector('#corruptForceReset'));
check('点击恢复后损坏原文已备份到 corrupt-backup 键', w1.localStorage.getItem(KEY + '.corrupt-backup') === corrupt);
check('主存储键已是合法结构', (() => { try { const o = JSON.parse(w1.localStorage.getItem(KEY)); return Array.isArray(o.batches); } catch (_) { return false; } })());
check('恢复后自动进入演示数据视图', text(w1, '#view').includes('待检批次'));
check('storageHealth 恢复正常', w1.SRStore.storageHealth().ok === true);
// 恢复后写操作恢复正常
const op = w1.SRData.USERS[0];
const c = w1.SRStore.createBatch({ lineId: 'L01', product: '恢复后新批次', quantity: 100, sampleCount: 1 }, op);
check('恢复后可正常登记批次', !!c.batch.id);

console.log('\n权限：');
const w2 = boot(corrupt, 'op01');
check('非 QA 角色在损坏页看不到恢复按钮', !w2.document.querySelector('#corruptForceReset'));
check('提示联系质量管理员', text(w2, '#view').includes('无恢复权限'));

console.log('\n运行中跨页签写坏：');
// 两个共享存储的页签
const shared = new Map();
function openTab(name) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w._ls = [];
  const storage = {
    getItem: k => (shared.has(k) ? shared.get(k) : null),
    setItem(k, v) {
      const oldValue = shared.has(k) ? shared.get(k) : null;
      if (oldValue === String(v)) return;
      shared.set(k, String(v));
      tabs.forEach(t => { if (t !== w) t._emit({ key: k, oldValue, newValue: String(v) }); });
    },
    removeItem: k => shared.delete(k)
  };
  Object.defineProperty(w, 'localStorage', { value: storage, configurable: true });
  w._emit = e => w._ls.forEach(fn => fn(e));
  const orig = w.addEventListener.bind(w);
  w.addEventListener = (t, fn) => { if (t === 'storage') w._ls.push(fn); else orig(t, fn); };
  tabs.push(w);
  w.eval(dataCode); w.eval(storeCode); w.eval(appCode);
  return w;
}
const tabs = [];
const A = openTab('A'), B = openTab('B');
A.SRStore.resetState();
// 会话中 B 正常使用；A 直接把共享存储写坏并向 B 派发 storage 事件
shared.set(KEY, 'GARBAGE###');
B._emit({ key: KEY, oldValue: null, newValue: 'GARBAGE###' });
check('B 收到损坏事件后显示恢复页', text(B, '#view').includes('持久化数据已损坏'));
check('B 出现损坏告警 toast', text(B, '#toastRoot').includes('损坏'));

console.log(`\n${failures === 0 ? '损坏恢复 UI 场景全部通过 ✅' : failures + ' 项失败 ❌'}`);
process.exitCode = failures ? 1 : 0;
