/* ============================================================
 * app.js —— 页面层：总览 / 批次队列 / 检验工作台 / 放行审批 / 审计记录
 * 所有写操作经 store 领域层；页面只做授权内的渲染与交互
 * ============================================================ */
(function () {
  'use strict';
  const D = window.SRData, S = window.SRStore;

  /* ---------------- 会话与路由 ---------------- */
  const SESSION_KEY = 'sr_user_id';
  let user = D.USERS.find(u => u.id === sessionStorage.getItem(SESSION_KEY)) || D.USERS[0];
  let route = (location.hash || '#/dashboard').replace('#/', '');
  let queueFilter = 'ALL';
  let auditFilter = 'ALL';

  // 当前打开的弹窗上下文：{ kind, id, rev? } —— 跨页签数据变化时据此判定弹窗依据是否过期
  let activeModal = null;

  const PAGE_META = {
    dashboard:  ['总览', '生产、检验与放行关键状态一览'],
    queue:      ['批次队列', '全部批次及统一状态标签'],
    inspection: ['检验工作台', '待检 / 待复测样本结果录入'],
    approval:   ['放行审批', '放行条件核查与处置决定'],
    audit:      ['审计记录', '操作留痕，哈希链校验，不可更改']
  };
  const ROUTE_ROLE_NOTICE = {
    inspection: { role: 'INSPECTOR', text: '当前角色为只读查看：检验结果仅检验员可录入。' },
    approval:   { role: 'APPROVER',  text: '当前角色为只读查看：放行决定仅审批员可提交。' }
  };

  /* ---------------- DOM 工具 ---------------- */
  const $ = sel => document.querySelector(sel);
  const view = $('#view');
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const fmt = S.fmtTime;
  function can(perm) { return (S.PERMISSIONS[perm] || []).includes(user.role); }
  function batchTag(status) {
    const t = S.BATCH_STATUS[status];
    return t ? `<span class="tag tag-${status}">${t.name}</span>` : '';
  }
  function sampleTag(status) {
    const t = S.SAMPLE_STATUS[status];
    return t ? `<span class="tag tag-${status}">${t.name}</span>` : '';
  }
  function lineOf(id) { return S.getState().lines.find(l => l.id === id); }
  function samplesOfBatch(batchId) { return S.getSamples(batchId); }
  function statusCounts() {
    const c = {};
    Object.keys(S.BATCH_STATUS).forEach(k => { c[k] = 0; });
    S.getState().batches.forEach(b => { c[b.status] = (c[b.status] || 0) + 1; });
    return c;
  }

  /* ---------------- Toast ---------------- */
  function toast(kind, title, body, requestId) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML =
      (title ? `<div class="toast-title">${esc(title)}</div>` : '') +
      (body ? `<div class="toast-body">${esc(body)}</div>` : '') +
      (requestId ? `<div class="toast-req">请求标识：${esc(requestId)}</div>` : '');
    $('#toastRoot').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
    setTimeout(() => el.remove(), 4600);
  }
  function setReqChip(id) { if (id) $('#reqChip').textContent = '最近请求 ' + id; }

  /** 统一包裹写操作：错误（含放行拦截/版本冲突）弹通知；成功显示请求标识 */
  function runOp(title, fn) {
    try {
      const r = fn();
      if (r && r.requestId) setReqChip(r.requestId);
      toast('success', title + '成功', r && r.requestId ? ('请求标识 ' + r.requestId) : '', r && r.requestId);
      return r;
    } catch (e) {
      if (e.conflict) {
        toast('warning', '提交冲突（数据已被其他页签/操作者更新）', e.message);
      } else if (e.blocked) {
        toast('error', '放行被拦截', e.message.replace('放行被拦截：\n', ''));
      } else {
        toast('error', title + '失败', e.message);
      }
      return null;
    }
  }

  /* ---------------- Modal ---------------- */
  function closeModal() { $('#modalRoot').innerHTML = ''; activeModal = null; }
  function openModal(opt) {
    const root = $('#modalRoot');
    root.innerHTML =
      `<div class="modal-mask">
        <div class="modal ${opt.lg ? 'lg' : ''}" role="dialog">
          <div class="modal-head">
            <div class="modal-title">${esc(opt.title)}</div>
            <button class="modal-close" data-close-modal type="button">✕</button>
          </div>
          <div class="modal-body">${opt.body}</div>
          ${opt.footer !== false ? `<div class="modal-foot">${opt.footer || '<button class="btn btn-outline" data-close-modal type="button">关闭</button>'}</div>` : ''}
        </div>
      </div>`;
    activeModal = opt.context || null;
    if (opt.onMount) opt.onMount(root.querySelector('.modal'));
    return root.querySelector('.modal');
  }

  /** 将当前弹窗标记为“依据已过期”：禁用提交并提示重新打开 */
  function markModalStale(message) {
    const modalEl = document.querySelector('.modal');
    if (!modalEl) return;
    const body = modalEl.querySelector('.modal-body');
    if (body && !body.querySelector('.stale-banner')) {
      const banner = document.createElement('div');
      banner.className = 'banner banner-danger stale-banner';
      banner.style.marginBottom = '12px';
      banner.innerHTML = `⛔ ${esc(message || '该弹窗依据的数据已被其他页签更新，不能继续提交。')}
        <button class="btn btn-danger btn-xs" type="button" style="margin-left:8px" data-act="close-and-refresh">按最新数据重新打开</button>`;
      body.insertBefore(banner, body.firstChild);
    }
    modalEl.querySelectorAll('.modal-foot button[type="submit"], .modal-foot .btn-success, .modal-foot .btn-warning, .modal-foot .btn-primary')
      .forEach(b => { b.disabled = true; });
  }

  /* ---------------- 导航刷新 ---------------- */
  function refreshChrome() {
    document.querySelectorAll('.nav-item').forEach(a => {
      a.classList.toggle('active', a.dataset.route === route);
    });
    const counts = statusCounts();
    const pendingSamples = S.getState().samples.filter(s => s.status === 'PENDING' || s.status === 'RETEST').length;
    const reviewBatches = counts.PENDING_REVIEW + counts.QUARANTINED;
    setBadge('dashboard', counts.PENDING_INSPECTION + counts.PENDING_RETEST + counts.PENDING_REVIEW);
    setBadge('queue', S.getState().batches.length);
    setBadge('inspection', pendingSamples);
    setBadge('approval', reviewBatches);
    setBadge('audit', S.getState().audit.length);

    $('#pageTitle').textContent = PAGE_META[route][0];
    $('#pageSub').textContent = PAGE_META[route][1];
    $('#linesBtn').hidden = !can('line.manage');
    $('#resetBtn').hidden = !can('data.reset');
  }
  function setBadge(name, n) {
    const el = document.querySelector(`[data-count="${name}"]`);
    el.textContent = n;
    el.classList.toggle('show', n > 0);
  }

  function render() {
    refreshChrome();
    ({
      dashboard: renderDashboard,
      queue: renderQueue,
      inspection: renderInspection,
      approval: renderApproval,
      audit: renderAudit
    }[route] || renderDashboard)();
  }

  /* ================================================================
   * 总览
   * ================================================================ */
  const BAR_COLORS = {
    PENDING_INSPECTION: '#2f7fa3', PENDING_RETEST: '#d68a1e', PENDING_REVIEW: '#1f6fb2',
    RELEASED: '#1e8a4c', QUARANTINED: '#e0a23a', REWORK: '#7a8896', REJECTED: '#c0392b'
  };

  function renderDashboard() {
    const st = S.getState();
    const c = statusCounts();
    const activeTotal = c.PENDING_INSPECTION + c.PENDING_RETEST + c.PENDING_REVIEW + c.QUARANTINED + c.REWORK;
    const pendingSamples = st.samples.filter(x => x.status === 'PENDING').length;
    const retestSamples = st.samples.filter(x => x.status === 'RETEST').length;

    const cards = [
      { key: 'PENDING_INSPECTION', label: '待检批次', n: c.PENDING_INSPECTION, foot: `${pendingSamples} 个样本待检验` },
      { key: 'PENDING_RETEST', label: '待复测批次', n: c.PENDING_RETEST, foot: `${retestSamples} 个样本待复测` },
      { key: 'PENDING_REVIEW', label: '待审批批次', n: c.PENDING_REVIEW, foot: '等待审批员放行决定' },
      { key: 'QUARANTINED', label: '已隔离批次', n: c.QUARANTINED, foot: '隔离区挂起待处置' },
      { key: 'REWORK', label: '返工中批次', n: c.REWORK, foot: '返工后重新取样检验' },
      { key: 'RELEASED', label: '已放行批次', n: c.RELEASED, foot: `在制 ${activeTotal} 批 / 拒收 ${c.REJECTED}` }
    ];

    const total = st.batches.length || 1;
    const bar = Object.keys(BAR_COLORS).map(k => {
      const pct = (c[k] || 0) / total * 100;
      return pct > 0 ? `<div class="statusbar-seg" style="width:${pct}%;background:${BAR_COLORS[k]}" title="${S.BATCH_STATUS[k].name} ${c[k]}"></div>` : '';
    }).join('');
    const legend = Object.keys(BAR_COLORS).map(k =>
      `<span class="legend-item" data-act="goto-queue-filter" data-filter="${k}">
        <span class="legend-dot" style="background:${BAR_COLORS[k]}"></span>${S.BATCH_STATUS[k].name}（${c[k] || 0}）
      </span>`).join('');

    const recentBatches = st.batches.slice(-6).reverse().map(b => `
      <tr class="clickable" data-act="open-batch" data-id="${b.id}">
        <td class="mono">${esc(b.batchNo)}</td>
        <td>${esc(b.product)}<div class="cell-sub">${esc(b.lineCode)}</div></td>
        <td>${batchTag(b.status)}</td>
        <td class="muted">${fmt(b.createdAt)}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty">暂无批次</td></tr>`;

    const recentAudit = st.audit.slice(-6).reverse().map(a => `
      <tr>
        <td class="muted">${fmt(a.ts)}</td>
        <td>${esc(a.actorName)} <span class="actor-role">${D.ROLES[a.actorRole].name}</span></td>
        <td>${esc(S.AUDIT_ACTIONS[a.action] || a.action)}</td>
        <td class="mono muted">${esc(a.targetId)}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty">暂无审计记录</td></tr>`;

    const canCreate = can('batch.create');

    view.innerHTML = `
      <div class="grid stat-grid" style="margin-bottom:14px">
        ${cards.map(x => `
          <div class="card stat-card" data-act="goto-queue-filter" data-filter="${x.key}">
            <div class="stat-label">${x.label}</div>
            <div class="stat-num" style="color:${BAR_COLORS[x.key]}">${x.n}</div>
            <div class="stat-foot">${esc(x.foot)}</div>
          </div>`).join('')}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="section-title">批次状态分布 <span class="hint">点击图例可跳转批次队列筛选</span></div>
        <div class="statusbar">${bar}</div>
        <div class="legend">${legend}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px" class="dash-cols">
        <div class="card table-card">
          <div class="table-toolbar">
            <div class="section-title" style="margin:0">最近批次</div>
            <span style="flex:1"></span>
            ${canCreate ? `<button class="btn btn-primary btn-sm" data-act="create-batch">＋ 登记批次</button>` : ''}
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>批次号</th><th>产品/产线</th><th>状态</th><th>登记时间</th></tr></thead>
            <tbody>${recentBatches}</tbody>
          </table></div>
        </div>
        <div class="card table-card">
          <div class="table-toolbar"><div class="section-title" style="margin:0">最近操作</div>
            <span style="flex:1"></span>
            <button class="btn btn-outline btn-sm" data-act="goto" data-route="audit">全部审计</button>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th></tr></thead>
            <tbody>${recentAudit}</tbody>
          </table></div>
        </div>
      </div>`;
  }

  /* ================================================================
   * 批次队列
   * ================================================================ */
  function sampleSummary(batchId) {
    const ss = samplesOfBatch(batchId);
    const order = ['PENDING', 'RETEST', 'FAIL', 'PASS', 'VOID'];
    return order.map(k => {
      const n = ss.filter(s => s.status === k).length;
      return n ? `<span class="sample-pill ${k}">${S.SAMPLE_STATUS[k].name} ${n}</span>` : '';
    }).join('');
  }

  function renderQueue() {
    const st = S.getState();
    const filters = [{ key: 'ALL', name: '全部' }].concat(
      Object.values(S.BATCH_STATUS).map(t => ({ key: t.key, name: t.name })));
    const list = st.batches
      .filter(b => queueFilter === 'ALL' || b.status === queueFilter)
      .slice().reverse();

    const rows = list.map(b => `
      <tr class="clickable" data-act="open-batch" data-id="${b.id}">
        <td>
          <div class="mono strong">${esc(b.batchNo)}</div>
          <div class="cell-sub">${esc(b.id)}</div>
        </td>
        <td>
          <div class="strong">${esc(b.product)}</div>
          <div class="cell-sub">${esc(b.lineCode)} · 执行标准 ${esc(b.standard)}</div>
        </td>
        <td>${b.quantity.toLocaleString()} 件</td>
        <td><div class="samples-strip">${sampleSummary(b.id) || '<span class="muted">无样本</span>'}</div></td>
        <td>${batchTag(b.status)}</td>
        <td>
          <div>${esc(b.createdByName)}</div>
          <div class="cell-sub">${fmt(b.createdAt)}</div>
        </td>
        <td><button class="btn btn-outline btn-xs" data-act="open-batch" data-id="${b.id}">详情</button></td>
      </tr>`).join('');

    view.innerHTML = `
      <div class="card table-card">
        <div class="table-toolbar">
          ${filters.map(f =>
            `<span class="filter-chip ${queueFilter === f.key ? 'active' : ''}"
                  data-act="queue-filter" data-filter="${f.key}">${esc(f.name)}</span>`).join('')}
          <span style="flex:1"></span>
          ${can('batch.create')
            ? `<button class="btn btn-primary" data-act="create-batch">＋ 登记批次</button>`
            : `<span class="hint" style="font-size:12px;color:var(--ink-3)">仅操作员可登记批次（当前：${D.ROLES[user.role].name}）</span>`}
        </div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th>批次号</th><th>产品 / 产线</th><th>数量</th><th>检验样本</th><th>批次状态</th><th>登记人</th><th></th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="7"><div class="empty">该筛选条件下暂无批次</div></td></tr>`}</tbody>
        </table></div>
      </div>`;
  }

  /* ================================================================
   * 检验工作台
   * ================================================================ */
  function sampleItemValues(sample) {
    return D.INSPECTION_ITEMS.map(item => {
      const r = sample.results[item.key];
      if (!r) return `<span class="mini-res">${esc(item.name)}：—</span>`;
      return `<span class="mini-res ${r.qualified ? 'good' : 'bad'}">${esc(item.name)} ${esc(String(r.value))}</span>`;
    }).join('');
  }

  function sampleRow(s) {
    const b = S.getBatch(s.batchId);
    const round = Math.max(1, ...s.history.map(h => h.round || 1));
    let action = '';
    if (can('inspection.save')) {
      if (s.status === 'PENDING') {
        action = `<button class="btn btn-primary btn-xs" data-act="inspect" data-id="${s.id}">录入检验结果</button>`;
      } else if (s.status === 'RETEST') {
        action = s.awaitingRetestRound
          ? `<button class="btn btn-primary btn-xs" data-act="inspect" data-id="${s.id}">录入第 ${s.awaitingRetestRound} 轮复测</button>`
          : `<button class="btn btn-warning btn-xs" data-act="retest" data-id="${s.id}">发起复测</button>`;
      }
    }
    return `<tr>
      <td class="mono">${esc(s.code)}</td>
      <td class="mono"><a data-act="open-batch" data-id="${b.id}" style="color:var(--primary);cursor:pointer">${esc(b.batchNo)}</a>
        <div class="cell-sub">${esc(b.product)}</div></td>
      <td>${sampleTag(s.status)}${s.awaitingRetestRound ? `<div class="cell-sub">待录入第 ${s.awaitingRetestRound} 轮</div>` : ''}</td>
      <td><div class="samples-strip">${sampleItemValues(s)}</div>
          <div class="cell-sub">${s.history.length ? `已录入 ${round} 轮 · ${esc(s.lastInspectorName || '')}` : '尚未检验'}</div></td>
      <td style="text-align:right">${action}</td>
    </tr>`;
  }

  function renderInspection() {
    const st = S.getState();
    const readOnly = !can('inspection.save');
    const pending = st.samples.filter(s => s.status === 'PENDING');
    const retest = st.samples.filter(s => s.status === 'RETEST');
    const finalBad = st.samples.filter(s => s.status === 'FAIL');
    const others = st.samples.filter(s => s.status === 'PASS' || s.status === 'VOID');

    const table = (list, emptyText) => `
      <div class="table-wrap"><table>
        <thead><tr><th>样本编号</th><th>所属批次</th><th>样本状态</th><th>最新检验结果</th><th></th></tr></thead>
        <tbody>${list.map(sampleRow).join('') || `<tr><td colspan="5"><div class="empty">${emptyText}</div></td></tr>`}</tbody>
      </table></div>`;

    view.innerHTML = `
      ${readOnly ? `<div class="banner banner-info">ⓘ ${ROUTE_ROLE_NOTICE.inspection.text}</div>` : ''}
      <div class="card table-card" style="margin-bottom:14px">
        <div class="table-toolbar">
          <div class="section-title" style="margin:0">待检样本 <span class="hint">（${pending.length}）首轮检验</span></div>
        </div>
        ${table(pending, '没有待检样本')}
      </div>
      <div class="card table-card" style="margin-bottom:14px">
        <div class="table-toolbar">
          <div class="section-title" style="margin:0">待复测样本 <span class="hint">（${retest.length}）首轮不合格自动进入；复测合格解除，复测仍不合格转最终不合格</span></div>
        </div>
        ${table(retest, '没有待复测样本')}
      </div>
      <div class="card table-card" style="margin-bottom:14px">
        <div class="table-toolbar"><div class="section-title" style="margin:0">最终不合格 <span class="hint">（${finalBad.length}）等待审批处置</span></div></div>
        ${table(finalBad, '无最终不合格样本')}
      </div>
      <div class="card table-card">
        <div class="table-toolbar"><div class="section-title" style="margin:0">已合格 / 已作废样本 <span class="hint">（${others.length}）</span></div></div>
        ${table(others, '暂无记录')}
      </div>`;
  }

  /* ================================================================
   * 放行审批
   * ================================================================ */
  function renderApproval() {
    const st = S.getState();
    const readOnly = !can('decision.submit');
    const reviewList = st.batches.filter(b => b.status === 'PENDING_REVIEW' || b.status === 'QUARANTINED');
    const recent = st.decisions.slice().reverse().slice(0, 8);

    const cards = reviewList.map(b => {
      const ev = S.evaluateRelease(b.id);
      const checks = ev.checks.map(c => `
        <div class="check-row ${c.pass ? 'pass' : 'fail'}">
          <span class="check-ico">${c.pass ? '✅' : '⛔'}</span>
          <div>
            <div class="check-text check-label">${esc(c.label)}</div>
            <div class="check-detail">${esc(c.detail)}</div>
          </div>
        </div>`).join('');
      const last = S.latestDecision(b.id);
      return `<div class="card" style="margin-bottom:14px">
        <div class="detail-head">
          <div>
            <div class="detail-title mono">${esc(b.batchNo)}</div>
            <div class="cell-sub">${esc(b.product)} · ${esc(b.lineCode)} · ${b.quantity.toLocaleString()} 件</div>
          </div>
          ${batchTag(b.status)}
          <span class="tag tag-VOID mono" title="批次数据版本：他页签每改动一次检验/决定即 +1，提交决定时按此版本乐观加锁">v${b.rev || 1}</span>
          <span style="flex:1"></span>
          <div class="dl-btns">
            <button class="btn btn-outline btn-sm" data-act="open-batch" data-id="${b.id}">批次详情</button>
            ${readOnly ? '' : `
              ${ev.canRelease
                ? `<button class="btn btn-success" data-act="decide" data-id="${b.id}">提交放行决定</button>`
                : `<button class="btn btn-warning" data-act="decide" data-id="${b.id}">提交处置决定</button>`}`}
          </div>
        </div>
        ${b.status === 'QUARANTINED' ? `<div class="banner banner-warning" style="margin:0 0 12px">⚠ 该批次此前已隔离。${last ? '上次依据：' + esc(last.note) : ''}</div>` : ''}
        ${!ev.canRelease ? `<div class="banner banner-danger" style="margin:0 0 12px">⛔ 不满足放行条件，<b>放行操作将被拦截</b>，请选择隔离 / 返工 / 拒收。</div>` : ''}
        <div class="check-list">${checks}</div>
      </div>`;
    }).join('');

    const decRows = recent.map(d => `
      <tr>
        <td class="mono">${fmt(d.decidedAt)}</td>
        <td class="mono">${esc(d.batchNo)}</td>
        <td><span class="tag tag-${({RELEASE:'RELEASED',QUARANTINE:'QUARANTINED',REWORK:'REWORK',REJECT:'REJECTED'})[d.type]}">${D.DECISION_TYPES[d.type].name}</span></td>
        <td>${esc(d.decidedByName)}</td>
        <td class="muted">${esc(d.note)}</td>
        <td class="mono muted">${esc(d.requestId)}</td>
      </tr>`).join('');

    view.innerHTML = `
      ${readOnly ? `<div class="banner banner-info">ⓘ ${ROUTE_ROLE_NOTICE.approval.text}</div>` : ''}
      <div class="section-title">待审批 / 隔离待处置批次 <span class="hint">共 ${reviewList.length} 批</span></div>
      ${cards || `<div class="card"><div class="empty">没有待审批批次</div></div>`}
      <div class="card table-card">
        <div class="table-toolbar"><div class="section-title" style="margin:0">最近决定记录</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>批次号</th><th>决定</th><th>审批员</th><th>依据</th><th>请求标识</th></tr></thead>
          <tbody>${decRows || `<tr><td colspan="6" class="empty">暂无决定记录</td></tr>`}</tbody>
        </table></div>
      </div>`;
  }

  /* ================================================================
   * 审计记录
   * ================================================================ */
  function renderAudit() {
    const st = S.getState();
    const v = S.verifyAudit();
    const filters = [{ key: 'ALL', name: '全部' }]
      .concat(Object.keys(S.AUDIT_ACTIONS).map(k => ({ key: k, name: S.AUDIT_ACTIONS[k] })));

    const targetName = { batch: '批次', sample: '样本', line: '产线' };
    const rows = st.audit.slice().reverse()
      .filter(a => auditFilter === 'ALL' || a.action === auditFilter)
      .map(a => `
      <tr class="audit-row">
        <td class="muted" style="white-space:nowrap">${fmt(a.ts)}<div class="cell-sub mono">${esc(a.id)}</div></td>
        <td><span class="mono">${esc(a.requestId)}</span></td>
        <td><span class="actor-chip">${esc(a.actorName)}<span class="actor-role">${D.ROLES[a.actorRole].name}</span></span></td>
        <td style="white-space:nowrap"><b>${esc(S.AUDIT_ACTIONS[a.action] || a.action)}</b>
          <div class="cell-sub">${targetName[a.targetType] ? esc(targetName[a.targetType]) + ' · ' : ''}<span class="mono">${esc(a.targetId)}</span></div>
        </td>
        <td><ul class="changes-list">
          ${a.changes.map(c => `<li>
              <span class="muted">${esc(c.label)}：</span>
              ${c.before ? `<span class="before-val">${esc(c.before)}</span><span class="arrow">→</span>` : ''}
              <span class="${c.before ? 'strong' : ''}">${esc(c.after)}</span>
            </li>`).join('')}
        </ul></td>
      </tr>`).join('');

    view.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="verify-box">
          <div>
            <div class="section-title" style="margin:0">防篡改校验（FNV-1a 哈希链）</div>
            <div class="kvline" style="margin-top:4px">共 <b>${v.total}</b> 条审计记录，每条记录包含前一条记录的哈希；任何新增、删除、修改都会断链。</div>
          </div>
          <span style="flex:1"></span>
          ${v.ok
            ? '<span class="tag tag-RELEASED">链完整 · 未被篡改</span>'
            : '<span class="tag tag-FAIL">校验失败</span>'}
          <button class="btn btn-outline btn-sm" data-act="verify-audit">重新校验</button>
        </div>
        ${v.ok
          ? `<div class="hash-chain">GENESIS → ${st.audit.slice(0, 3).map(a => esc(a.hash)).join(' → ')} → … → ${esc(st.audit[st.audit.length - 1].hash)}</div>`
          : `<div class="banner banner-danger" style="margin-top:12px;margin-bottom:0">⛔ ${esc(v.error)}（第 ${v.brokenAt} 条）</div>`}
      </div>
      <div class="card table-card">
        <div class="table-toolbar">
          ${filters.map(f =>
            `<span class="filter-chip ${auditFilter === f.key ? 'active' : ''}"
                  data-act="audit-filter" data-filter="${f.key}">${esc(f.name)}</span>`).join('')}
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>时间</th><th>请求标识</th><th>操作者</th><th>动作 / 对象</th><th>变更内容（不可更改）</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="empty">该筛选下暂无记录</td></tr>`}</tbody>
        </table></div>
      </div>`;
  }

  /* ================================================================
   * 弹窗：登记批次
   * ================================================================ */
  function openCreateBatch() {
    if (!can('batch.create')) return;
    const lines = S.getState().lines.filter(l => l.active);
    openModal({
      title: '登记生产批次',
      body: `
        <form id="createBatchForm" data-form="create-batch" class="form-grid">
          <div class="form-field">
            <label>生产产线 *</label>
            <select name="lineId" required>
              ${lines.map(l => `<option value="${l.id}">${esc(l.code)} · ${esc(l.name)}</option>`).join('')}
            </select>
            <span class="hint">仅启用状态产线可登记；停用产线由质量管理员维护</span>
          </div>
          <div class="form-field">
            <label>产品名称 *</label>
            <input name="product" list="productList" required placeholder="如：无菌注射器 10mL">
            <datalist id="productList">${D.PRODUCTS.map(p => `<option value="${esc(p)}">`).join('')}</datalist>
          </div>
          <div class="form-field">
            <label>生产数量（件）*</label>
            <input name="quantity" type="number" min="1" step="1" value="5000" required>
          </div>
          <div class="form-field">
            <label>检验样本数 *</label>
            <input name="sampleCount" type="number" min="1" max="20" step="1" value="3" required>
            <span class="hint">登记后自动生成对应数量的待检样本（1~20）</span>
          </div>
          <div class="form-field full">
            <label>执行标准</label>
            <input name="standard" value="ISO 11607">
          </div>
        </form>`,
      footer: `<button class="btn btn-outline" data-close-modal type="button">取消</button>
               <button class="btn btn-primary" type="submit" form="createBatchForm">登记批次并生成样本</button>`
    });
  }

  /* ================================================================
   * 弹窗：批次详情
   * ================================================================ */
  function openBatchDetail(id) {
    const b = S.getBatch(id);
    if (!b) return;
    const samples = samplesOfBatch(id);
    const decisions = S.decisionsOf(id);
    const ev = S.evaluateRelease(id);
    const inspector = can('inspection.save');
    const approver = can('decision.submit');

    const sampleRows = samples.map(s => {
      const round = Math.max(1, ...s.history.map(h => h.round || 1));
      let acts = '';
      if (inspector) {
        if (s.status === 'PENDING') acts = `<button class="btn btn-primary btn-xs" data-act="inspect" data-id="${s.id}">录入结果</button>`;
        else if (s.status === 'RETEST') acts = s.awaitingRetestRound
          ? `<button class="btn btn-primary btn-xs" data-act="inspect" data-id="${s.id}">录入复测</button>`
          : `<button class="btn btn-warning btn-xs" data-act="retest" data-id="${s.id}">发起复测</button>`;
      }
      return `<tr>
        <td class="mono">${esc(s.code)}</td>
        <td>${sampleTag(s.status)}</td>
        <td><div class="samples-strip">${sampleItemValues(s)}</div></td>
        <td class="muted">${s.history.length ? `已检 ${round} 轮` : '—'}</td>
        <td style="text-align:right">
          <button class="btn btn-outline btn-xs" data-act="sample-history" data-id="${s.id}">检验记录</button>
          ${acts}
        </td>
      </tr>`;
    }).join('');

    const checks = ev.checks.map(c => `
      <div class="check-row ${c.pass ? 'pass' : 'fail'}">
        <span class="check-ico">${c.pass ? '✅' : '⛔'}</span>
        <div><div class="check-text">${esc(c.label)}</div><div class="check-detail">${esc(c.detail)}</div></div>
      </div>`).join('');

    const decList = decisions.map(d => `
      <li class="${d.type === 'RELEASE' ? '' : 'bad'}">
        <div class="tl-title">${D.DECISION_TYPES[d.type].name} · ${esc(d.decidedByName)}</div>
        <div class="tl-sub">${fmt(d.decidedAt)} · <span class="mono">${esc(d.requestId)}</span></div>
        <div class="kvline">${esc(d.note)}</div>
      </li>`).join('');

    const logList = b.statusLogs.slice().reverse().map(l => `
      <li class="${['REJECTED', 'QUARANTINED'].includes(l.to) ? 'bad' : ''}">
        <div class="tl-title">${l.from ? S.BATCH_STATUS[l.from].name + ' → ' : ''}${S.BATCH_STATUS[l.to].name}</div>
        <div class="tl-sub">${fmt(l.ts)}</div>
        ${l.reason ? `<div class="kvline">${esc(l.reason)}</div>` : ''}
      </li>`).join('');

    const footActions = [];
    if (approver && (b.status === 'PENDING_REVIEW' || b.status === 'QUARANTINED')) {
      footActions.push(ev.canRelease
        ? `<button class="btn btn-success" data-act="decide" data-id="${b.id}">提交放行决定</button>`
        : `<button class="btn btn-warning" data-act="decide" data-id="${b.id}">提交处置决定</button>`);
    }
    if (inspector && b.status === 'REWORK') {
      footActions.push(`<button class="btn btn-primary" data-act="add-samples" data-id="${b.id}">返工后补取样</button>`);
    }

    openModal({
      lg: true,
      title: '批次详情',
      context: { kind: 'batch', id: b.id, rev: b.rev || 1 },
      body: `
        <div class="detail-head">
          <div>
            <div class="detail-title mono">${esc(b.batchNo)}</div>
            <div class="cell-sub">${esc(b.id)}</div>
          </div>
          ${batchTag(b.status)}
        </div>
        <div class="detail-meta">
          <div class="meta-item"><div class="k">产品</div><div class="v">${esc(b.product)}</div></div>
          <div class="meta-item"><div class="k">产线</div><div class="v">${esc(b.lineCode)}</div></div>
          <div class="meta-item"><div class="k">生产数量</div><div class="v">${b.quantity.toLocaleString()} 件</div></div>
          <div class="meta-item"><div class="k">执行标准</div><div class="v">${esc(b.standard)}</div></div>
          <div class="meta-item"><div class="k">登记人</div><div class="v">${esc(b.createdByName)}</div></div>
          <div class="meta-item"><div class="k">登记时间</div><div class="v">${fmt(b.createdAt)}</div></div>
          <div class="meta-item"><div class="k">数据版本</div><div class="v mono">v${b.rev || 1}</div></div>
        </div>

        <div class="section-title">放行条件核查</div>
        <div class="check-list" style="margin-bottom:16px">
          ${!ev.canRelease ? `<div class="banner banner-danger" style="margin:0 0 4px">⛔ 当前不满足放行条件：${esc(ev.reasons.join('；'))}</div>` : ''}
          ${checks}
        </div>

        <div class="section-title">检验样本（${samples.length}）<span class="hint">不合格样本首轮自动待复测</span></div>
        <div class="table-wrap" style="border:1px solid var(--line);border-radius:8px;margin-bottom:16px">
          <table>
            <thead><tr><th>样本编号</th><th>状态</th><th>最新结果</th><th>轮次</th><th style="text-align:right">操作</th></tr></thead>
            <tbody>${sampleRows || `<tr><td colspan="5" class="empty">返工批次暂无有效样本，请补取样</td></tr>`}</tbody>
          </table>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
          <div>
            <div class="section-title">放行/处置记录</div>
            <ul class="timeline">${decList || '<li><div class="kvline muted">尚无决定记录</div></li>'}</ul>
          </div>
          <div>
            <div class="section-title">状态流转</div>
            <ul class="timeline">${logList}</ul>
          </div>
        </div>`,
      footer: `${footActions.join('')}<button class="btn btn-outline" data-close-modal type="button">关闭</button>`
    });
  }

  /* ================================================================
   * 弹窗：样本检验记录（历史时间线）
   * ================================================================ */
  function openSampleHistory(sampleId) {
    const s = S.getSample(sampleId);
    if (!s) return;
    const b = S.getBatch(s.batchId);
    const rounds = {};
    s.history.forEach(h => { (rounds[h.round] = rounds[h.round] || []).push(h); });
    const body = Object.keys(rounds).sort((a, b2) => a - b2).reverse().map(r => `
      <div style="margin-bottom:14px">
        <div class="section-title" style="margin-bottom:6px">${Number(r) > 1 ? `第 ${r} 轮（复测）` : '首轮检验'}</div>
        <div class="table-wrap" style="border:1px solid var(--line);border-radius:8px">
          <table><thead><tr><th>检验项</th><th>结果值</th><th>判定</th><th>检验员</th><th>时间</th></tr></thead>
          <tbody>${rounds[r].map(h => `
            <tr>
              <td>${esc(h.itemName)}</td>
              <td class="strong">${esc(h.value)}</td>
              <td>${h.qualified ? '<span class="tag tag-PASS">合格</span>' : '<span class="tag tag-FAIL">不合格</span>'}</td>
              <td>${esc(h.inspectorName)}</td>
              <td class="muted">${fmt(h.ts)}</td>
            </tr>`).join('')}</tbody></table>
        </div>
      </div>`).join('');

    openModal({
      lg: true,
      title: `检验记录 · ${s.code}（${b.batchNo}）`,
      body: `<div style="margin-bottom:12px">当前状态：${sampleTag(s.status)}
             ${s.finalFailReason ? `<span class="banner banner-danger" style="display:inline-flex;margin-left:8px">${esc(s.finalFailReason)}</span>` : ''}</div>
             ${body || '<div class="empty">该样本暂无检验记录</div>'}`
    });
  }

  /* ================================================================
   * 弹窗：录入检验结果
   * ================================================================ */
  function openInspection(sampleId) {
    const s = S.getSample(sampleId);
    if (!s || !can('inspection.save')) return;
    const b = S.getBatch(s.batchId);
    if (s.status !== 'PENDING' && s.status !== 'RETEST') { toast('warning', '无法录入', '该样本当前状态不允许录入'); return; }
    if (s.status === 'RETEST' && !s.awaitingRetestRound) { toast('warning', '请先发起复测', '复测需先登记并开放新一轮录入'); return; }

    const round = s.awaitingRetestRound || 1;
    const fields = D.INSPECTION_ITEMS.map(item => {
      if (item.type === 'num') {
        return `<div class="form-field item-card">
          <label class="item-name">${esc(item.name)}
            <span class="item-spec">标准区间 ${item.min} ~ ${item.max} ${esc(item.unit)}</span></label>
          <input name="${item.key}" type="number" step="0.01" placeholder="录入实测数值" required>
        </div>`;
      }
      return `<div class="form-field item-card is-qual">
        <label class="item-name">${esc(item.name)}</label>
        <div class="seg">
          <label><input type="radio" name="${item.key}" value="合格" data-v="合格" required><span>合格</span></label>
          <label><input type="radio" name="${item.key}" value="不合格" data-v="不合格"><span>不合格</span></label>
        </div>
      </div>`;
    }).join('');

    openModal({
      title: `录入检验结果 · ${s.code}`,
      context: { kind: 'inspect', id: s.id, batchId: s.batchId, rev: b.rev || 1 },
      body: `
        <div class="banner banner-info">批次 <b class="mono">${esc(b.batchNo)}</b>（${esc(b.product)}）·
          ${round > 1 ? `第 ${round} 轮复测录入` : '首轮检验'}。任一项不合格，样本将自动转入待复测。</div>
        <form id="inspectForm" data-form="save-inspection" data-sample-id="${s.id}">
          <div class="item-grid">${fields}</div>
        </form>`,
      footer: `<button class="btn btn-outline" data-close-modal type="button">取消</button>
               <button class="btn btn-primary" type="submit" form="inspectForm">提交检验结果</button>`
    });
  }

  /* ================================================================
   * 弹窗：放行/处置决定
   * ================================================================ */
  function openDecision(batchId) {
    const b = S.getBatch(batchId);
    if (!b || !can('decision.submit')) return;
    if (b.status !== 'PENDING_REVIEW' && b.status !== 'QUARANTINED') {
      toast('warning', '当前状态不可审批', `批次为「${S.BATCH_STATUS[b.status].name}」`);
      return;
    }
    const ev = S.evaluateRelease(batchId);

    const opts = Object.values(D.DECISION_TYPES).map(t => {
      const disabled = t.key === 'RELEASE' && !ev.canRelease;
      return `
        <label class="check-row ${disabled ? 'fail' : 'pass'}" style="cursor:${disabled ? 'not-allowed' : 'pointer'}">
          <input type="radio" name="decisionType" value="${t.key}" ${disabled ? 'disabled' : ''} style="margin-top:3px">
          <div>
            <div class="check-text check-label">${t.name}${disabled ? ' 🔒' : ''}</div>
            <div class="check-detail">${esc(t.note)}${disabled ? ' 拦截原因：' + esc(ev.reasons.join('；')) : ''}</div>
          </div>
        </label>`;
    }).join('');

    const expectedRev = b.rev || 1;
    openModal({
      title: `放行审批 · ${b.batchNo}`,
      context: { kind: 'decision', id: b.id, rev: expectedRev },
      body: `
        ${ev.canRelease
          ? `<div class="banner banner-success">✅ 四项放行条件全部满足，可以放行。</div>`
          : `<div class="banner banner-danger">⛔ 放行条件不满足，<b>“放行”已被系统锁定</b>，请选择隔离 / 返工 / 拒收并说明依据。</div>`}
        <div class="banner banner-info" style="margin-bottom:12px">
          本决定基于批次数据 <b class="mono">v${expectedRev}</b>（状态「${S.BATCH_STATUS[b.status].name}」）。
          提交时系统将按当前数据重新复核；若其他页签在此期间改动了该批次，本次提交会被判定为冲突。
        </div>
        <form id="decisionForm" data-form="submit-decision" data-batch-id="${b.id}" data-expected-rev="${expectedRev}">
          <input type="hidden" name="expectedRev" value="${expectedRev}">
          <div class="check-list" style="margin-bottom:14px">${opts}</div>
          <div class="form-field">
            <label>决定依据 / 处置说明 *</label>
            <textarea name="note" rows="3" required minlength="4" placeholder="例如：全项检验合格，无菌屏障完整，同意放行；或不合格现象、隔离/返工原因"></textarea>
            <span class="hint">将连同操作者与请求标识一并写入审计记录，提交后不可更改</span>
          </div>
        </form>`,
      footer: `<button class="btn btn-outline" data-close-modal type="button">取消</button>
               <button class="btn btn-primary" type="submit" form="decisionForm">提交决定</button>`
    });
  }

  /* ================================================================
   * 弹窗：返工补样
   * ================================================================ */
  function openAddSamples(batchId) {
    const b = S.getBatch(batchId);
    if (!b || !can('sample.add')) return;
    openModal({
      title: `返工后补取样 · ${b.batchNo}`,
      body: `
        <div class="banner banner-warning">⚠ 批次处于返工中，原不合格样本已作废并保留检验历史；补样检验通过后批次重新进入待审批。</div>
        <form id="addSamplesForm" data-form="add-samples" data-batch-id="${b.id}" class="form-grid">
          <div class="form-field full">
            <label>补取样数量 *</label>
            <input name="count" type="number" min="1" max="10" step="1" value="2" required>
            <span class="hint">1~10 个，生成后批次自动回到「待检」</span>
          </div>
        </form>`,
      footer: `<button class="btn btn-outline" data-close-modal type="button">取消</button>
               <button class="btn btn-primary" type="submit" form="addSamplesForm">生成补样</button>`
    });
  }

  /* ================================================================
   * 弹窗：产线维护（质量管理员）
   * ================================================================ */
  function openLines() {
    if (!can('line.manage')) return;
    const rows = S.getState().lines.map(l => `
      <tr>
        <td class="mono">${esc(l.code)}</td>
        <td>${esc(l.name)}<div class="cell-sub">${esc(l.product)}</div></td>
        <td>${l.active ? '<span class="tag tag-PASS">启用</span>' : '<span class="tag tag-VOID">停用</span>'}</td>
        <td style="text-align:right">
          ${l.active
            ? `<button class="btn btn-outline btn-xs" data-act="toggle-line" data-id="${l.id}" data-active="0">停用</button>`
            : `<button class="btn btn-success btn-xs" data-act="toggle-line" data-id="${l.id}" data-active="1">启用</button>`}
        </td>
      </tr>`).join('');
    openModal({
      title: '产线维护',
      body: `<div class="table-wrap"><table>
        <thead><tr><th>产线编号</th><th>名称 / 产品</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`,
      footer: false
    });
  }

  /* ================================================================
   * 表单提交（事件委托）
   * ================================================================ */
  function formDataToResults(form) {
    const results = {};
    D.INSPECTION_ITEMS.forEach(item => {
      if (item.type === 'num') {
        results[item.key] = form.elements[item.key].value;
      } else {
        const checked = form.querySelector(`input[name="${item.key}"]:checked`);
        results[item.key] = checked ? checked.value : '';
      }
    });
    return results;
  }

  document.addEventListener('submit', e => {
    const form = e.target;
    const kind = form.dataset.form;
    if (!kind) return;
    e.preventDefault();

    if (kind === 'create-batch') {
      const r = runOp('登记批次', () => S.createBatch({
        lineId: form.elements.lineId.value,
        product: form.elements.product.value,
        quantity: form.elements.quantity.value,
        sampleCount: form.elements.sampleCount.value,
        standard: form.elements.standard.value
      }, user));
      if (r) { closeModal(); openBatchDetail(r.batch.id); route = 'queue'; location.hash = '#/queue'; render(); }
    }

    if (kind === 'save-inspection') {
      const sampleId = form.dataset.sampleId;
      const r = runOp('检验结果录入', () => S.saveInspection(
        { sampleId, results: formDataToResults(form) }, user));
      if (r) { closeModal(); render(); }
    }

    if (kind === 'submit-decision') {
      const batchId = form.dataset.batchId;
      const picked = form.querySelector('input[name="decisionType"]:checked');
      if (!picked) { toast('warning', '请选择决定类型', '放行 / 隔离 / 返工 / 拒收 四选一'); return; }
      const expectedRev = Number(form.dataset.expectedRev);
      // 提交前再按内存中已被 storage 事件同步的最新数据复核一次版本
      const current = S.getBatch(batchId);
      if (current && (current.rev || 1) !== expectedRev) {
        toast('warning', '数据版本冲突',
          `该弹窗依据 v${expectedRev}，批次已更新到 v${current.rev || 1}（当前「${S.BATCH_STATUS[current.status].name}」），请按最新数据重新打开决定弹窗。`);
        markModalStale(`数据已更新到 v${current.rev || 1}，本弹窗依据的 v${expectedRev} 已过期。`);
        return;
      }
      const r = runOp('提交决定', () => S.submitDecision(
        { batchId, type: picked.value, note: form.elements.note.value, expectedRev }, user));
      if (r) {
        closeModal();
        if (route === 'approval') render();
        else { route = 'approval'; location.hash = '#/approval'; render(); }
      }
    }

    if (kind === 'add-samples') {
      const batchId = form.dataset.batchId;
      const r = runOp('补取样', () => S.addSamples(
        { batchId, count: form.elements.count.value }, user));
      if (r) { closeModal(); openBatchDetail(batchId); render(); }
    }
  });

  /* ================================================================
   * 点击动作（事件委托）
   * ================================================================ */
  document.addEventListener('click', e => {
    // 弹窗背景/关闭
    if (e.target.matches('[data-close-modal]') || e.target.classList.contains('modal-mask')) {
      closeModal();
      return;
    }
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const id = actEl.dataset.id;

    switch (act) {
      case 'nav': break;
      case 'goto':
        route = actEl.dataset.route; location.hash = '#/' + route; render(); break;
      case 'queue-filter':
        queueFilter = actEl.dataset.filter; renderQueue(); break;
      case 'audit-filter':
        auditFilter = actEl.dataset.filter; renderAudit(); break;
      case 'goto-queue-filter':
        queueFilter = actEl.dataset.filter || 'ALL';
        route = 'queue'; location.hash = '#/queue'; render(); break;
      case 'create-batch': openCreateBatch(); break;
      case 'open-batch': openBatchDetail(id); break;
      case 'sample-history': openSampleHistory(id); break;
      case 'inspect': openInspection(id); break;
      case 'retest': {
        const r = runOp('发起复测', () => S.requestRetest(id, user));
        if (r) { closeModal(); openInspection(id); render(); }
        break;
      }
      case 'decide': openDecision(id); break;
      case 'add-samples': openAddSamples(id); break;
      case 'manage-lines': openLines(); break;
      case 'toggle-line': {
        const r = runOp('产线状态维护', () => S.setLineActive(
          actEl.dataset.id, actEl.dataset.active === '1', user));
        if (r) openLines();
        break;
      }
      case 'verify-audit': {
        const v = S.verifyAudit();
        if (v.ok) toast('success', '审计链校验通过', `共 ${v.total} 条记录，哈希链完整。`);
        else toast('error', '审计链已断裂', v.error);
        renderAudit();
        break;
      }
      case 'reset-demo':
        openModal({
          title: '重置演示数据',
          body: `<div class="banner banner-warning">⚠ 将清空当前全部批次、检验、决定与审计记录，并重新生成内置演示数据。此操作本身需要质量管理员权限。</div>`,
          footer: `<button class="btn btn-outline" data-close-modal type="button">取消</button>
                   <button class="btn btn-danger" id="confirmReset" type="button">确认重置</button>`
        });
        $('#confirmReset').onclick = () => {
          const r = runOp('重置演示数据', () => { S.resetState(user); S.seedDemoData(); return { requestId: null }; });
          if (r) { closeModal(); queueFilter = 'ALL'; auditFilter = 'ALL'; render(); }
        };
        break;
    }
  });

  /* 导航（单独委托，阻止行内冒泡问题） */
  document.getElementById('nav').addEventListener('click', e => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    route = item.dataset.route;
    location.hash = '#/' + route;
    render();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  /* ---------------- 用户切换 ---------------- */
  const userSelect = $('#userSelect');
  userSelect.innerHTML = D.USERS.map(u =>
    `<option value="${u.id}" ${u.id === user.id ? 'selected' : ''}>${esc(u.name)}（${D.ROLES[u.role].name}）</option>`).join('');
  userSelect.addEventListener('change', () => {
    user = D.USERS.find(u => u.id === userSelect.value);
    sessionStorage.setItem(SESSION_KEY, user.id);
    closeModal();
    $('#userName').textContent = user.name;
    $('#userRole').textContent = D.ROLES[user.role].name;
    render();
    toast('success', '已切换登录角色', `${user.name} · ${D.ROLES[user.role].name}`);
  });

  /* ---------------- 跨页签实时同步 ----------------
   * 其他页签写入后（storage 事件由领域层监听并回调）：
   *  - 审批列表/队列/总览/审计立即按最新数据重渲染；
   *  - 打开中的决定弹窗若批次 rev 已变化，置灰并提示冲突，必须按最新数据重开；
   *  - 批次详情/检验录入等弹窗直接重开为最新内容（录入中断会关闭，避免盲写）。
   */
  S.onExternalChange((info) => {
    // 其他页签写入了无法解析/结构损坏的数据：显示恢复页，不接受该状态
    if (info && info.corrupt) {
      toast('error', '检测到损坏的存储数据', (info.error && info.error.message) || '存储数据损坏，写操作已被阻止');
      showCorruptScreen(info.error);
      return;
    }
    if (info && info.reset) {
      closeModal();
      toast('warning', '数据已被其他页签重置', '当前视图已切换为空库状态');
    }
    refreshChrome();
    render();

    const ctx = activeModal;
    if (!ctx) return;
    if (ctx.kind === 'decision') {
      const fresh = S.getBatch(ctx.id);
      if (!fresh) { closeModal(); return; }
      if ((fresh.rev || 1) !== ctx.rev) {
        const terminal = S.TERMINAL_STATUS.includes(fresh.status);
        markModalStale(terminal
          ? `批次已被其他页签决定为「${S.BATCH_STATUS[fresh.status].name}」，本决定不能再提交。`
          : `批次数据已从 v${ctx.rev} 更新到 v${fresh.rev || 1}（当前「${S.BATCH_STATUS[fresh.status].name}」），请按最新检验结果重新复核。`);
      }
    } else if (ctx.kind === 'inspect') {
      const fresh = S.getBatch(ctx.batchId);
      if (!fresh || (fresh.rev || 1) !== ctx.rev || S.TERMINAL_STATUS.includes(fresh.status)) {
        markModalStale('该样本/批次刚被其他页签更新，为避免覆盖他人录入，本表单已关闭。请重新打开。');
      }
    } else if (ctx.kind === 'batch') {
      const fresh = S.getBatch(ctx.id);
      if (fresh && (fresh.rev || 1) !== ctx.rev) openBatchDetail(ctx.id); // 详情弹窗无感刷新
    }
  });

  // 弹窗内“按最新数据重新打开”按钮
  document.addEventListener('click', e => {
    if (e.target.matches('[data-act="close-and-refresh"]')) {
      const ctx = activeModal;
      closeModal();
      if (ctx && ctx.kind === 'decision') openDecision(ctx.id);
      else render();
    }
  });

  /* ---------------- 存储损坏恢复页 ---------------- */
  function showCorruptScreen(err) {
    view.innerHTML = `
      <div class="card" style="max-width:720px;margin:24px auto;border-color:#f2c3bd">
        <div class="banner banner-danger" style="margin-bottom:14px">
          ⛔ <div><b>持久化数据已损坏，系统已阻止读写以防数据丢失。</b><br>
          损坏详情：${esc(err && err.message || '未知错误')}</div>
        </div>
        <div class="kvline" style="line-height:1.8">
          • 损坏的原始数据保留在浏览器存储键 <span class="mono">sr_system_state_v1.corrupt-backup</span>，可导出取证；<br>
          • 由质量管理员确认后可执行“备份并恢复为空库”；普通角色请联系质量管理员处理；<br>
          • 未恢复前，任何批次登记、检验录入、放行决定等写操作都会被拒绝并报 STATE_CORRUPT。
        </div>
        <div style="margin-top:16px;display:flex;gap:10px">
          ${can('data.reset')
            ? `<button class="btn btn-danger" id="corruptForceReset">备份损坏数据并恢复空库</button>`
            : '<span class="muted">当前角色无恢复权限，请以质量管理员身份重新打开。</span>'}
          <button class="btn btn-outline" id="corruptRetry">重新检测</button>
        </div>
      </div>`;
    const btn = document.querySelector('#corruptForceReset');
    if (btn) btn.addEventListener('click', () => {
      const r = runOp('恢复', () => S.forceReset(user));
      if (r) { S.seedDemoData(); location.hash = '#/dashboard'; render(); }
    });
    document.querySelector('#corruptRetry').addEventListener('click', () => {
      if (!S.getLoadError()) { location.hash = '#/dashboard'; render(); }
      else toast('error', '存储仍处于损坏状态', S.getLoadError().message);
    });
  }

  (function boot() {
    $('#userName').textContent = user.name;
    $('#userRole').textContent = D.ROLES[user.role].name;
    if (!PAGE_META[route]) route = 'dashboard';
    location.hash = '#/' + route;

    // 启动即损坏：显式报错页，绝不在损坏存储之上静默建空库或自动灌演示数据
    const health = S.storageHealth();
    if (!health.ok) {
      render();
      showCorruptScreen(S.getLoadError());
      return;
    }
    // 空系统自动灌入演示数据
    if (S.getState().audit.length === 0 && S.getState().batches.length === 0) {
      S.seedDemoData();
    }
    render();
  })();

  window.addEventListener('hashchange', () => {
    route = (location.hash || '#/dashboard').replace('#/', '');
    if (!PAGE_META[route]) route = 'dashboard';
    closeModal();
    render();
  });
})();
