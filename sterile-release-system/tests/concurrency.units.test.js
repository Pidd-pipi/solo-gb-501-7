/* ============================================================
 * 并发、版本控制与失败分支单元测试（可重复运行，结果确定）
 *   node tests/concurrency.units.test.js
 *
 * 覆盖矩阵：
 *  A. 并发裁决
 *     A1 两页签持同一版本同时放行        → 恰好一条成功，另一条 TERMINAL 冲突
 *     A2 两页签持不同决定竞争            → 先落盘者胜，后到者被拒，只留一条决定
 *     A3 连续重复提交同一批次决定        → 第二次冲突，不产生第二条记录
 *     A4 持过期 rev 提交                 → REV_MISMATCH，决定不写入
 *     A5 过期页签提交时按当前数据复核    → 当前不合格则 RELEASE 仍被放行硬条件拦截
 *  B. 写前合并
 *     B1 A 登记后 B（空视图）写检验      → hydrate 合并，A 的批次不被覆盖
 *     B2 A/B 交错多轮写入                → 两边记录都在，序列号/批次号不回退不重复
 *     B3 跨页签审计链连续、请求标识唯一
 *  C. 阈值上下限（1.5~3.0，含等号边界）
 *     C1 下限 1.5 / 上限 3.0 合格
 *     C2 1.49 / 3.01 不合格 → 自动待复测
 *  D. 审计篡改
 *     D1 改一条变更内容 → 内容哈希断链
 *     D2 删一条记录     → 前序哈希断链
 *  E. 存储损坏（显式报错，禁止静默丢数据）
 *     E1 JSON 语法损坏     → 启动 getLoadError 有 STATE_CORRUPT；写操作拒绝
 *     E2 缺关键字段数组    → STATE_CORRUPT
 *     E3 revision 类型错误 → STATE_CORRUPT；revision 缺失则兼容迁移
 *     E4 运行期持久层被外部写坏 → 下一次写操作 hydrate 抛 STATE_CORRUPT
 *     E5 forceReset 先备份损坏原文再恢复；损坏原文移入 corrupt-backup 键
 * ============================================================ */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Data = require('../js/data.js');

let passed = 0;
function test(group, name, fn) {
  try { fn(); passed++; console.log(`  ✓ [${group}] ${name}`); }
  catch (e) { console.error(`  ✗ [${group}] ${name}\n    ${e.message}`); process.exitCode = 1; }
}
function expectThrow(fn, codeOrFragment) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error('预期抛错但成功执行');
  if (codeOrFragment) {
    const match = thrown.code === codeOrFragment || thrown.message.includes(codeOrFragment);
    if (!match) throw new Error(`错误不匹配「${codeOrFragment}」，实际 code=${thrown.code} msg=${thrown.message}`);
  }
  return thrown;
}

