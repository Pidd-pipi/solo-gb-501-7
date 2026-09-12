/*
 * 领域层测试：node tests/store.test.js
 * 覆盖：RBAC、批次登记、检验录入、不合格自动待复测、复测流转、
 *       返工补样、放行四条硬拦截、隔离/返工同步状态、审计哈希链防篡改
 */
const assert = require('assert');
const Store = require('../js/store.js');
const Data = require('../js/data.js');

const op = Data.USERS[0], insp = Data.USERS[1], appr = Data.USERS[2], qa = Data.USERS[3];
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
function expectThrow(fn, fragment) {
  try { fn(); } catch (e) {
    if (fragment && !e.message.includes(fragment)) throw new Error(`报错信息不含「${fragment}}」，实际：${e.message}`);
    return e;
  }
  throw new Error('预期抛错但未抛错');
}
const GOOD = { sealStrength: '2.2', visual: '合格', barrier: '合格', label: '合格' };
const BAD_BARRIER = { sealStrength: '1.0', visual: '合格', barrier: '不合格', label: '合格' };

console.log('RBAC 权限：');
test('操作员不能录入检验', () => {
  Store.resetState();
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  expectThrow(() => Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, op), '无权限');
});
test('检验员不能登记批次', () => {
  expectThrow(() => Store.createBatch({ lineId: 'L01', product: 'X', quantity: 1, sampleCount: 1 }, insp), '无权限');
});
test('审批员不能录入检验', () => {
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  expectThrow(() => Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, appr), '无权限');
});
test('操作员不能提交放行决定', () => {
  expectThrow(() => Store.submitDecision({ batchId: 'x', type: 'RELEASE', note: '依据依据依据' }, op), '无权限');
});
test('只有质量管理员能停用产线', () => {
  expectThrow(() => Store.setLineActive('L02', false, appr), '无权限');
  Store.setLineActive('L02', false, qa);
  assert.strictEqual(Store.getState().lines.find(l => l.id === 'L02').active, false);
  Store.setLineActive('L02', true, qa);
});

console.log('批次登记：');
test('登记批次自动生成指定数量待检样本与批次号', () => {
  Store.resetState();
  const { batch, samples, requestId } = Store.createBatch(
    { lineId: 'L01', product: '无菌注射器 10mL', quantity: 12000, sampleCount: 3 }, op);
  assert.match(batch.batchNo, /^B\d{8}-\d{3}$/);
  assert.strictEqual(batch.status, 'PENDING_INSPECTION');
  assert.strictEqual(samples.length, 3);
  assert.strictEqual(samples.every(s => s.status === 'PENDING'), true);
  assert.match(samples[0].code, /-S01$/);
  assert.match(requestId, /^REQ-/);
});
test('停用产线不能登记批次', () => {
  expectThrow(() => Store.createBatch({ lineId: 'L04', product: 'X', quantity: 1, sampleCount: 1 }, op), '已停用');
});
test('样本数非法被拒', () => {
  expectThrow(() => Store.createBatch({ lineId: 'L01', product: 'X', quantity: 1, sampleCount: 0 }, op), '1~20');
  expectThrow(() => Store.createBatch({ lineId: 'L01', product: 'X', quantity: 1, sampleCount: 21 }, op), '1~20');
});
test('数量/产品为空被拒', () => {
  expectThrow(() => Store.createBatch({ lineId: 'L01', product: '', quantity: 1, sampleCount: 1 }, op), '产品名称');
  expectThrow(() => Store.createBatch({ lineId: 'L01', product: 'X', quantity: -5, sampleCount: 1 }, op), '数量');
});

console.log('检验录入与自动状态：');
test('全部合格 → 批次待审批', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 2 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  const r2 = Store.saveInspection({ sampleId: samples[1].id, results: GOOD }, insp);
  assert.strictEqual(r2.samples === undefined || true, true);
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
});
test('首轮不合格 → 样本自动待复测，批次待复测', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 2 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  const r = Store.saveInspection({ sampleId: samples[1].id, results: BAD_BARRIER }, insp);
  assert.strictEqual(r.sample.status, 'RETEST');
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_RETEST');
});
test('密封强度超上下限自动判不合格', () => {
  Store.resetState();
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  const r = Store.saveInspection(
    { sampleId: samples[0].id, results: { sealStrength: '4.5', visual: '合格', barrier: '合格', label: '合格' } }, insp);
  assert.strictEqual(r.sample.status, 'RETEST');
});
test('缺检验项结果被拒', () => {
  Store.resetState();
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  expectThrow(() => Store.saveInspection(
    { sampleId: samples[0].id, results: { sealStrength: '2.0', visual: '合格', barrier: '合格' } }, insp), '标签信息');
});
test('合格样本不能重复录入', () => {
  Store.resetState();
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  expectThrow(() => Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp), '不能重复录入');
});

