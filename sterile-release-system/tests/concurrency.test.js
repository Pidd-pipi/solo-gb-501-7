/*
 * 多页签并发测试：node tests/concurrency.test.js
 *
 * 用共享内存的 localStorage shim 加载两个相互独立的 store 实例，
 * 模拟两个浏览器页签（各自内存状态独立，持久层共享）。
 * 覆盖：
 *  1. A 页签登记批次，B 页签不经刷新即可通过 hydrate 看到并操作新批次（写前合并）；
 *  2. A 页签录入检验后，B 页签的过期放行依据被 rev 乐观锁拦截（REV_MISMATCH）；
 *  3. 两个页签同时提交同一批次决定（相同 rev），只允许一条成功，另一条冲突；
 *  4. 后写入不会覆盖先写入（过期页签写入后，先前数据仍在）；
 *  5. storage 事件驱动的跨实例通知；
 *  6. 跨页签交错写入后审计哈希链仍连续。
 */
const assert = require('assert');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack ? e.message : e}`); process.exitCode = 1; }
}
function expectThrow(fn, fragment) {
  try { fn(); } catch (e) {
    if (fragment && !e.message.includes(fragment)) throw new Error(`报错信息不含「${fragment}」，实际：${e.message}`);
    return e;
  }
  throw new Error('预期抛错但未抛错');
}

/* ---- 共享内存 localStorage + 两个页签的 storage 事件模拟 ---- */
function createTabEnvironment() {
  const shared = new Map();
  const tabs = [];
  const KEY = 'sr_system_state_v1';

  function makeTab(name) {
    const listeners = [];
    const win = {
      localStorage: {
        getItem: k => (shared.has(k) ? shared.get(k) : null),
        setItem(k, v) {
          const oldValue = shared.has(k) ? shared.get(k) : null;
          if (oldValue === v) return;
          shared.set(k, String(v));
          // 通知其他页签（本页签不收到自己的 storage 事件，与浏览器一致）
          tabs.forEach(t => {
            if (t === win) return;
            t._dispatchStorage({ key: k, oldValue, newValue: String(v) });
          });
        },
        removeItem: k => {
          const oldValue = shared.get(k);
          shared.delete(k);
          tabs.forEach(t => { if (t !== win) t._dispatchStorage({ key: k, oldValue, newValue: null }); });
        }
      },
      addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
      _dispatchStorage(e) { listeners.forEach(fn => fn(e)); },
      _tabName: name
    };
    return win;
  }

  function loadStore(win) {
    // 每个页签独立的模块实例：独立 vm context（各自内存状态），共享传入的 localStorage
    const DataModule = require('../js/data.js');
    const storeCode = require('fs').readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
    const sandbox = {
      window: win,
      localStorage: win.localStorage,
      SRData: DataModule, // store.js UMD 在非 module.exports 环境下读 root.SRData
      module: undefined,
      exports: {},
      console,
      Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN
    };
    delete sandbox.module;
    const vm = require('vm');
    const context = vm.createContext(sandbox);
    vm.runInContext(storeCode, context);
    return sandbox.SRStore;
  }

  const winA = makeTab('A');
  const winB = makeTab('B');
  tabs.push(winA, winB);
  const A = loadStore(winA);
  const B = loadStore(winB);
  return { A, B, winA, winB };
}

const Data = require('../js/data.js');
const op = Data.USERS[0], insp = Data.USERS[1], appr = Data.USERS[2];
const GOOD = { sealStrength: '2.2', visual: '合格', barrier: '合格', label: '合格' };
const BAD = { sealStrength: '1.0', visual: '合格', barrier: '不合格', label: '合格' };

console.log('写前合并（hydrate）：');
test('A 登记批次 → B 不经刷新即可读到并操作，且 B 写入不覆盖 A 的数据', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  // 注销 B 的 storage 自动订阅，单独验证“写操作前 hydrate 合并”这一机制
  B.onExternalChange(() => {}); // noop（确保 API 存在）
  const created = A.createBatch({ lineId: 'L01', product: '跨页签产品甲', quantity: 1000, sampleCount: 1 }, op);
  const sId = A.getSamples(created.batch.id)[0].id;
  // B 直接执行写操作（内部 hydrate），不得因自己的空状态而把 A 的批次覆盖掉
  B.saveInspection({ sampleId: sId, results: GOOD }, insp);
  assert.strictEqual(B.getState().batches.length, 1);
  assert.strictEqual(A.getBatch(created.batch.id).status, 'PENDING_REVIEW');
  assert.strictEqual(A.getBatch(created.batch.id).product, '跨页签产品甲'); // A 的数据未被覆盖
  assert.strictEqual(A.getSample(sId).status, 'PASS');
  assert.strictEqual(A.getState().samples.length, 1, 'B 的写入是合并而非整份覆盖');
});

test('A 再登记批次 → B 连续操作看到两批，序列号不回退不重复', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c1 = A.createBatch({ lineId: 'L01', product: 'P1', quantity: 100, sampleCount: 1 }, op);
  const c2 = A.createBatch({ lineId: 'L02', product: 'P2', quantity: 100, sampleCount: 1 }, op);
  B.hydrate();
  assert.strictEqual(B.getState().batches.length, 2);
  const c3 = B.createBatch({ lineId: 'L03', product: 'P3', quantity: 100, sampleCount: 1 }, op);
  const nos = [c1.batch.batchNo, c2.batch.batchNo, c3.batch.batchNo];
  assert.strictEqual(new Set(nos).size, 3, '批次号必须唯一：' + nos.join(','));
});

console.log('\nstorage 事件驱动同步：');
test('A 写入 → B 收到 external change 通知并自动拿到最新 revision', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  let hits = 0, lastRev = null;
  B.onExternalChange(info => { hits++; lastRev = info.revision; });
  A.createBatch({ lineId: 'L01', product: '事件通知产品', quantity: 100, sampleCount: 1 }, op);
  assert.strictEqual(hits, 1);
  assert.ok(lastRev >= 1);
  A.createBatch({ lineId: 'L02', product: '又一批', quantity: 100, sampleCount: 1 }, op);
  assert.strictEqual(hits, 2);
  assert.ok(B.getState().revision >= 2);
});

console.log('\n提交决定前复核 + 乐观锁：');
test('B 依据旧 rev 放行，A 刚录入检验 → 版本冲突拦截，决定不写入', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c = A.createBatch({ lineId: 'L01', product: '过期放行演练', quantity: 100, sampleCount: 1 }, op);
  const s = A.getSamples(c.batch.id)[0];
  B.hydrate();
  const batchAsSeenByB = B.getBatch(c.batch.id);
  const staleRev = batchAsSeenByB.rev; // B 打开审批弹窗时拿到 rev=1（样本仍待检）

  // A 录入检验 → rev 推进，状态变待审批
  A.saveInspection({ sampleId: s.id, results: GOOD }, insp);
  assert.strictEqual(A.getBatch(c.batch.id).rev, staleRev + 1);

  // B 拿着旧 rev 提交：即使结果其实合格，也必须按“版本对不上”判冲突，不允许用过期依据放行
  const err = expectThrow(() => B.submitDecision(
    { batchId: c.batch.id, type: 'RELEASE', note: 'B页签依据旧页面放行', expectedRev: staleRev }, appr), '数据版本冲突');
  assert.strictEqual(err.conflict, true);
  assert.strictEqual(err.code, 'REV_MISMATCH');
  assert.strictEqual(err.currentRev, staleRev + 1);
  // 决定未写入，批次仍是待审批
  assert.strictEqual(A.getBatch(c.batch.id).status, 'PENDING_REVIEW');
  assert.strictEqual(B.hydrate().decisions.length, 0);

  // B 按最新数据复核（四项满足）并携带新 rev → 放行成功
  const ev = B.evaluateRelease(c.batch.id);
  assert.strictEqual(ev.canRelease, true);
  const r = B.submitDecision(
    { batchId: c.batch.id, type: 'RELEASE', note: '刷新复核后确认全项合格，放行。', expectedRev: staleRev + 1 }, appr);
  assert.strictEqual(r.batch.status, 'RELEASED');
});

test('B 依据“合格”旧视图放行，A 刚把样本复测判为最终不合格 → 复核拦截且版本冲突', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c = A.createBatch({ lineId: 'L01', product: '旧视图合格演练', quantity: 100, sampleCount: 1 }, op);
  const s = A.getSamples(c.batch.id)[0];
  A.saveInspection({ sampleId: s.id, results: GOOD }, insp); // 全合格 → 待审批
  B.hydrate();
  const revSeen = B.getBatch(c.batch.id).rev;
  assert.strictEqual(B.evaluateRelease(c.batch.id).canRelease, true);

  // A 发现误录？按真实流程：另一检验动作推进版本（补样/复测场景由重检导致不合格）
  // 这里直接模拟“他页签新增了一轮不合格信息”：通过返工补样链路构造 rev 推进并不适用，
  // 故验证版本检查优先：任何 rev 变化都会阻断旧依据提交。
  A.requestRetest; // noop 引用，保持语义说明
  // 让批次 rev 前进且条件变坏：直接走领域操作 —— 审批返工→补样→检验不合格→复测不合格
  A.submitDecision({ batchId: c.batch.id, type: 'REWORK', note: '临时返工重新取样', expectedRev: revSeen }, appr);
  const added = A.addSamples({ batchId: c.batch.id, count: 1 }, insp);
  const ns = added.samples[0];
  A.saveInspection({ sampleId: ns.id, results: BAD }, insp);
  A.requestRetest(ns.id, insp);
  A.saveInspection({ sampleId: ns.id, results: BAD }, insp); // 最终 FAIL
  assert.strictEqual(A.getBatch(c.batch.id).status, 'PENDING_REVIEW');

  // B 仍拿旧 rev 选“放行” → 冲突优先拦截
  const err = expectThrow(() => B.submitDecision(
    { batchId: c.batch.id, type: 'RELEASE', note: '按旧合格页面放行', expectedRev: revSeen }, appr), '数据版本冲突');
  assert.strictEqual(err.code, 'REV_MISMATCH');
});

console.log('\n同批次并发决定：');
test('两个页签同一时刻提交同一批次决定（相同 rev）→ 恰好一条成功，另一条终态冲突', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c = A.createBatch({ lineId: 'L01', product: '并发决定产品', quantity: 100, sampleCount: 1 }, op);
  const s = A.getSamples(c.batch.id)[0];
  A.saveInspection({ sampleId: s.id, results: GOOD }, insp);
  B.hydrate();
  const rev = B.getBatch(c.batch.id).rev;
  assert.ok(rev >= 1);

  // 两个页签几乎同时点击提交（都持有同一个 rev；乐观锁下首个落盘者获胜）
  const outcomes = [];
  function tryDecide(store, tag) {
    try {
      const r = store.submitDecision(
        { batchId: c.batch.id, type: 'RELEASE', note: `${tag}页签审批放行`, expectedRev: rev }, appr);
      outcomes.push({ tag, ok: true, status: r.batch.status });
    } catch (e) {
      outcomes.push({ tag, ok: false, conflict: e.conflict === true, code: e.code || null, message: e.message });
    }
  }
  tryDecide(A, 'A');
  tryDecide(B, 'B');

  const ok = outcomes.filter(o => o.ok);
  const fail = outcomes.filter(o => !o.ok);
  assert.strictEqual(ok.length, 1, '必须恰好一条成功：' + JSON.stringify(outcomes));
  assert.strictEqual(fail.length, 1, '必须恰好一条失败');
  assert.strictEqual(fail[0].conflict, true, '失败方必须是冲突错误');
  assert.strictEqual(fail[0].code, 'TERMINAL', '相同 rev 时后到者看到终态（已被另一页签放行）');
  assert.ok(fail[0].message.includes('已由其他操作决定'));
  // 只产生了一条决定记录
  A.hydrate();
  assert.strictEqual(A.getState().decisions.filter(d => d.batchId === c.batch.id).length, 1);
  assert.strictEqual(A.getBatch(c.batch.id).status, 'RELEASED');
});

test('两页签提交不同决定类型（放行 vs 拒收）也只允许一条，且按落盘先后裁决', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c = A.createBatch({ lineId: 'L01', product: '竞争决定产品', quantity: 100, sampleCount: 1 }, op);
  const s = A.getSamples(c.batch.id)[0];
  A.saveInspection({ sampleId: s.id, results: GOOD }, insp);
  B.hydrate();
  const rev = B.getBatch(c.batch.id).rev;

  A.submitDecision({ batchId: c.batch.id, type: 'RELEASE', note: 'A 放行', expectedRev: rev }, appr);
  const err = expectThrow(() =>
    B.submitDecision({ batchId: c.batch.id, type: 'REJECT', note: 'B 拒收', expectedRev: rev }, appr), '批次已关闭');
  assert.strictEqual(err.code, 'TERMINAL');
  assert.strictEqual(A.getBatch(c.batch.id).status, 'RELEASED'); // 先落盘的放行生效，拒收未覆盖
});

test('终态后再补录检验也被拒绝（已放行批次锁定）', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c = A.createBatch({ lineId: 'L01', product: '锁定产品', quantity: 100, sampleCount: 1 }, op);
  const s = A.getSamples(c.batch.id)[0];
  A.saveInspection({ sampleId: s.id, results: GOOD }, insp);
  B.hydrate();
  const rev = B.getBatch(c.batch.id).rev;
  B.submitDecision({ batchId: c.batch.id, type: 'RELEASE', note: '放行锁定', expectedRev: rev }, appr);
  // A 视图过期，尝试对已放行批次再操作 → hydrate 后看到终态被拒
  expectThrow(() => A.saveInspection({ sampleId: s.id, results: GOOD }, insp), '已锁定');
});

console.log('\n交错写入审计链：');
test('A/B 交错登记/检验/决定后，审计哈希链仍连续可校验', () => {
  const { A, B } = createTabEnvironment();
  A.resetState();
  const c1 = A.createBatch({ lineId: 'L01', product: '交错1', quantity: 100, sampleCount: 1 }, op);
  const c2 = B.createBatch({ lineId: 'L02', product: '交错2', quantity: 100, sampleCount: 1 }, op);
  A.saveInspection({ sampleId: A.getSamples(c1.batch.id)[0].id, results: GOOD }, insp);
  B.saveInspection({ sampleId: B.getSamples(c2.batch.id)[0].id, results: GOOD }, insp);
  const v1 = A.evaluateRelease(c1.batch.id);
  const v2 = B.evaluateRelease(c2.batch.id);
  A.submitDecision({ batchId: c1.batch.id, type: 'RELEASE', note: 'A批放行', expectedRev: v1 && A.getBatch(c1.batch.id).rev }, appr);
  B.submitDecision({ batchId: c2.batch.id, type: 'QUARANTINE', note: 'B批先隔离', expectedRev: B.getBatch(c2.batch.id).rev }, appr);

  const v = A.verifyAudit();
  assert.strictEqual(v.ok, true, v.error || '审计链断裂');
  const reqIds = A.getState().audit.map(x => x.requestId);
  assert.strictEqual(new Set(reqIds).size, reqIds.length, '跨页签请求标识也必须唯一');
});

console.log(`\n${passed} 项并发测试通过`);