/* ---------- 确定性双页签环境（共享内存 localStorage + 可控 storage 事件） ---------- */
const STORE_KEY = 'sr_system_state_v1';
function createEnv() {
  const shared = new Map();
  const tabs = [];

  function makeWindow(name) {
    const listeners = [];
    const win = {
      name,
      localStorage: {
        getItem: k => (shared.has(k) ? shared.get(k) : null),
        setItem(k, v) {
          const oldValue = shared.has(k) ? shared.get(k) : null;
          const value = String(v);
          if (oldValue === value) return;
          shared.set(k, value);
          tabs.forEach(t => { if (t !== win) t._emit({ key: k, oldValue, newValue: value }); });
        },
        removeItem(k) {
          const oldValue = shared.has(k) ? shared.get(k) : null;
          if (!shared.has(k)) return;
          shared.delete(k);
          tabs.forEach(t => { if (t !== win) t._emit({ key: k, oldValue, newValue: null }); });
        }
      },
      addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
      _emit(e) { listeners.slice().forEach(fn => fn(e)); }
    };
    return win;
  }

  function loadInto(win) {
    const sandbox = {
      window: win,
      localStorage: win.localStorage,
      SRData: Data,
      console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sandbox);
    return sandbox.SRStore;
  }

  const winA = makeWindow('A'), winB = makeWindow('B');
  tabs.push(winA, winB);
  const A = loadInto(winA), B = loadInto(winB);
  return {
    A, B,
    // 测试专用：直接操作共享持久层（模拟磁盘损坏/手工篡改）
    raw: () => (shared.has(STORE_KEY) ? shared.get(STORE_KEY) : null),
    setRaw: v => shared.set(STORE_KEY, v),
    setRawObject: o => shared.set(STORE_KEY, JSON.stringify(o)),
    deleteRaw: () => shared.delete(STORE_KEY),
    getBackup: () => (shared.has(STORE_KEY + '.corrupt-backup') ? shared.get(STORE_KEY + '.corrupt-backup') : null),
    // 直接派发一条 storage 事件（模拟外部程序写入任意字符串）
    emitExternal: (win, newValue) => win._emit({ key: STORE_KEY, oldValue: shared.get(STORE_KEY) || null, newValue })
  };
}

/* ---------- 固定角色与结果 ---------- */
const op = Data.USERS[0], insp = Data.USERS[1], appr = Data.USERS[2], qa = Data.USERS[3];
const GOOD = { sealStrength: '2.2', visual: '合格', barrier: '合格', label: '合格' };
const BAD = { sealStrength: '1.0', visual: '合格', barrier: '不合格', label: '合格' };

function readyBatch(S, result = GOOD, sampleCount = 1) {
  const c = S.createBatch({ lineId: 'L01', product: '并发单元测试产品', quantity: 1000, sampleCount }, op);
  S.getSamples(c.batch.id).forEach(s => S.saveInspection({ sampleId: s.id, results: result }, insp));
  return S.getBatch(c.batch.id);
}

/* ============================================================
 * A. 并发裁决
 * ============================================================ */
console.log('A. 并发裁决');

test('A1', '两页签持同一版本同时放行 → 恰好一条成功，另一条 TERMINAL 冲突', () => {
  const env = createEnv();
  env.A.resetState();
  const batch = readyBatch(env.A);
  env.B.hydrate();
  const rev = env.B.getBatch(batch.id).rev;

  const outcomes = [];
  [env.A, env.B].forEach((S, i) => {
    try {
      const r = S.submitDecision({ batchId: batch.id, type: 'RELEASE', note: `页签${i}同时放行`, expectedRev: rev }, appr);
      outcomes.push({ ok: true, status: r.batch.status });
    } catch (e) { outcomes.push({ ok: false, code: e.code, conflict: e.conflict }); }
  });
  assert.strictEqual(outcomes.filter(o => o.ok).length, 1);
  const loser = outcomes.find(o => !o.ok);
  assert.strictEqual(loser.code, 'TERMINAL');
  assert.strictEqual(loser.conflict, true);
  // 只写入一条决定；批次终态
  assert.strictEqual(env.A.getState().decisions.filter(d => d.batchId === batch.id).length, 1);
  assert.strictEqual(env.A.getBatch(batch.id).status, 'RELEASED');
});

test('A2', '两页签竞争不同决定（放行 vs 拒收）→ 先落盘者生效，后到冲突且不覆盖', () => {
  const env = createEnv();
  env.A.resetState();
  const batch = readyBatch(env.A);
  env.B.hydrate();
  const rev = env.B.getBatch(batch.id).rev;

  env.A.submitDecision({ batchId: batch.id, type: 'RELEASE', note: 'A 先放行', expectedRev: rev }, appr);
  const e = expectThrow(
    () => env.B.submitDecision({ batchId: batch.id, type: 'REJECT', note: 'B 后拒收', expectedRev: rev }, appr),
    'TERMINAL');
  assert.ok(e.message.includes('已由其他操作决定'));
  assert.strictEqual(env.A.getBatch(batch.id).status, 'RELEASED');
  assert.strictEqual(env.A.getState().decisions.length, 1);
});

