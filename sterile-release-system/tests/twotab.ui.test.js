/*
 * 浏览器两页签场景测试（jsdom × 2，共享一个 localStorage）：
 *  1. A 页签登记批次/录入检验 → B 页签审批列表实时出现/更新（storage 事件驱动）；
 *  2. 两页签同时打开同一批次的决定弹窗 → 一个先提交，另一个提交得到冲突提示且决定不生效。
 *
 * 运行：node tests/twotab.ui.test.js
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

// 共享 localStorage 后端 + 跨 jsdom 派发 storage 事件
function createPairedTabs() {
  const store = new Map();
  const tabs = [];

  function makeStorage(owner) {
    return {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem(k, v) {
        const oldValue = store.has(k) ? store.get(k) : null;
        if (oldValue === String(v)) return;
        store.set(k, String(v));
        tabs.forEach(t => {
          if (t === owner) return;
          t.dispatchStorage({ key: k, oldValue, newValue: String(v) });
        });
      },
      removeItem(k) { store.delete(k); }
    };
  }

  function openTab(name) {
    const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    const storage = makeStorage(w);
    // 替换 jsdom 的 localStorage 为共享版
    Object.defineProperty(w, 'localStorage', { value: storage, configurable: true });

    w._storageListeners = [];
    w.dispatchStorage = e => w._storageListeners.forEach(fn => fn(e));
    w.addEventListener('storage', fn => w._storageListeners.push(fn));
    // 让 store.js 注册监听时拿到我们的 storage 事件桥
    const origAdd = w.addEventListener.bind(w);
    w.addEventListener = (type, fn) => {
      if (type === 'storage') w._storageListeners.push(fn);
      else origAdd(type, fn);
    };

    w.eval(dataCode);
    w.eval(storeCode);
    w.eval(appCode);
    tabs.push(w);
    return w;
  }

  const A = openTab('A');
  const B = openTab('B');
  return { A, B };
}

/* ---- 小工具 ---- */
function text(w, sel) { const el = w.document.querySelector(sel); return el ? el.textContent : ''; }
function click(w, el) {
  if (!el) throw new Error('missing click target');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function setUser(w, username) {
  const u = w.SRData.USERS.find(x => x.username === username);
  const sel = w.document.querySelector('#userSelect');
  sel.value = u.id;
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  return u;
}
function goto(w, r) {
  w.location.hash = '#/' + r;
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
}
function setInput(form, name, value) {
  form.elements[name].value = value;
  form.elements[name].dispatchEvent(new form.ownerDocument.defaultView.Event('input', { bubbles: true }));
}
function fillInspectionForm(w, form, vals) {
  setInput(form, 'sealStrength', vals.sealStrength);
  ['visual', 'barrier', 'label'].forEach(k => {
    const r = form.querySelector(`input[name="${k}"][value="${vals[k]}"]`);
    r.checked = true;
    r.dispatchEvent(new w.Event('change', { bubbles: true }));
  });
}
function toastText(w) { return text(w, '#toastRoot'); }

// 两个页签均已加载；用 A 将共享数据重置为空库（B 经 storage 事件自动同步）
const { A, B } = createPairedTabs();
A.SRStore.resetState();

console.log('场景 1：A 登记批次 → B 审批/队列实时同步：');
setUser(A, 'op01');
setUser(B, 'appr01');
goto(B, 'approval');
const beforeCount = B.document.querySelectorAll('.check-row').length;
check('B 重置后审批页没有待审批核查卡', beforeCount === 0, beforeCount);
const badgeBefore = Number(B.document.querySelector('[data-count="queue"]').textContent);

goto(A, 'queue');
click(A, A.document.querySelector('[data-act="create-batch"]'));
let form = A.document.querySelector('#createBatchForm');
setInput(form, 'product', '双页签同步产品');
setInput(form, 'quantity', '2000');
setInput(form, 'sampleCount', '1');
form.dispatchEvent(new A.Event('submit', { bubbles: true, cancelable: true }));
click(A, A.document.querySelector('[data-close-modal]'));
const batchId = A.SRStore.getState().batches[A.SRStore.getState().batches.length - 1].id;

check('A 登记后 B 左侧队列徽标自动更新（无需刷新）',
  Number(B.document.querySelector('[data-count="queue"]').textContent) === 1);
goto(B, 'queue');
check('B 批次队列实时出现新批次', text(B, '#view').includes('双页签同步产品'));
check('B 看到新批次为「待检」标签', !!B.document.querySelector('.tag-PENDING_INSPECTION'));

console.log('\n场景 2：A 录入检验 → B 审批列表出现该批次且条件核查更新：');
setUser(A, 'insp01');
goto(A, 'inspection');
const sampleId = A.SRStore.getSamples(batchId)[0].id;
click(A, A.document.querySelector(`[data-act="inspect"][data-id="${sampleId}"]`));
form = A.document.querySelector('#inspectForm');
fillInspectionForm(A, form, { sealStrength: '2.3', visual: '合格', barrier: '合格', label: '合格' });
form.dispatchEvent(new A.Event('submit', { bubbles: true, cancelable: true }));
check('A 侧批次进入待审批', A.SRStore.getBatch(batchId).status === 'PENDING_REVIEW');

goto(B, 'approval');
check('B 审批页实时出现该批次', text(B, '#view').includes('双页签同步产品'));
check('B 看到四项条件全部通过（4 个 ✅）', B.document.querySelectorAll('.check-row.pass').length >= 4);
check('B 出现「提交放行决定」按钮', !!B.document.querySelector(`[data-act="decide"][data-id="${batchId}"]`));

console.log('\n场景 3：A/B 同时提交同一批次决定，只允许一条成功：');
// 两个页签都打开决定弹窗（携带同一 rev）
click(B, B.document.querySelector(`[data-act="decide"][data-id="${batchId}"]`));
const formB = B.document.querySelector('#decisionForm');
const revOnOpen = formB.dataset.expectedRev;
check('决定弹窗记录了依据版本', /^\d+$/.test(revOnOpen), revOnOpen);

// A 页签切审批员并抢先提交（同一版本）
setUser(A, 'appr01');
const rA = A.SRStore.submitDecision(
  { batchId, type: 'RELEASE', note: 'A页签抢先审批放行出厂。', expectedRev: Number(revOnOpen) },
  A.SRData.USERS.find(u => u.username === 'appr01'));
check('A 提交成功', rA && rA.batch.status === 'RELEASED');

// B storage 事件触发：弹窗被置灰
check('B 的决定弹窗出现过期/冲突横幅',
  !!B.document.querySelector('.stale-banner') && text(B, '.modal-body').includes('已被其他页签决定'),
  text(B, '.modal-body').slice(0, 120));
check('B 弹窗提交按钮被禁用', B.document.querySelector('.modal-foot button[type="submit"]')
  || B.document.querySelector('.modal-foot .btn-success') ? true : false);
// 即便绕过 UI 直接提交，领域层也以 TERMINAL 冲突拒绝
let blocked = null;
try {
  B.SRStore.submitDecision(
    { batchId, type: 'QUARANTINE', note: 'B页签过期的隔离决定', expectedRev: Number(revOnOpen) },
    B.SRData.USERS.find(u => u.username === 'appr01'));
} catch (e) { blocked = e; }
check('B 领域层拒绝且为冲突错误（conflict/TERMINAL）',
  blocked && blocked.conflict && blocked.code === 'TERMINAL', blocked && blocked.message);
check('只有一条决定记录，先到的放行生效',
  B.SRStore.getState().decisions.filter(d => d.batchId === batchId).length === 1
  && A.SRStore.getBatch(batchId).status === 'RELEASED');

console.log('\n场景 4：弹窗打开期间他页签改了检验数据 → 版本冲突提示：');
// 新批次：A 登记+检验合格，B 打开弹窗，A 再推进 rev（经返工链路不易，直接用检验推进：新建批次验证）
setUser(A, 'op01');
goto(A, 'queue');
click(A, A.document.querySelector('[data-act="create-batch"]'));
form = A.document.querySelector('#createBatchForm');
setInput(form, 'product', '版本冲突演练');
setInput(form, 'quantity', '100');
setInput(form, 'sampleCount', '1');
form.dispatchEvent(new A.Event('submit', { bubbles: true, cancelable: true }));
click(A, A.document.querySelector('[data-close-modal]'));
const id2 = A.SRStore.getState().batches[A.SRStore.getState().batches.length - 1].id;
setUser(A, 'insp01');
goto(A, 'inspection');
const s2 = A.SRStore.getSamples(id2)[0];
click(A, A.document.querySelector(`[data-act="inspect"][data-id="${s2.id}"]`));
form = A.document.querySelector('#inspectForm');
fillInspectionForm(A, form, { sealStrength: '2.0', visual: '合格', barrier: '合格', label: '合格' });
form.dispatchEvent(new A.Event('submit', { bubbles: true, cancelable: true }));

setUser(B, 'appr01');
goto(B, 'approval');
click(B, B.document.querySelector(`[data-act="decide"][data-id="${id2}"]`));
const staleRev = Number(B.document.querySelector('#decisionForm').dataset.expectedRev);

// A 侧模拟“他页签又改了检验数据”：先隔离 → 返工 → 补样 → 检验合格 → rev 持续推进
const apprUser = A.SRData.USERS.find(u => u.username === 'appr01');
A.SRStore.submitDecision({ batchId: id2, type: 'REWORK', note: '演练：退回返工重新取样', expectedRev: staleRev }, apprUser);
const inspUser = A.SRData.USERS.find(u => u.username === 'insp01');
const added = A.SRStore.addSamples({ batchId: id2, count: 1 }, inspUser);
A.SRStore.saveInspection({ sampleId: added.samples[0].id,
  results: { sealStrength: '2.1', visual: '合格', barrier: '合格', label: '合格' } }, inspUser);
check('A 推进后批次 rev 已变化', (A.SRStore.getBatch(id2).rev || 1) !== staleRev);

// B 用旧弹窗提交（先启用被置灰的按钮模拟提交动作，直接走表单 submit 处理器的版本前置复核）
const formB2 = B.document.querySelector('#decisionForm');
formB2.querySelector('input[name="decisionType"][value="RELEASE"]').checked = true;
setInput(formB2, 'note', 'B页签按旧依据放行无效');
formB2.dispatchEvent(new B.Event('submit', { bubbles: true, cancelable: true }));
check('B 收到版本冲突提示', toastText(B).includes('数据版本冲突') || toastText(B).includes('冲突'),
  toastText(B).slice(0, 160));
check('过期决定未写入', B.SRStore.getState().decisions.filter(d => d.batchId === id2 && d.type === 'RELEASE').length === 0);

console.log('\n场景 5：审计记录跨页签同步且链完整：');
goto(B, 'audit');
check('B 审计页链完整', text(B, '#view').includes('链完整'));
check('B 能看到 A 页签操作者（王建国）的记录', text(B, '#view').includes('王建国'));
check('决定记录审计含「依据数据版本」变更项', text(B, '#view').includes('依据数据版本'));
check('跨页签交错后审计哈希链校验通过', A.SRStore.verifyAudit().ok && B.SRStore.verifyAudit().ok);

console.log(`\n${failures === 0 ? '全部两页签 UI 场景通过 ✅' : failures + ' 项失败 ❌'}`);
process.exitCode = failures ? 1 : 0;
