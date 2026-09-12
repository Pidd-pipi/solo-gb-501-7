/*
 * 浏览器冒烟测试（jsdom）：真实加载 index.html 与全部脚本，
 * 模拟点击/表单提交，走通「建批次 → 检验 → 不合格复测 → 放行审批」主线
 * 运行：node tests/ui.smoke.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

// 注入三个脚本（与页面 <script src> 同序执行）
for (const f of ['js/data.js', 'js/store.js', 'js/app.js']) {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  window.eval(code);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); }
  else { failures++; console.error('  ✗ ' + name + (extra ? ' :: ' + extra : '')); }
}
function text(sel) { const el = window.document.querySelector(sel); return el ? el.textContent : ''; }
function click(el) {
  if (!el) throw new Error('click target missing');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickAct(act, within) {
  const el = (within || window.document).querySelector(`[data-act="${act}"]`);
  click(el);
  return el;
}
function clickClose() {
  const el = window.document.querySelector('[data-close-modal]');
  if (el) click(el);
}
function setUser(username) {
  const sel = window.document.querySelector('#userSelect');
  const u = window.SRData.USERS.find(x => x.username === username);
  sel.value = u.id;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  return u;
}
function setInput(form, name, value) {
  const el = form.elements[name];
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function modal() { return window.document.querySelector('.modal'); }

console.log('启动与渲染：');
const st0 = window.SRStore.getState();
check('首次启动自动生成演示批次（6 批）', st0.batches.length === 6, st0.batches.length);
check('总览统计卡渲染', text('#view').includes('待检批次'));
check('导航徽标有数字', text('[data-count="audit"]').length > 0);
check('审计链校验通过', window.SRStore.verifyAudit().ok);

console.log('\n角色切换与权限隔离：');
// 先重置为干净数据
window.SRStore.resetState();
window.eval; // noop
const op = setUser('op01');
check('操作员下无「录入检验结果」按钮', !text('#view').includes('录入检验结果'));
setUser('insp01');
window.location.hash = '#/inspection';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('检验员下无「登记批次」按钮', !text('#view').includes('登记批次'));
setUser('appr01');
window.location.hash = '#/approval';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('审批页只读提示不显示给审批员', !text('#view').includes('只读查看'));
setUser('op01');
window.location.hash = '#/approval';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('操作员看审批页显示只读提示', text('#view').includes('只读查看'));

console.log('\n主线 A：建批次 → 全合格 → 放行：');
setUser('op01');
window.location.hash = '#/queue';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
clickAct('create-batch');
check('登记批次弹窗打开', !!modal());
let form = window.document.querySelector('#createBatchForm');
setInput(form, 'product', '测试无菌导管 6Fr');
setInput(form, 'quantity', '3000');
setInput(form, 'sampleCount', '2');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('提交后弹窗关闭并打开批次详情', !modal() || text('.modal-title').includes('批次详情'));
const newBatch = window.SRStore.getState().batches[window.SRStore.getState().batches.length - 1];
check('新批次状态为待检', newBatch.status === 'PENDING_INSPECTION', newBatch.status);
check('自动生成 2 个待检样本', window.SRStore.getSamples(newBatch.id).length === 2);
check('成功 toast 含请求标识', text('#toastRoot').includes('请求标识'), text('#toastRoot').slice(0, 120));
// 关闭详情
clickClose();

// 检验员录入
setUser('insp01');
window.location.hash = '#/inspection';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
const pendingRows = window.document.querySelectorAll('[data-act="inspect"]').length;
check('工作台有待录入按钮（至少 2 个）', pendingRows >= 2, pendingRows);

const samples = window.SRStore.getSamples(newBatch.id);
const GOOD = { sealStrength: '2.2', visual: '合格', barrier: '合格', label: '合格' };
function fillInspection(sampleId, vals) {
  click(window.document.querySelector(`[data-act="inspect"][data-id="${sampleId}"]`));
  const f = window.document.querySelector('#inspectForm');
  check('检验弹窗标题含样本号', text('.modal-title').includes(window.SRStore.getSample(sampleId).code));
  setInput(f, 'sealStrength', vals.sealStrength);
  ['visual', 'barrier', 'label'].forEach(k => {
    const radio = f.querySelector(`input[name="${k}"][value="${vals[k]}"]`);
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  f.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
fillInspection(samples[0].id, GOOD);
check('第 1 个样本合格', window.SRStore.getSample(samples[0].id).status === 'PASS');
fillInspection(samples[1].id, GOOD);
check('第 2 个样本合格，批次进入待审批', window.SRStore.getBatch(newBatch.id).status === 'PENDING_REVIEW',
  window.SRStore.getBatch(newBatch.id).status);

// 审批员放行
setUser('appr01');
window.location.hash = '#/approval';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('审批页出现该批次', text('#view').includes(newBatch.batchNo));
check('四项检查均通过（4 个 ✅）',
  (window.document.querySelectorAll('.check-row.pass').length >= 4));
click(window.document.querySelector(`[data-act="decide"][data-id="${newBatch.id}"]`));
check('决定弹窗显示可放行横幅', text('.modal-body').includes('四项放行条件全部满足'));
form = window.document.querySelector('#decisionForm');
form.querySelector('input[name="decisionType"][value="RELEASE"]').checked = true;
setInput(form, 'note', '全项检验合格，无菌屏障完整，同意放行出厂。');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('批次已放行', window.SRStore.getBatch(newBatch.id).status === 'RELEASED',
  window.SRStore.getBatch(newBatch.id).status);
check('跳转审批页并出现放行标签', text('#view').includes('放行'));
check('审计链仍完整', window.SRStore.verifyAudit().ok);

console.log('\n主线 B：首轮不合格 → 自动待复测 → 复测合格 → 放行：');
setUser('op01');
window.location.hash = '#/queue';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
clickAct('create-batch');
form = window.document.querySelector('#createBatchForm');
setInput(form, 'product', '复测演练产品');
setInput(form, 'quantity', '1000');
setInput(form, 'sampleCount', '1');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
clickClose();
const b2 = window.SRStore.getState().batches[window.SRStore.getState().batches.length - 1];
const s2 = window.SRStore.getSamples(b2.id)[0];

setUser('insp01');
window.location.hash = '#/inspection';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
fillInspection(s2.id, { sealStrength: '1.0', visual: '合格', barrier: '不合格', label: '合格' });
check('首轮不合格 → 样本自动待复测', window.SRStore.getSample(s2.id).status === 'RETEST');
check('批次自动待复测', window.SRStore.getBatch(b2.id).status === 'PENDING_RETEST');
// 待复测区出现「发起复测」
const retestBtn = window.document.querySelector(`[data-act="retest"][data-id="${s2.id}"]`);
check('待复测样本显示发起复测按钮', !!retestBtn);
click(retestBtn);
check('发起后直接打开第 2 轮录入弹窗', text('.modal-title').includes(s2.code) && text('.modal-body').includes('第 2 轮'));
form = window.document.querySelector('#inspectForm');
setInput(form, 'sealStrength', '2.3');
['visual', 'barrier', 'label'].forEach(k => {
  const r = form.querySelector(`input[name="${k}"][value="合格"]`);
  r.checked = true; r.dispatchEvent(new window.Event('change', { bubbles: true }));
});
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('复测合格 → PASS', window.SRStore.getSample(s2.id).status === 'PASS');
check('批次回到待审批', window.SRStore.getBatch(b2.id).status === 'PENDING_REVIEW');
setUser('appr01');
const ev = window.SRStore.evaluateRelease(b2.id);
check('放行核查通过（首轮历史保留但不阻断）', ev.canRelease, JSON.stringify(ev.reasons));

console.log('\n主线 C：放行拦截（最终不合格批次）：');
setUser('op01');
window.location.hash = '#/queue';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
clickAct('create-batch');
form = window.document.querySelector('#createBatchForm');
setInput(form, 'product', '拦截演练产品');
setInput(form, 'quantity', '500');
setInput(form, 'sampleCount', '1');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
clickClose();
const b3 = window.SRStore.getState().batches[window.SRStore.getState().batches.length - 1];
const s3 = window.SRStore.getSamples(b3.id)[0];
setUser('insp01');
window.location.hash = '#/inspection';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
fillInspection(s3.id, { sealStrength: '0.8', visual: '不合格', barrier: '不合格', label: '合格' });
click(window.document.querySelector(`[data-act="retest"][data-id="${s3.id}"]`));
form = window.document.querySelector('#inspectForm');
setInput(form, 'sealStrength', '0.9');
form.querySelector('input[name="visual"][value="不合格"]').checked = true;
form.querySelector('input[name="barrier"][value="不合格"]').checked = true;
form.querySelector('input[name="label"][value="合格"]').checked = true;
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('复测仍不合格 → 最终 FAIL', window.SRStore.getSample(s3.id).status === 'FAIL');
check('批次进待审批等待处置', window.SRStore.getBatch(b3.id).status === 'PENDING_REVIEW');

setUser('appr01');
window.location.hash = '#/approval';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('审批页显示放行拦截横幅', text('#view').includes('不满足放行条件'));
click(window.document.querySelector(`[data-act="decide"][data-id="${b3.id}"]`));
const releaseRadio = window.document.querySelector('input[name="decisionType"][value="RELEASE"]');
check('弹窗中放行选项被锁定（disabled）', releaseRadio.disabled);
// 直接走领域层模拟提交放行，确认拦截错误回传 UI toast
const err = (() => { try {
  window.SRStore.submitDecision({ batchId: b3.id, type: 'RELEASE', note: '强行尝试放行看看' },
    window.SRData.USERS[2]);
} catch (e) { return e; } })();
check('领域层抛 blocked 拦截且含具体原因', err && err.blocked && /不得放行|待复测|待检|检验记录/.test(err.message), err && err.message);
// 选择隔离
form = window.document.querySelector('#decisionForm');
form.querySelector('input[name="decisionType"][value="QUARANTINE"]').checked = true;
setInput(form, 'note', '无菌屏障复测仍不合格，隔离待调查。');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
check('隔离决定生效，批次状态已同步为已隔离', window.SRStore.getBatch(b3.id).status === 'QUARANTINED');

console.log('\n审计页：');
window.location.hash = '#/audit';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
check('审计页显示链完整', text('#view').includes('链完整'));
check('审计表含操作者与请求标识', text('#view').includes('请求标识') && text('#view').includes('王建国'));
check('审计页可按动作筛选', !!window.document.querySelector('[data-act="audit-filter"][data-filter="BATCH_REGISTERED"]'));
click(window.document.querySelector('[data-filter="BATCH_REGISTERED"]'));
const regRows = window.document.querySelectorAll('.audit-row').length;
check('筛选后只剩登记批次记录', regRows === window.SRStore.getState().batches.length, regRows);

console.log('\n队列状态标签一致性：');
window.location.hash = '#/queue';
window.dispatchEvent(new window.HashChangeEvent('hashchange'));
click(window.document.querySelector('[data-act="queue-filter"][data-filter="RELEASED"]'));
check('队列已放行筛选显示已放行批次', window.document.querySelectorAll('tr.clickable .tag-RELEASED').length === 1);

console.log(`\n${failures === 0 ? '全部 UI 冒烟测试通过 ✅' : failures + ' 项失败 ❌'}`);
process.exitCode = failures ? 1 : 0;