test('A3', '同一页签对同一批次连续重复提交 → 第二次冲突，不产生第二条决定', () => {
  const env = createEnv();
  env.A.resetState();
  const batch = readyBatch(env.A);
  const rev = env.A.getBatch(batch.id).rev;
  const r1 = env.A.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '首次放行依据', expectedRev: rev }, appr);
  assert.strictEqual(r1.batch.status, 'RELEASED');
  const e = expectThrow(
    () => env.A.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '重复放行依据', expectedRev: rev }, appr),
    'TERMINAL');
  assert.ok(e.conflict);
  assert.strictEqual(env.A.getState().decisions.filter(d => d.batchId === batch.id).length, 1);
});

test('A4', '页面持过期 rev 提交（期间他页签录入了检验）→ REV_MISMATCH，决定不写入', () => {
  const env = createEnv();
  env.A.resetState();
  // A 登记 2 样本：先检 1 个，此时批次待复测/待检；B 记下 rev
  const c = env.A.createBatch({ lineId: 'L01', product: '过期版本', quantity: 100, sampleCount: 2 }, op);
  env.B.hydrate();
  const staleRev = env.B.getBatch(c.batch.id).rev;
  // A 录入两个样本（合格），rev 推进两次
  env.A.getSamples(c.batch.id).forEach(s => env.A.saveInspection({ sampleId: s.id, results: GOOD }, insp));
  assert.notStrictEqual(env.A.getBatch(c.batch.id).rev, staleRev);

  const e = expectThrow(
    () => env.B.submitDecision({ batchId: c.batch.id, type: 'RELEASE', note: '拿旧版本放行', expectedRev: staleRev }, appr),
    '数据版本冲突');
  assert.strictEqual(e.code, 'REV_MISMATCH');
  assert.strictEqual(e.conflict, true);
  assert.strictEqual(e.expectedRev, staleRev);
  assert.strictEqual(e.currentRev, env.A.getBatch(c.batch.id).rev);
  // 决定确实未写入，批次仍待审批
  assert.strictEqual(env.A.getState().decisions.length, 0);
  assert.strictEqual(env.A.getBatch(c.batch.id).status, 'PENDING_REVIEW');
});

test('A5', '版本一致但他页签刚把数据改坏（最终不合格）→ RELEASE 被当前数据复核拦截', () => {
  const env = createEnv();
  env.A.resetState();
  // 构造最终不合格但处于待审批的批次
  const c = env.A.createBatch({ lineId: 'L01', product: '复核拦截', quantity: 100, sampleCount: 1 }, op);
  const s = env.A.getSamples(c.batch.id)[0];
  env.A.saveInspection({ sampleId: s.id, results: BAD }, insp);
  env.A.requestRetest(s.id, insp);
  env.A.saveInspection({ sampleId: s.id, results: BAD }, insp); // 复测仍不合格 → FAIL
  const batch = env.A.getBatch(c.batch.id);
  assert.strictEqual(batch.status, 'PENDING_REVIEW');
  const rev = batch.rev;
  env.B.hydrate();
  // B 持“当前”版本（版本检查通过），但放行硬条件复核必须失败
  const e = expectThrow(
    () => env.B.submitDecision({ batchId: c.batch.id, type: 'RELEASE', note: '尝试放行不合格批次', expectedRev: rev }, appr),
    '放行被拦截');
  assert.strictEqual(e.blocked, true);
  assert.ok(e.evaluation.reasons.some(r => r.includes('最终判定不合格')));
  assert.strictEqual(env.A.getBatch(c.batch.id).status, 'PENDING_REVIEW');
  // 不合格处置（隔离）不受放行条件限制，可正常提交
  const r = env.B.submitDecision({ batchId: c.batch.id, type: 'QUARANTINE', note: '不合格隔离调查', expectedRev: rev }, appr);
  assert.strictEqual(r.batch.status, 'QUARANTINED');
});

