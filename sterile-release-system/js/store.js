/*
 * store.js —— 无菌包装生产放行系统核心领域层
 * 职责：批次/样本状态机、角色权限、审计日志（哈希链防篡改）、放行规则判定
 * UMD：浏览器挂 window.SRStore；Node 可 require 跑测试
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./data.js'));
  } else {
    root.SRStore = factory(root.SRData);
  }
})(typeof self !== 'undefined' ? self : this, function (Data) {
  'use strict';

  /* ============================ 状态标签（队列/审批共用一套） ============================ */
  const BATCH_STATUS = {
    PENDING_INSPECTION: { key: 'PENDING_INSPECTION', name: '待检',   tone: 'info',
      desc: '批次已登记，样本等待检验' },
    PENDING_RETEST:     { key: 'PENDING_RETEST',     name: '待复测', tone: 'warning',
      desc: '存在不合格样本，等待复测安排' },
    PENDING_REVIEW:     { key: 'PENDING_REVIEW',     name: '待审批', tone: 'primary',
      desc: '检验完成，等待放行审批' },
    RELEASED:           { key: 'RELEASED',           name: '已放行', tone: 'success',
      desc: '审批通过，允许出厂' },
    QUARANTINED:        { key: 'QUARANTINED',        name: '已隔离', tone: 'warning',
      desc: '质量风险挂起，隔离区暂存' },
    REWORK:             { key: 'REWORK',             name: '返工中', tone: 'neutral',
      desc: '退回产线返工，返工后重新取样' },
    REJECTED:           { key: 'REJECTED',           name: '拒收',   tone: 'danger',
      desc: '判定拒收/报废，流程终止' }
  };

  const SAMPLE_STATUS = {
    PENDING:  { key: 'PENDING',  name: '待检',   tone: 'info' },
    PASS:     { key: 'PASS',     name: '合格',   tone: 'success' },
    FAIL:     { key: 'FAIL',     name: '不合格', tone: 'danger' },
    RETEST:   { key: 'RETEST',   name: '待复测', tone: 'warning' },
    VOID:     { key: 'VOID',     name: '已作废', tone: 'neutral' }
  };

  const TERMINAL_STATUS = ['RELEASED', 'REJECTED'];
  // 隔离/返工可回到检验-审批主线
  const BATCH_STATUSES = Object.keys(BATCH_STATUS);

  /* ============================ 权限矩阵 ============================ */
  const PERMISSIONS = {
    'batch.create':        ['OPERATOR'],
    'inspection.save':     ['INSPECTOR'],
    'inspection.retest':   ['INSPECTOR'],
    'sample.add':          ['INSPECTOR'],
    'decision.submit':     ['APPROVER'],
    'line.manage':         ['QA_MANAGER'],
    'data.reset':          ['QA_MANAGER'],
    'audit.view':          ['OPERATOR', 'INSPECTOR', 'APPROVER', 'QA_MANAGER']
  };

  const AUDIT_ACTIONS = {
    BATCH_REGISTERED: '登记批次',
    INSPECTION_SAVED: '录入检验',
    RETEST_REQUESTED: '发起复测',
    SAMPLES_ADDED:    '返工补样',
    DECISION_SUBMITTED: '提交放行决定',
    LINE_MANAGED:     '维护产线'
  };

  /* ============================ 工具 ============================ */
  const STORAGE_KEY = 'sr_system_state_v1';

  let _seq = 0;
  function pad(n, w) { return String(n).padStart(w, '0'); }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`; }
  function hm(d) { return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`; }
  function fmtTime(ts) {
    const d = new Date(ts);
    return `${ymd(d)} ${hm(d)}`;
  }

  function newRequestId() {
    _seq += 1;
    const d = new Date();
    return `REQ-${ymd(d).replace(/-/g, '')}-${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}-${pad(_seq, 4)}`;
  }

  // FNV-1a 32bit —— 非密码学哈希，用于审计链连续性校验（防逐条篡改/删除/插入）
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function findItem(list, id) { return list.find(x => x.id === id); }

  /* ============================ 状态存储 ============================
   * 多页签并发策略：
   *  - state.revision 为全局单调版本，任何写操作 +1 并落盘；
   *  - 每次写操作前 hydrate() 从持久层合并最新状态，过期页签不会整份覆盖；
   *  - 批次另有 rev，提交放行决定时做乐观锁校验（expectedRev）。
   */
  function defaultState() {
    return {
      version: 1,
      revision: 0,
      lines: Data.LINES.map(l => ({ ...l })),
      batches: [],
      samples: [],
      decisions: [],
      audit: [],
      seq: { batch: 0, sample: 0, decision: 0 },
      batchDate: null,
      batchDateSeq: 0
    };
  }

  let memoryStore = null;
  const hasLocalStorage = typeof localStorage !== 'undefined';

  /**
   * 存储损坏错误：持久层存在内容但无法解析或结构不合法。
   * 出现该错误时所有写操作被阻止，必须由质量管理员显式 forceReset（先备份原始数据），
   * 绝不允许静默按空状态重建后覆盖损坏数据。
   */
  function StateCorruptError(message, cause) {
    const err = new Error(message);
    err.name = 'StateCorruptError';
    err.code = 'STATE_CORRUPT';
    if (cause) err.cause = cause;
    return err;
  }

  const CORRUPT_BACKUP_KEY = STORAGE_KEY + '.corrupt-backup';

  /** 严格解析 + 结构校验；空（首次使用）返回 null；损坏抛 StateCorruptError */
  function parseStored(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    let s;
    try {
      s = JSON.parse(raw);
    } catch (e) {
      throw StateCorruptError('持久化数据不是合法的 JSON（可能被截断或手工改写），为避免数据丢失，系统已阻止读写，请联系质量管理员处理。', e.message);
    }
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      throw StateCorruptError('持久化数据结构非法：顶层不是对象，拒绝加载。');
    }
    const requiredArrays = ['lines', 'batches', 'samples', 'decisions', 'audit'];
    for (const k of requiredArrays) {
      if (!Array.isArray(s[k])) {
        throw StateCorruptError(`持久化数据结构非法：缺少或损坏了「${k}」数组，拒绝加载（不会清空原数据）。`);
      }
    }
    if (s.seq === undefined || s.seq === null) {
      s.seq = { batch: 0, sample: 0, decision: 0 };
    } else if (typeof s !== 'object' || Array.isArray(s.seq) ||
               typeof s.seq.batch !== 'number' || typeof s.seq.sample !== 'number' || typeof s.seq.decision !== 'number') {
      throw StateCorruptError('持久化数据结构非法：序列号字段 seq 损坏，拒绝加载。');
    }
    // revision 缺失视为旧版数据，兼容迁移为 0；类型错误才判损坏
    if (s.revision === undefined || s.revision === null) s.revision = 0;
    if (typeof s.revision !== 'number' || !Number.isFinite(s.revision)) {
      throw StateCorruptError('持久化数据结构非法：版本号 revision 不是数值，拒绝加载。');
    }
    return s;
  }

  /** 读取持久层原始字符串（不解析），用于取证备份 */
  function readRawString() {
    if (!hasLocalStorage) return null;
    return localStorage.getItem(STORAGE_KEY);
  }

  /** 读取并校验持久层：空→null；损坏→StateCorruptError */
  function loadRaw() {
    if (hasLocalStorage) return parseStored(localStorage.getItem(STORAGE_KEY));
    return memoryStore;
  }

  // 启动时若存储已损坏，错误记录在此（getLoadError 暴露给 UI）；必须在 load() 调用前声明
  let loadError = null;

  function load() {
    try {
      const s = loadRaw();
      if (s) return s;
    } catch (e) {
      // 启动即损坏：记下错误（UI 告警、写入拦截），内存用空状态支撑只读浏览
      loadError = e;
    }
    memoryStore = defaultState();
    return memoryStore;
  }

  function persist(nextState) {
    if (hasLocalStorage) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } else {
      memoryStore = nextState;
    }
  }

  let state = load();
  let knownRevision = state.revision;
  // 与存储内序列号对齐，避免 requestId 序号回退
  _seq = (state.audit && state.audit.length) || 0;

  /**
   * 写操作前调用：放弃本页签的过期内存副本，改用持久层最新状态。
   * 任何页签的写入都会先落盘，因此后续写入者看到的永远是最新数据。
   * 持久层损坏时直接抛 StateCorruptError，阻止后续写入覆盖。
   */
  function hydrate() {
    const latest = loadRaw(); // 损坏会在此抛出 StateCorruptError
    if (latest) {
      state = latest;
      knownRevision = latest.revision;
      _seq = state.audit.length;
    }
    return state;
  }

  /** 落盘并推进全局版本 */
  function save() {
    state.revision = (state.revision || 0) + 1;
    knownRevision = state.revision;
    persist(state);
    return state.revision;
  }

  /** 浏览器跨页签 storage 事件：其他页签写入后刷新内存并通知 UI */
  const externalListeners = [];
  function onExternalChange(fn) {
    externalListeners.push(fn);
    return () => {
      const i = externalListeners.indexOf(fn);
      if (i >= 0) externalListeners.splice(i, 1);
    };
  }
  if (hasLocalStorage && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      const before = knownRevision;
      // 其他页签清空了存储（合法的重置）→ 回到空状态
      if (!e.newValue) {
        state = defaultState();
        knownRevision = 0;
        loadError = null;
        _seq = 0;
        externalListeners.forEach(fn => {
          try { fn({ revision: 0, previousRevision: before, reset: true }); } catch (_) {}
        });
        return;
      }
      // 严格校验外部写入：损坏不静默接受，置错误标志并通知 UI
      try {
        const incoming = parseStored(e.newValue);
        state = incoming;
        knownRevision = incoming.revision;
        loadError = null;
        _seq = incoming.audit.length;
        externalListeners.forEach(fn => {
          try { fn({ revision: knownRevision, previousRevision: before }); } catch (_) {}
        });
      } catch (err) {
        loadError = err;
        externalListeners.forEach(fn => {
          try { fn({ revision: knownRevision, previousRevision: before, corrupt: true, error: err }); } catch (_) {}
        });
      }
    });
  }


  /* ============================ 权限与审计 ============================ */
  function requirePerm(perm, user) {
    if (!user) throw new Error('未指定操作者，无法执行操作');
    const allow = PERMISSIONS[perm] || [];
    if (!allow.includes(user.role)) {
      throw new Error(`无权限：${Data.ROLES[user.role].name}不能执行该操作（需要 ${allow.map(r => Data.ROLES[r].name).join('/')}）`);
    }
  }

  function appendAudit(action, user, changes, target, requestId) {
    const prevHash = state.audit.length ? state.audit[state.audit.length - 1].hash : 'GENESIS';
    const reqId = requestId || newRequestId();
    const entry = {
      id: `AUD-${pad(state.audit.length + 1, 5)}`,
      ts: Date.now(),
      requestId: reqId,
      action,
      targetType: target ? target.type : '',
      targetId: target ? target.id : '',
      actorId: user.id,
      actorName: user.name,
      actorRole: user.role,
      changes: changes || [], // [{ field, label, before, after }]
      prevHash,
      hash: ''
    };
    const payload = [entry.id, entry.ts, entry.requestId, entry.action,
      entry.targetType, entry.targetId, entry.actorId, JSON.stringify(entry.changes), prevHash].join('|');
    entry.hash = hash32(payload);
    state.audit.push(entry);
    return entry;
  }

  /**
   * 校验审计哈希链：任何一条记录被增/删/改都会断链
   * @returns {{ok:boolean, error?:string, brokenAt?:number, total:number}}
   */
  function verifyAudit() {
    let prev = 'GENESIS';
    for (let i = 0; i < state.audit.length; i++) {
      const e = state.audit[i];
      if (e.prevHash !== prev) {
        return { ok: false, total: state.audit.length, brokenAt: i + 1,
          error: `第 ${i + 1} 条记录的前序哈希不匹配（记录可能被删除/插入）` };
      }
      const payload = [e.id, e.ts, e.requestId, e.action,
        e.targetType, e.targetId, e.actorId, JSON.stringify(e.changes), e.prevHash].join('|');
      if (hash32(payload) !== e.hash) {
        return { ok: false, total: state.audit.length, brokenAt: i + 1,
          error: `第 ${i + 1} 条记录内容哈希不匹配（操作者/请求标识/变更字段被改动）` };
      }
      prev = e.hash;
    }
    return { ok: true, total: state.audit.length };
  }

  /* ============================ 批次状态机 ============================ */
  function setBatchStatus(batch, next, reason) {
    const prev = batch.status;
    if (prev === next) return;
    batch.status = next;
    batch.statusLogs.push({
      from: prev, to: next, reason: reason || '', ts: Date.now()
    });
  }

  function samplesOf(batchId) {
    return state.samples.filter(s => s.batchId === batchId);
  }

  // 不合格样本自动进入待复测；批次整体状态由样本/决定状态推导
  function recomputeBatchStatus(batch, context) {
    if (TERMINAL_STATUS.includes(batch.status)) return batch.status;

    const samples = samplesOf(batch.id);
    const activeSamples = samples.filter(s => s.status !== 'VOID');
    const hasRetest = activeSamples.some(s => s.status === 'RETEST');
    const hasPending = activeSamples.some(s => s.status === 'PENDING');
    const hasFail = activeSamples.some(s => s.status === 'FAIL');

    let next;
    if (hasRetest) {
      next = 'PENDING_RETEST';                       // 不合格样本待复测
    } else if (hasPending) {
      next = 'PENDING_INSPECTION';                  // 返工补样后自动回到待检
    } else if (hasFail) {
      // 最终判定不合格（复测仍不合格），提交审批给出处置决定
      next = 'PENDING_REVIEW';
    } else if (activeSamples.length > 0) {
      next = 'PENDING_REVIEW';                      // 全部合格，提交审批
    } else {
      next = 'PENDING_INSPECTION';
    }
    setBatchStatus(batch, next, context || '系统按样本检验结果自动更新');
    return next;
  }

  /* ============================ 用例：登记批次（操作员） ============================ */
  function nextBatchNo(ts) {
    const day = ymd(new Date(ts));
    if (state.batchDate !== day) { state.batchDate = day; state.batchDateSeq = 0; }
    state.batchDateSeq += 1;
    return `B${day.replace(/-/g, '')}-${pad(state.batchDateSeq, 3)}`;
  }

  function createBatch(input, user) {
    hydrate();
    requirePerm('batch.create', user);

    const line = findItem(state.lines, input.lineId);
    if (!line) throw new Error('请选择生产产线');
    if (!line.active) throw new Error(`产线 ${line.code} 已停用，不能登记新批次`);
    const product = (input.product || '').trim();
    if (!product) throw new Error('请填写产品名称');
    const qty = Number(input.quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('生产数量必须为大于 0 的整数');
    const sampleCount = Number(input.sampleCount);
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 20) {
      throw new Error('检验样本数应为 1~20 的整数');
    }

    const ts = Date.now();
    const reqId = newRequestId();
    state.seq.batch += 1;
    const batchId = `BAT-${pad(state.seq.batch, 4)}`;
    const batchNo = nextBatchNo(ts);

    const batch = {
      id: batchId,
      batchNo,
      lineId: line.id,
      lineCode: line.code,
      product,
      quantity: qty,
      standard: (input.standard || 'ISO 11607').trim() || 'ISO 11607',
      status: 'PENDING_INSPECTION',
      rev: 1, // 批次乐观锁版本：每次影响放行判定的数据变更 +1
      createdBy: user.id,
      createdByName: user.name,
      createdAt: ts,
      updatedAt: ts,
      statusLogs: [{ from: '', to: 'PENDING_INSPECTION', reason: '批次登记', ts }]
    };
    state.batches.push(batch);

    // 登记时按样本数自动生成待检样本
    const created = [];
    for (let i = 1; i <= sampleCount; i++) {
      state.seq.sample += 1;
      const code = `${batchNo}-S${pad(i, 2)}`;
      const sample = {
        id: `SMP-${pad(state.seq.sample, 5)}`,
        code,
        batchId: batch.id,
        seq: i,
        status: 'PENDING',
        retestOfId: null,
        createdBy: user.id,
        createdAt: ts,
        history: [], // 每次检验记录：{ itemKey, itemName, value, qualified, result, inspectorId, inspectorName, ts, round }
        results: {}
      };
      state.samples.push(sample);
      created.push(sample);
    }

    appendAudit('BATCH_REGISTERED', user, [
      { field: 'batchNo', label: '批次号', before: '', after: batchNo },
      { field: 'lineCode', label: '产线', before: '', after: line.code },
      { field: 'product', label: '产品', before: '', after: product },
      { field: 'quantity', label: '数量', before: '', after: String(qty) },
      { field: 'sampleCount', label: '样本数', before: '0', after: String(sampleCount) }
    ], { type: 'batch', id: batchId }, reqId);

    save();
    return { batch, samples: created, requestId: reqId };
  }

  /* ============================ 用例：录入检验结果（检验员） ============================ */
  function saveInspection(input, user) {
    hydrate();
    requirePerm('inspection.save', user);

    const sample = findItem(state.samples, input.sampleId);
    if (!sample) throw new Error('检验样本不存在');
    const batch = findItem(state.batches, sample.batchId);
    if (!batch) throw new Error('样本所属批次不存在');
    if (TERMINAL_STATUS.includes(batch.status)) {
      throw new Error(`批次${BATCH_STATUS[batch.status].name}，检验记录已锁定`);
    }
    if (sample.status === 'VOID') throw new Error('该样本已作废，不能录入结果');
    if (sample.status === 'PASS') throw new Error('该样本已判定合格，不能重复录入');
    if (sample.status === 'FAIL') throw new Error('该样本已最终判定不合格，结果已锁定');
    if (sample.status === 'RETEST' && !sample.awaitingRetestRound) {
      throw new Error('该样本处于待复测状态，请先发起复测再录入复测结果');
    }

    // 校验并归一化各检验项
    const results = {};
    // 当前录入轮次：首轮=1；发起复测后 awaitingRetestRound 指向下一轮
    const currentRound = sample.awaitingRetestRound
      || (sample.history.length ? Math.max(...sample.history.map(h => h.round || 1)) : 1);
    const isRetestRound = currentRound > 1;

    for (const item of Data.INSPECTION_ITEMS) {
      const raw = input.results && input.results[item.key];
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        throw new Error(`请填写检验项「${item.name}」的结果`);
      }
      if (item.type === 'qual') {
        const v = String(raw).trim();
        if (v !== '合格' && v !== '不合格') throw new Error(`「${item.name}」结果只能是合格/不合格`);
        results[item.key] = { value: v, qualified: v === '合格' };
      } else {
        const num = Number(raw);
        if (!Number.isFinite(num)) throw new Error(`「${item.name}」必须填写数值`);
        const qualified = num >= item.min && num <= item.max;
        results[item.key] = { value: num, qualified };
      }
    }

    const overallPass = Object.values(results).every(r => r.qualified);
    const ts = Date.now();
    const reqId = newRequestId();

    // 逐项写入历史（审计可追溯每轮结果）
    for (const item of Data.INSPECTION_ITEMS) {
      const r = results[item.key];
      sample.history.push({
        itemKey: item.key,
        itemName: item.name,
        value: String(r.value),
        qualified: r.qualified,
        result: r.qualified ? '合格' : '不合格',
        inspectorId: user.id,
        inspectorName: user.name,
        round: currentRound,
        ts
      });
    }
    sample.results = results;
    sample.lastInspectorId = user.id;
    sample.lastInspectorName = user.name;
    sample.updatedAt = ts;
    if (sample.awaitingRetestRound) sample.awaitingRetestRound = null;

    const changes = [
      { field: 'sample', label: '样本编号', before: '', after: sample.code },
      { field: 'round', label: '检验轮次', before: '', after: isRetestRound ? `第 ${currentRound} 轮（复测）` : '首轮' },
      { field: 'overall', label: '综合判定', before: '',
        after: overallPass ? '合格'
          : (isRetestRound ? '复测仍不合格（最终不合格）' : '不合格（自动转待复测）') }
    ];
    for (const item of Data.INSPECTION_ITEMS) {
      const r = results[item.key];
      changes.push({
        field: `item.${item.key}`,
        label: item.name + (item.unit ? `(${item.unit})` : ''),
        before: '',
        after: `${r.value} / ${r.qualified ? '合格' : '不合格'}`
      });
    }

    if (overallPass) {
      // 不合格样本复测合格 → 解除待复测
      sample.status = 'PASS';
    } else if (isRetestRound) {
      // 复测仍不合格 → 最终不合格，交审批员处置（隔离/返工/拒收）
      sample.status = 'FAIL';
      sample.finalFailReason = `第 ${currentRound} 轮复测仍不合格`;
    } else {
      // 首轮不合格 → 自动进入待复测
      sample.status = 'RETEST';
    }
    batch.updatedAt = ts;
    batch.rev = (batch.rev || 0) + 1; // 检验数据变化 → 打开中的决定弹窗所依据版本过期
    recomputeBatchStatus(batch,
      overallPass
        ? (isRetestRound ? '样本复测合格' : '样本检验合格')
        : (isRetestRound ? '样本复测仍不合格，提交审批处置' : '样本检验不合格，自动转入待复测'));

    appendAudit('INSPECTION_SAVED', user, changes,
      { type: 'sample', id: sample.id }, reqId);

    save();
    return { sample, batch, requestId: reqId };
  }

  /* ============================ 用例：发起复测（检验员） ============================
   * 不合格样本(RETEST)可复测：复测仍不合格则转为最终 FAIL；合格则解除。
   * 复测在原样本上开新一轮记录，审计链完整保留。
   */
  function requestRetest(sampleId, user) {
    hydrate();
    requirePerm('inspection.retest', user);
    const sample = findItem(state.samples, sampleId);
    if (!sample) throw new Error('检验样本不存在');
    const batch = findItem(state.batches, sample.batchId);
    if (TERMINAL_STATUS.includes(batch.status)) throw new Error('批次已终止，不能复测');
    if (sample.status !== 'RETEST') throw new Error('只有待复测样本可以发起复测');
    if (sample.awaitingRetestRound) throw new Error('已发起复测，请先录入复测结果');

    const ts = Date.now();
    const reqId = newRequestId();
    const nextRound = (sample.maxRound || 1) + 1;
    sample.maxRound = nextRound;
    // 保持「待复测」状态不变，仅开放新一轮结果录入；首轮结果保留在 history
    sample.awaitingRetestRound = nextRound;
    batch.updatedAt = ts;
    batch.rev = (batch.rev || 0) + 1; // 复测安排变化 → 放行依据版本过期

    appendAudit('RETEST_REQUESTED', user, [
      { field: 'sample', label: '样本编号', before: '', after: sample.code },
      { field: 'round', label: '复测轮次', before: String(nextRound - 1), after: String(nextRound) }
    ], { type: 'sample', id: sample.id }, reqId);

    save();
    return { sample, batch, requestId: reqId };
  }

  /* ============================ 用例：返工后补样（检验员） ============================ */
  function addSamples(input, user) {
    hydrate();
    requirePerm('sample.add', user);
    const batch = findItem(state.batches, input.batchId);
    if (!batch) throw new Error('批次不存在');
    if (batch.status !== 'REWORK') throw new Error('只有返工中的批次可以补取样');
    const count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('补样数量应为 1~10 的整数');

    const ts = Date.now();
    const reqId = newRequestId();
    const existing = samplesOf(batch.id);
    let seq = existing.length;
    const created = [];
    for (let i = 0; i < count; i++) {
      seq += 1;
      state.seq.sample += 1;
      const code = `${batch.batchNo}-S${pad(seq, 2)}`;
      const sample = {
        id: `SMP-${pad(state.seq.sample, 5)}`,
        code, batchId: batch.id, seq,
        status: 'PENDING', retestOfId: null,
        createdBy: user.id, createdAt: ts,
        history: [], results: {}
      };
      state.samples.push(sample);
      created.push(sample);
    }
    batch.updatedAt = ts;
    batch.rev = (batch.rev || 0) + 1; // 补样改变放行依据
    recomputeBatchStatus(batch, `返工后补取样 ${count} 个`);

    appendAudit('SAMPLES_ADDED', user, [
      { field: 'batchNo', label: '批次号', before: '', after: batch.batchNo },
      { field: 'count', label: '补样数量', before: '0', after: String(count) },
      { field: 'samples', label: '新增样本', before: '', after: created.map(s => s.code).join(', ') }
    ], { type: 'batch', id: batch.id }, reqId);

    save();
    return { samples: created, batch, requestId: reqId };
  }

  /* ============================ 放行规则判定 ============================
   * 放行硬条件（不满足则拦截，并逐条说明原因）：
   *   1. 每个有效样本都有检验记录
   *   2. 无待检样本
   *   3. 无待复测样本
   *   4. 无不合格结果（含复测后仍不合格）
   */
  function evaluateRelease(batchId) {
    const batch = findItem(state.batches, batchId);
    if (!batch) throw new Error('批次不存在');
    const samples = samplesOf(batchId).filter(s => s.status !== 'VOID');
    const checks = [];

    const noRecord = samples.filter(s => s.history.length === 0);
    checks.push({
      key: 'HAS_RECORDS',
      label: '所有样本均有检验记录',
      pass: samples.length > 0 && noRecord.length === 0,
      detail: noRecord.length
        ? `样本 ${noRecord.map(s => s.code).join('、')} 尚未录入检验记录`
        : (samples.length === 0 ? '批次没有任何有效检验样本' : `${samples.length} 个样本均已录入检验记录`)
    });

    const pending = samples.filter(s => s.status === 'PENDING');
    checks.push({
      key: 'NO_PENDING',
      label: '无待检样本',
      pass: pending.length === 0,
      detail: pending.length
        ? `样本 ${pending.map(s => s.code).join('、')} 仍处于待检`
        : '没有待检样本'
    });

    const retest = samples.filter(s => s.status === 'RETEST');
    checks.push({
      key: 'NO_RETEST',
      label: '无待复测样本',
      pass: retest.length === 0,
      detail: retest.length
        ? `样本 ${retest.map(s => s.code).join('、')} 检验不合格，等待复测`
        : '没有待复测样本'
    });

    const failed = samples.filter(s => s.status === 'FAIL');
    checks.push({
      key: 'NO_FAIL',
      label: '无不合格结果',
      pass: failed.length === 0,
      detail: failed.length
        ? `样本 ${failed.map(s => s.code).join('、')} 最终判定不合格，不得放行（请隔离/返工/拒收）`
        : '所有检验项结果合格'
    });

    const pass = checks.every(c => c.pass);
    return {
      batchId,
      canRelease: pass,
      checks,
      reasons: checks.filter(c => !c.pass).map(c => c.detail),
      sampleStats: {
        total: samples.length,
        pass: samples.filter(s => s.status === 'PASS').length,
        pending: pending.length,
        retest: retest.length,
        fail: failed.length,
        void: samplesOf(batchId).filter(s => s.status === 'VOID').length
      }
    };
  }

  /* ============================ 用例：提交放行决定（审批员） ============================
   * 多页签并发保护：
   *  1. hydrate() —— 以持久层最新数据为基准，拒绝用过期内存副本覆盖新写入；
   *  2. expectedRev 乐观锁 —— 页面必须提交打开弹窗时看到的批次版本，不一致即冲突；
   *  3. 放行类型按当前最新数据重新执行 evaluateRelease 四项前置条件复核。
   */
  function conflictError(message, extra) {
    const err = new Error(message);
    err.conflict = true;
    if (extra) Object.assign(err, extra);
    return err;
  }

  function submitDecision(input, user) {
    hydrate();
    requirePerm('decision.submit', user);
    const batch = findItem(state.batches, input.batchId);
    if (!batch) throw new Error('批次不存在');

    const type = input.type;
    if (!Data.DECISION_TYPES[type]) throw new Error('未知的放行决定类型');

    const currentRev = batch.rev || 1;

    // 终态优先拦截：其他页签可能已放行/拒收，绝不能重复提交或覆盖生效决定
    if (TERMINAL_STATUS.includes(batch.status)) {
      const last = latestDecision(batch.id);
      throw conflictError(
        `提交冲突：批次 ${batch.batchNo} 已由其他操作决定为「${BATCH_STATUS[batch.status].name}」` +
        (last ? `（${last.decidedByName} · ${fmtTime(last.decidedAt)}）` : '') +
        '，批次已关闭，您的决定未写入。请刷新页面查看最新状态。',
        { code: 'TERMINAL', currentRev });
    }

    // 乐观并发：版本对不上说明本弹窗依据的数据已被其他页签/操作者改动
    if (input.expectedRev !== undefined && input.expectedRev !== null && input.expectedRev !== '') {
      const expected = Number(input.expectedRev);
      if (Number.isFinite(expected) && expected !== currentRev) {
        throw conflictError(
          `数据版本冲突：该决定依据的是批次第 ${expected} 版数据，此后批次已被其他操作更新到第 ${currentRev} 版` +
          `（当前状态「${BATCH_STATUS[batch.status].name}」）。请刷新并按最新检验数据重新复核后再提交，本次决定未写入。`,
          { code: 'REV_MISMATCH', expectedRev: expected, currentRev });
      }
    }

    // 待审批可直接决定；已隔离批次允许经调查后重新处置（改判返工/拒收/放行）
    if (batch.status !== 'PENDING_REVIEW' && batch.status !== 'QUARANTINED') {
      throw new Error(`批次当前为「${BATCH_STATUS[batch.status].name}」，检验流程未完成，不能提交审批决定`);
    }
    const note = (input.note || '').trim();
    if (note.length < 4) throw new Error('请填写处置/放行依据（至少 4 个字）');

    const ts = Date.now();
    const reqId = newRequestId();

    // 放行必须基于「当前最新数据」复核硬条件；隔离/返工/拒收不受限（本身就是不合格处置）
    let evaluation = null;
    if (type === 'RELEASE') {
      evaluation = evaluateRelease(batch.id);
      if (!evaluation.canRelease) {
        const err = new Error('放行被拦截：\n' + evaluation.reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'));
        err.blocked = true;
        err.evaluation = evaluation;
        throw err;
      }
    }

    state.seq.decision += 1;
    const decision = {
      id: `DEC-${pad(state.seq.decision, 4)}`,
      batchId: batch.id,
      batchNo: batch.batchNo,
      type,
      note,
      basedOnRev: currentRev, // 审计可查：本决定基于第几版批次数据
      decidedBy: user.id,
      decidedByName: user.name,
      decidedAt: ts,
      requestId: reqId
    };
    state.decisions.push(decision);

    const nextStatus = {
      RELEASE: 'RELEASED',
      QUARANTINE: 'QUARANTINED',
      REWORK: 'REWORK',
      REJECT: 'REJECTED'
    }[type];

    // 返工：原不合格样本作废（保留全部检验历史），等待返工后补样
    if (type === 'REWORK') {
      samplesOf(batch.id).forEach(s => {
        if (s.status !== 'VOID') {
          s.status = 'VOID';
          s.voidReason = '批次返工，原检验样本作废';
          s.voidedAt = ts;
        }
      });
    }

    setBatchStatus(batch, nextStatus, `${Data.DECISION_TYPES[type].name}决定：${note}`);
    batch.updatedAt = ts;
    batch.rev = currentRev + 1; // 决定生效 → 版本推进，其他页签的在途提交立即过期
    batch.lastDecisionId = decision.id;

    appendAudit('DECISION_SUBMITTED', user, [
      { field: 'batchNo', label: '批次号', before: '', after: batch.batchNo },
      { field: 'decision', label: '决定', before: '', after: Data.DECISION_TYPES[type].name },
      { field: 'basedOnRev', label: '依据数据版本', before: '', after: `第 ${currentRev} 版` },
      { field: 'note', label: '依据', before: '', after: note }
    ], { type: 'batch', id: batch.id }, reqId);

    save();
    return { decision, batch, evaluation, requestId: reqId };
  }

  /* ============================ 用例：产线维护（质量管理员） ============================ */
  function setLineActive(lineId, active, user) {
    hydrate();
    requirePerm('line.manage', user);
    const line = findItem(state.lines, lineId);
    if (!line) throw new Error('产线不存在');
    if (line.active === active) throw new Error(`产线已是${active ? '启用' : '停用'}状态`);
    const before = line.active ? '启用' : '停用';
    line.active = active;
    const reqId = newRequestId();
    appendAudit('LINE_MANAGED', user, [
      { field: 'lineCode', label: '产线', before: '', after: line.code },
      { field: 'active', label: '状态', before, after: active ? '启用' : '停用' }
    ], { type: 'line', id: line.id }, reqId);
    save();
    return { line, requestId: reqId };
  }

  /* ============================ 查询 ============================ */
  function getState() { return state; }
  function getUser(id) { return Data.USERS.find(u => u.id === id) || null; }
  function getBatch(id) { return findItem(state.batches, id); }
  function getSample(id) { return findItem(state.samples, id); }
  function getSamples(batchId) { return samplesOf(batchId); }
  function decisionsOf(batchId) {
    return state.decisions.filter(d => d.batchId === batchId);
  }
  function latestDecision(batchId) {
    const list = decisionsOf(batchId);
    return list.length ? list[list.length - 1] : null;
  }

  /* ============================ 重置、损坏恢复与演示数据 ============================ */
  function backupCorruptPayload() {
    if (!hasLocalStorage) return false;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try {
      parseStored(raw);
      return false; // 数据合法，无需备份
    } catch (_) {
      // 原始损坏数据移入独立取证键，避免“恢复”动作直接销毁现场
      localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
      return true;
    }
  }

  function resetState(user) {
    if (user) requirePerm('data.reset', user);
    const backedUp = backupCorruptPayload();
    state = defaultState();
    knownRevision = 0;
    loadError = null;
    _seq = 0;
    save();
    return { state, corruptBackupCreated: backedUp, backupKey: backedUp ? CORRUPT_BACKUP_KEY : null };
  }

  /**
   * 显式损坏恢复（质量管理员）：先备份损坏原文，再初始化为空状态。
   * 与普通 reset 的区别是返回值明确告知是否发生过取证备份，绝不静默丢弃。
   */
  function forceReset(user) {
    requirePerm('data.reset', user);
    return resetState();
  }

  function getLoadError() { return loadError; }
  function storageHealth() {
    return loadError
      ? { ok: false, code: 'STATE_CORRUPT', message: loadError.message, backupKey: CORRUPT_BACKUP_KEY }
      : { ok: true, code: 'OK', message: '存储结构正常' };
  }

  /**
   * 灌入演示数据：覆盖 待检/待复测/待审批/已放行/返工中/已隔离 等状态。
   * allOps 用同一操作者串起来，保证审计链真实生成。
   */
  function seedDemoData(now) {
    // 即使是演示数据重置，也不能覆盖损坏的原始数据：先取证备份
    backupCorruptPayload();
    state = defaultState();
    knownRevision = 0;
    loadError = null;
    save();
    const base = (now || Date.now());
    const op = Data.USERS[0], insp = Data.USERS[1], appr = Data.USERS[2];
    const H = 3600 * 1000;

    // 批次1：已放行（2 样本全合格 → 审批放行）
    const b1 = createBatch({ lineId: 'L01', product: '无菌注射器 10mL', quantity: 12000, sampleCount: 2 }, op);
    b1.batch.createdAt = base - 9 * H;
    b1.samples.forEach(s => { s.createdAt = base - 9 * H; });
    saveInspection({ sampleId: b1.samples[0].id, results: { sealStrength: '2.1', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    saveInspection({ sampleId: b1.samples[1].id, results: { sealStrength: '2.4', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    submitDecision({ batchId: b1.batch.id, type: 'RELEASE', note: '全部检验项合格，无菌屏障完整，准予放行。' }, appr);

    // 批次2：待复测（1 样本外观不合格，自动进待复测）
    const b2 = createBatch({ lineId: 'L02', product: '静脉留置针 22G', quantity: 8000, sampleCount: 2 }, op);
    saveInspection({ sampleId: b2.samples[0].id, results: { sealStrength: '2.0', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    saveInspection({ sampleId: b2.samples[1].id, results: { sealStrength: '1.8', visual: '不合格', barrier: '合格', label: '合格' } }, insp);

    // 批次3：待审批（3 样本全合格，等审批员决定）
    const b3 = createBatch({ lineId: 'L03', product: '手术刀片 11#', quantity: 5000, sampleCount: 3 }, op);
    saveInspection({ sampleId: b3.samples[0].id, results: { sealStrength: '2.2', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    saveInspection({ sampleId: b3.samples[1].id, results: { sealStrength: '2.6', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    saveInspection({ sampleId: b3.samples[2].id, results: { sealStrength: '1.9', visual: '合格', barrier: '合格', label: '合格' } }, insp);

    // 批次4：已隔离（密封强度超限不合格 → 审批隔离）
    const b4 = createBatch({ lineId: 'L01', product: '无菌注射器 10mL', quantity: 6000, sampleCount: 2 }, op);
    saveInspection({ sampleId: b4.samples[0].id, results: { sealStrength: '2.0', visual: '合格', barrier: '合格', label: '合格' } }, insp);
    // 第一轮不合格 → 待复测 → 复测仍不合格 → 最终 FAIL
    saveInspection({ sampleId: b4.samples[1].id, results: { sealStrength: '0.9', visual: '合格', barrier: '不合格', label: '合格' } }, insp);
    requestRetest(b4.samples[1].id, insp);
    saveInspection({ sampleId: b4.samples[1].id, results: { sealStrength: '1.0', visual: '合格', barrier: '不合格', label: '合格' } }, insp);
    // 第二轮复测仍不合格 → 样本自动转为最终 FAIL，批次自动进入待审批
    submitDecision({ batchId: b4.batch.id, type: 'QUARANTINE', note: '无菌屏障复测仍不合格，批次隔离待质量调查。' }, appr);

    // 批次5：待检（刚登记，2 样本未检验）
    const b5 = createBatch({ lineId: 'L03', product: '手术刀片 11#', quantity: 7000, sampleCount: 2 }, op);

    // 批次6：返工中（已审批返工，样本作废，等待返工补样）
    const b6 = createBatch({ lineId: 'L02', product: '静脉留置针 22G', quantity: 4000, sampleCount: 1 }, op);
    saveInspection({ sampleId: b6.samples[0].id, results: { sealStrength: '1.1', visual: '不合格', barrier: '合格', label: '不合格' } }, insp);
    requestRetest(b6.samples[0].id, insp);
    saveInspection({ sampleId: b6.samples[0].id, results: { sealStrength: '1.2', visual: '不合格', barrier: '合格', label: '不合格' } }, insp);
    // 复测仍不合格 → 自动最终 FAIL → 待审批
    submitDecision({ batchId: b6.batch.id, type: 'REWORK', note: '封口外观与标签系统性缺陷，退回产线返工后重新取样。' }, appr);

    return state;
  }

  /* ============================ 导出 ============================ */
  const api = {
    // 常量
    BATCH_STATUS, SAMPLE_STATUS, TERMINAL_STATUS, BATCH_STATUSES,
    PERMISSIONS, AUDIT_ACTIONS,
    // 工具
    fmtTime, newRequestId, hash32,
    // 审计
    verifyAudit,
    // 用例
    createBatch, saveInspection, requestRetest, addSamples,
    evaluateRelease, submitDecision, setLineActive,
    // 查询
    getState, getUser, getBatch, getSample, getSamples, decisionsOf, latestDecision,
    // 管理
    resetState, forceReset, seedDemoData,
    // 存储健康 / 损坏检测
    getLoadError, storageHealth,
    // 多页签并发
    hydrate, onExternalChange,
    // 测试辅助
    _nextBatchNo: nextBatchNo, _recompute: recomputeBatchStatus
  };
  return api;
});