console.log('复测流转：');
test('待复测样本必须先发起复测才能录入第二轮', () => {
  Store.resetState();
  const { samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  expectThrow(() => Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp), '发起复测');
});
test('复测合格 → 解除待复测，批次回待审批', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 2 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  Store.saveInspection({ sampleId: samples[1].id, results: BAD_BARRIER }, insp);
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_RETEST');
  Store.requestRetest(samples[1].id, insp);
  const r = Store.saveInspection({ sampleId: samples[1].id, results: GOOD }, insp);
  assert.strictEqual(r.sample.status, 'PASS');
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
  // 两轮历史都保留
  const rounds = new Set(r.sample.history.map(h => h.round));
  assert.deepStrictEqual([...rounds].sort(), [1, 2]);
});
test('复测仍不合格 → 最终 FAIL，批次进待审批（不是无限待复测）', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  Store.requestRetest(samples[0].id, insp);
  const r = Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  assert.strictEqual(r.sample.status, 'FAIL');
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
});

console.log('放行硬条件：')
test('待检批次不能提交任何审批决定', () => {
  Store.resetState();
  const { batch } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  expectThrow(() => Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '检验未完成不能批' }, appr), '检验流程未完成');
});
test('无检验记录 → 放行拦截并逐条说明原因', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  // 直接把批次推到待审批（绕过 UI 检验），验证 evaluateRelease 的记录检查
  const ev = Store.evaluateRelease(batch.id);
  assert.strictEqual(ev.canRelease, false);
  assert.ok(ev.checks.find(c => c.key === 'HAS_RECORDS' && !c.pass));
  assert.ok(ev.reasons.some(r => r.includes('尚未录入检验记录')));
});
test('待检 / 待复测 / 不合格 分别给出拦截原因', () => {
  Store.resetState();
  // 批次：1 待检 + 1 待复测
  const b1 = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 2 }, op);
  Store.saveInspection({ sampleId: b1.samples[0].id, results: BAD_BARRIER }, insp);
  let ev = Store.evaluateRelease(b1.batch.id);
  assert.strictEqual(ev.canRelease, false);
  assert.strictEqual(ev.checks.find(c => c.key === 'NO_PENDING').pass, false);
  assert.strictEqual(ev.checks.find(c => c.key === 'NO_RETEST').pass, false);

  // 最终不合格
  Store.requestRetest(b1.samples[0].id, insp);
  Store.saveInspection({ sampleId: b1.samples[0].id, results: BAD_BARRIER }, insp);
  Store.saveInspection({ sampleId: b1.samples[1].id, results: GOOD }, insp);
  ev = Store.evaluateRelease(b1.batch.id);
  assert.strictEqual(ev.checks.find(c => c.key === 'NO_FAIL').pass, false);
  assert.ok(ev.reasons.some(r => r.includes('最终判定不合格')));
});
test('submitDecision 放行被拦截（blocked），隔离/返工不受限', () => {
  Store.resetState();
  const { batch } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: Store.getSamples(batch.id)[0].id, results: BAD_BARRIER }, insp);
  Store.requestRetest(Store.getSamples(batch.id)[0].id, insp);
  Store.saveInspection({ sampleId: Store.getSamples(batch.id)[0].id, results: BAD_BARRIER }, insp);
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
  const err = expectThrow(() => Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '尝试放行不合格批次' }, appr), '放行被拦截');
  assert.strictEqual(err.blocked, true);
  assert.ok(err.evaluation.reasons.length >= 1);
  // 批次状态不因为被拦截而改变
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
  // 隔离可以提交并同步状态
  const r = Store.submitDecision({ batchId: batch.id, type: 'QUARANTINE', note: '不合格批次隔离调查。' }, appr);
  assert.strictEqual(r.batch.status, 'QUARANTINED');
});
test('全部合格 → 放行成功，批次已放行且记录锁定', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 2 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  Store.saveInspection({ sampleId: samples[1].id, results: GOOD }, insp);
  const r = Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '全项合格，同意放行。' }, appr);
  assert.strictEqual(r.batch.status, 'RELEASED');
  // 已放行批次检验锁定
  expectThrow(() => Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp), '已锁定');
  expectThrow(() => Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '重复放行重复放行' }, appr), '提交冲突');
});
test('放行依据过短被拒', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  expectThrow(() => Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: 'ok' }, appr), '依据');
});