/* ============================================================
 * B. 写前合并
 * ============================================================ */
console.log('\nB. 写前合并');

test('B1', 'A 登记批次后，持空视图的 B 写检验 → hydrate 合并，A 的批次与样本不被覆盖', () => {
  const env = createEnv();
  env.A.resetState();
  const c = env.A.createBatch({ lineId: 'L02', product: '不能丢的批次', quantity: 500, sampleCount: 2 }, op);
  // B 的内存视图是 reset 后的空库；不调用 hydrate 直接写
  const s0 = c.samples[0].id;
  env.B.saveInspection({ sampleId: s0, results: GOOD }, insp);
  // A 先写入的两个样本都在
  const all = env.A.getSamples(c.batch.id);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(env.A.getBatch(c.batch.id).product, '不能丢的批次');
  assert.strictEqual(env.A.getSample(s0).status, 'PASS');
  // 另一个样本仍待检，批次尚未到待审批
  assert.strictEqual(env.A.getBatch(c.batch.id).status, 'PENDING_INSPECTION');
});

test('B2', 'A/B 交错登记与检验 → 全部记录保留，批次号与 ID 不重复不回退', () => {
  const env = createEnv();
  env.A.resetState();
  const c1 = env.A.createBatch({ lineId: 'L01', product: 'A1', quantity: 10, sampleCount: 1 }, op);
  const c2 = env.B.createBatch({ lineId: 'L02', product: 'B1', quantity: 10, sampleCount: 1 }, op);
  env.A.saveInspection({ sampleId: env.A.getSamples(c1.batch.id)[0].id, results: GOOD }, insp);
  const c3 = env.A.createBatch({ lineId: 'L03', product: 'A2', quantity: 10, sampleCount: 1 }, op);
  env.B.saveInspection({ sampleId: env.B.getSamples(c2.batch.id)[0].id, results: GOOD }, insp);

  const st = env.A.getState();
  assert.strictEqual(st.batches.length, 3);
  assert.deepStrictEqual(st.batches.map(b => b.product).sort(), ['A1', 'A2', 'B1']);
  assert.strictEqual(new Set(st.batches.map(b => b.id)).size, 3);
  assert.strictEqual(new Set(st.batches.map(b => b.batchNo)).size, 3);
  assert.strictEqual(new Set(st.samples.map(s => s.id)).size, 3);
  assert.strictEqual(st.seq.batch, 3);
});

test('B3', '跨页签交错写入后审计哈希链连续，请求标识全局唯一', () => {
  const env = createEnv();
  env.A.resetState();
  const c1 = env.A.createBatch({ lineId: 'L01', product: '链1', quantity: 10, sampleCount: 1 }, op);
  const c2 = env.B.createBatch({ lineId: 'L02', product: '链2', quantity: 10, sampleCount: 1 }, op);
  env.A.saveInspection({ sampleId: env.A.getSamples(c1.batch.id)[0].id, results: GOOD }, insp);
  env.B.saveInspection({ sampleId: env.B.getSamples(c2.batch.id)[0].id, results: GOOD }, insp);
  env.A.submitDecision({ batchId: c1.batch.id, type: 'RELEASE', note: 'A 放行', expectedRev: env.A.getBatch(c1.batch.id).rev }, appr);
  env.B.submitDecision({ batchId: c2.batch.id, type: 'QUARANTINE', note: 'B 隔离', expectedRev: env.B.getBatch(c2.batch.id).rev }, appr);

  const vA = env.A.verifyAudit(), vB = env.B.verifyAudit();
  assert.strictEqual(vA.ok, true, vA.error);
  assert.strictEqual(vB.ok, true, vB.error);
  const ids = env.A.getState().audit.map(a => a.requestId);
  assert.strictEqual(new Set(ids).size, ids.length);
  // 决定审计含“依据数据版本”
  assert.ok(env.A.getState().audit.some(a =>
    a.action === 'DECISION_SUBMITTED' && a.changes.some(ch => ch.label === '依据数据版本')));
});

/* ============================================================
 * C. 阈值上下限
 * ============================================================ */
console.log('\nC. 阈值上下限（密封强度 1.5~3.0 N/15mm，含等号）');

function singleSample(S, strength) {
  const c = S.createBatch({ lineId: 'L01', product: '阈值', quantity: 10, sampleCount: 1 }, op);
  const s = S.getSamples(c.batch.id)[0];
  return S.saveInspection({ sampleId: s.id,
    results: { sealStrength: strength, visual: '合格', barrier: '合格', label: '合格' } }, insp);
}

test('C1a', '恰好等于下限 1.5 → 合格', () => {
  const env = createEnv(); env.A.resetState();
  assert.strictEqual(singleSample(env.A, '1.5').sample.status, 'PASS');
});
test('C1b', '恰好等于上限 3.0 → 合格', () => {
  const env = createEnv(); env.A.resetState();
  assert.strictEqual(singleSample(env.A, '3.0').sample.status, 'PASS');
});
test('C1c', '区间内 2.25 → 合格', () => {
  const env = createEnv(); env.A.resetState();
  assert.strictEqual(singleSample(env.A, '2.25').sample.status, 'PASS');
});
test('C2a', '低于下限 1.49 → 不合格，自动待复测', () => {
  const env = createEnv(); env.A.resetState();
  const r = singleSample(env.A, '1.49');
  assert.strictEqual(r.sample.status, 'RETEST');
  assert.strictEqual(r.batch.status, 'PENDING_RETEST');
});
test('C2b', '高于上限 3.01 → 不合格，自动待复测', () => {
  const env = createEnv(); env.A.resetState();
  const r = singleSample(env.A, '3.01');
  assert.strictEqual(r.sample.status, 'RETEST');
});
test('C2c', '非数值密封强度 → 输入校验报错，不写入', () => {
  const env = createEnv(); env.A.resetState();
  const c = env.A.createBatch({ lineId: 'L01', product: '阈值', quantity: 10, sampleCount: 1 }, op);
  const s = env.A.getSamples(c.batch.id)[0];
  expectThrow(() => env.A.saveInspection({ sampleId: s.id,
    results: { sealStrength: 'abc', visual: '合格', barrier: '合格', label: '合格' } }, insp), '数值');
  assert.strictEqual(env.A.getSample(s.id).history.length, 0);
});

/* ============================================================
 * D. 审计篡改
 * ============================================================ */
console.log('\nD. 审计链防篡改');

test('D1', '篡改一条审计的操作者/变更内容 → 内容哈希断链，定位到具体条目', () => {
  const env = createEnv(); env.A.resetState(); env.A.seedDemoData();
  const audit = env.A.getState().audit;
  const target = 4;
  // 哈希负载覆盖 actorId（actorName 是展示冗余字段，改它不应影响链——这是刻意的）
  const original = audit[target].actorId;
  audit[target].actorId = 'U99';
  const v1 = env.A.verifyAudit();
  assert.strictEqual(v1.ok, false);
  assert.strictEqual(v1.brokenAt, target + 1);
  assert.ok(v1.error.includes('内容哈希不匹配'));
  audit[target].actorId = original;
  assert.strictEqual(env.A.verifyAudit().ok, true);

  // 篡改变更内容同样断链
  const before = audit[target].changes[0].after;
  audit[target].changes[0].after = 'FORGED';
  const v2 = env.A.verifyAudit();
  assert.strictEqual(v2.ok, false);
  assert.strictEqual(v2.brokenAt, target + 1);
  audit[target].changes[0].after = before;
  assert.strictEqual(env.A.verifyAudit().ok, true);
});