console.log('隔离 / 返工 / 补样：');
test('返工决定 → 样本作废批次返工中；补样后自动回待检；再合格可放行', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L02', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  Store.requestRetest(samples[0].id, insp);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  const d = Store.submitDecision({ batchId: batch.id, type: 'REWORK', note: '屏障缺陷返工处理。' }, appr);
  assert.strictEqual(d.batch.status, 'REWORK');
  assert.strictEqual(Store.getSamples(batch.id).every(s => s.status === 'VOID'), true);
  // 只有返工中能补样
  expectThrow(() => Store.addSamples({ batchId: 'L-NOPE', count: 1 }, insp), '不存在');
  const a = Store.addSamples({ batchId: batch.id, count: 2 }, insp);
  assert.strictEqual(a.samples.length, 2);
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_INSPECTION');
  a.samples.forEach(s => Store.saveInspection({ sampleId: s.id, results: GOOD }, insp));
  assert.strictEqual(Store.getBatch(batch.id).status, 'PENDING_REVIEW');
  const r = Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '返工后复检合格，放行。' }, appr);
  assert.strictEqual(r.batch.status, 'RELEASED');
});
test('拒收 → 终态', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  Store.requestRetest(samples[0].id, insp);
  Store.saveInspection({ sampleId: samples[0].id, results: BAD_BARRIER }, insp);
  const r = Store.submitDecision({ batchId: batch.id, type: 'REJECT', note: '无菌屏障不可恢复，报废。' }, appr);
  assert.strictEqual(r.batch.status, 'REJECTED');
});
test('隔离批次调查后可改判放行（检验合格的情形）', () => {
  Store.resetState();
  const { batch, samples } = Store.createBatch({ lineId: 'L01', product: 'X', quantity: 100, sampleCount: 1 }, op);
  Store.saveInspection({ sampleId: samples[0].id, results: GOOD }, insp);
  Store.submitDecision({ batchId: batch.id, type: 'QUARANTINE', note: '客户投诉关联，先隔离。' }, appr);
  assert.strictEqual(Store.getBatch(batch.id).status, 'QUARANTINED');
  const r = Store.submitDecision({ batchId: batch.id, type: 'RELEASE', note: '调查无问题，解除隔离放行。' }, appr);
  assert.strictEqual(r.batch.status, 'RELEASED');
});

console.log('审计日志（操作者 / 请求标识 / 变更）：');
test('每次操作都留审计，含操作者、请求标识、变更内容', () => {
  Store.resetState();
  const { batch, samples, requestId } = Store.createBatch({ lineId: 'L01', product: '审计产品', quantity: 100, sampleCount: 1 }, op);
  const audit = Store.getState().audit;
  const e = audit.find(a => a.requestId === requestId);
  assert.ok(e);
  assert.strictEqual(e.actorId, op.id);
  assert.strictEqual(e.actorName, op.name);
  assert.strictEqual(e.actorRole, 'OPERATOR');
  assert.ok(e.changes.some(c => c.label === '产品' && c.after === '审计产品'));
  assert.ok(e.hash.length === 8);
  assert.strictEqual(e.prevHash, 'GENESIS');
});
test('审计哈希链校验通过', () => {
  Store.resetState();
  Store.seedDemoData();
  const v = Store.verifyAudit();
  assert.strictEqual(v.ok, true, v.error || '');
  assert.ok(v.total >= 20);
});
test('篡改任意一条审计 → 断链可检出', () => {
  Store.resetState();
  Store.seedDemoData();
  const audit = Store.getState().audit;
  const original = audit[3].changes[0].after;
  audit[3].changes[0].after = 'HACKED';
  const v = Store.verifyAudit();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.brokenAt, 4);
  audit[3].changes[0].after = original;
  assert.strictEqual(Store.verifyAudit().ok, true);
});
test('删除一条审计 → 前序哈希不匹配可检出', () => {
  const audit = Store.getState().audit;
  const removed = audit.splice(5, 1)[0];
  const v = Store.verifyAudit();
  assert.strictEqual(v.ok, false);
  assert.ok(v.error.includes('前序哈希'));
  audit.splice(5, 0, removed);
  assert.strictEqual(Store.verifyAudit().ok, true);
});
test('请求标识全局唯一', () => {
  const ids = Store.getState().audit.map(a => a.requestId);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log('演示数据：');
test('seed 覆盖全部关键状态且链合法', () => {
  Store.resetState();
  Store.seedDemoData();
  const statuses = Store.getState().batches.map(b => b.status);
  for (const s of ['RELEASED', 'PENDING_RETEST', 'PENDING_REVIEW', 'QUARANTINED', 'PENDING_INSPECTION', 'REWORK']) {
    assert.ok(statuses.includes(s), `缺少状态 ${s}`);
  }
  assert.strictEqual(Store.verifyAudit().ok, true);
});

console.log(`\n${passed} 项测试通过`);