test('D2', '删除一条审计 → 前序哈希不匹配断链', () => {
  const env = createEnv(); env.A.resetState(); env.A.seedDemoData();
  const audit = env.A.getState().audit;
  const removed = audit.splice(3, 1)[0];
  const v = env.A.verifyAudit();
  assert.strictEqual(v.ok, false);
  assert.ok(v.error.includes('前序哈希'));
  audit.splice(3, 0, removed);
  assert.strictEqual(env.A.verifyAudit().ok, true);
});

test('D3', '篡改请求标识 → 断链', () => {
  const env = createEnv(); env.A.resetState(); env.A.seedDemoData();
  const audit = env.A.getState().audit;
  const orig = audit[2].requestId;
  audit[2].requestId = 'REQ-FORGED';
  assert.strictEqual(env.A.verifyAudit().ok, false);
  audit[2].requestId = orig;
  assert.strictEqual(env.A.verifyAudit().ok, true);
});

/* ============================================================
 * E. 存储损坏
 * ============================================================ */
console.log('\nE. 存储损坏的显式报错');

test('E1', 'JSON 语法损坏 → 启动即报告 STATE_CORRUPT，写操作被拒绝，损坏原文不被覆盖', () => {
  const corrupt = '{ "batches": [ {"id":"BAT-0001", BROKEN';
  // 独立 store 实例加载损坏数据（不能用 createEnv 的正常实例）
  let writeAttempted = false;
  const win = { listeners: [], addEventListener(t, fn) { if (t === 'storage') this.listeners.push(fn); } };
  win.localStorage = {
    getItem: () => corrupt,
    setItem: () => { writeAttempted = true; throw new Error('损坏状态下禁止写入'); },
    removeItem: () => {}
  };
  const sb = { window: win, localStorage: win.localStorage, SRData: Data,
    console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sb);
  const S = sb.SRStore;

  const health = S.storageHealth();
  assert.strictEqual(health.ok, false);
  assert.strictEqual(health.code, 'STATE_CORRUPT');
  assert.ok(health.message.includes('JSON'));
  const err = S.getLoadError();
  // 跨 vm realm 不能用 instanceof Error（原型不同），按 name/code 判定
  assert.ok(err && err.name === 'StateCorruptError' && err.code === 'STATE_CORRUPT');
  // 写操作必须被拒绝（hydrate 抛错），且没有调用 setItem 覆盖损坏数据
  const e = expectThrow(() => S.createBatch({ lineId: 'L01', product: 'X', quantity: 1, sampleCount: 1 }, op), 'STATE_CORRUPT');
  assert.strictEqual(e.code, 'STATE_CORRUPT');
  assert.strictEqual(writeAttempted, false, '损坏状态下不允许任何持久化写入');
});

test('E2', '结构损坏（缺 samples/audit 等数组）→ STATE_CORRUPT', () => {
  const env = createEnv();
  const broken = { revision: 3, lines: [], batches: [], decisions: [] }; // 缺 samples/audit/seq
  env.setRawObject(broken);
  const win = { listeners: [], addEventListener(t, fn) { if (t === 'storage') this.listeners.push(fn); },
    localStorage: { getItem: () => JSON.stringify(broken), setItem: () => {}, removeItem: () => {} } };
  const sb = { window: win, localStorage: win.localStorage, SRData: Data,
    console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sb);
  assert.strictEqual(sb.SRStore.storageHealth().code, 'STATE_CORRUPT');
  expectThrow(() => sb.SRStore.hydrate(), 'STATE_CORRUPT');
});

test('E3a', 'revision 为字符串（类型损坏）→ STATE_CORRUPT', () => {
  const env = createEnv();
  env.setRawObject({ revision: 'oops', lines: [], batches: [], samples: [], decisions: [], audit: [], seq: { batch: 0, sample: 0, decision: 0 } });
  const win = { listeners: [], addEventListener(t, fn) { if (t === 'storage') this.listeners.push(fn); },
    localStorage: { getItem: () => env.raw(), setItem: () => {}, removeItem: () => {} } };
  const sb = { window: win, localStorage: win.localStorage, SRData: Data,
    console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sb);
  assert.strictEqual(sb.SRStore.storageHealth().code, 'STATE_CORRUPT');
});

test('E3b', '旧版数据缺 revision → 兼容迁移为 0，正常加载不报错', () => {
  const env = createEnv();
  env.setRawObject({ lines: [], batches: [], samples: [], decisions: [], audit: [], seq: { batch: 0, sample: 0, decision: 0 } });
  const win = { listeners: [], addEventListener(t, fn) { if (t === 'storage') this.listeners.push(fn); },
    localStorage: { getItem: () => env.raw(), setItem: () => {}, removeItem: () => {} } };
  const sb = { window: win, localStorage: win.localStorage, SRData: Data,
    console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sb);
  assert.strictEqual(sb.SRStore.storageHealth().ok, true);
});

test('E4', '运行期间持久层被外部写坏 → 下一次写操作 hydrate 抛 STATE_CORRUPT，已有内存不污染持久层', () => {
  const env = createEnv();
  env.A.resetState();
  readyBatch(env.A);
  // 外部程序把存储写坏
  env.setRaw('NOT-JSON-AT-ALL###');
  // A 下一次任何写操作都必须显式失败
  const e = expectThrow(() => env.A.createBatch({ lineId: 'L01', product: 'Y', quantity: 1, sampleCount: 1 }, op), 'STATE_CORRUPT');
  assert.strictEqual(e.code, 'STATE_CORRUPT');
  // 存储仍然是损坏原文，未被空状态覆盖
  assert.strictEqual(env.raw(), 'NOT-JSON-AT-ALL###');
});

test('E5a', 'forceReset 先备份损坏原文到 corrupt-backup，再恢复为空库（QA 权限）', () => {
  const env = createEnv();
  const corrupt = '{broken';
  env.setRaw(corrupt);
  const win = { listeners: [], addEventListener(t, fn) { if (t === 'storage') this.listeners.push(fn); } };
  const writeLog = [];
  win.localStorage = {
    getItem: k => (k === STORE_KEY ? corrupt : null),
    setItem: (k, v) => { writeLog.push([k, String(v).slice(0, 40)]); },
    removeItem: () => {}
  };
  const sb = { window: win, localStorage: win.localStorage, SRData: Data,
    console, Date, Math, JSON, Number, String, Object, Array, Set, Map, isFinite, isNaN };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8'), sb);
  const S = sb.SRStore;
  assert.strictEqual(S.storageHealth().ok, false);

  // 非 QA 无权恢复
  expectThrow(() => S.forceReset(appr), '无权限');
  // QA 恢复：先写备份键（内容为损坏原文），再写合法空库
  const r = S.forceReset(qa);
  assert.strictEqual(r.corruptBackupCreated, true);
  const backupWrite = writeLog.find(w => w[0] === STORE_KEY + '.corrupt-backup');
  assert.ok(backupWrite, '必须先写入取证备份键');
  assert.strictEqual(backupWrite[1], '{broken');
  const mainWrite = writeLog.filter(w => w[0] === STORE_KEY);
  assert.ok(mainWrite.length >= 1);
  assert.ok(mainWrite[mainWrite.length - 1][1].startsWith('{"version":1,"revision":1'));
  assert.strictEqual(S.storageHealth().ok, true);
});

test('E5b', '存储健康时 reset 不产生备份；返回值明确标注', () => {
  const env = createEnv();
  env.A.resetState();
  readyBatch(env.A);
  const r = env.A.resetState(qa);
  assert.strictEqual(r.corruptBackupCreated, false);
  assert.strictEqual(r.backupKey, null);
  assert.strictEqual(env.getBackup(), null);
});

console.log(`\n${passed} 项并发/边界/失败分支测试通过`);
