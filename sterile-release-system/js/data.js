/* 静态数据：用户 / 角色 / 检验项 / 产线 / 产品 —— UMD，浏览器挂 window，Node 可 require */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = data;
  } else {
    root.SRData = data;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 角色与权限
  const ROLES = {
    OPERATOR:   { key: 'OPERATOR',   name: '操作员' },
    INSPECTOR:  { key: 'INSPECTOR',  name: '检验员' },
    APPROVER:   { key: 'APPROVER',   name: '审批员' },
    QA_MANAGER: { key: 'QA_MANAGER', name: '质量管理员' }
  };

  const USERS = [
    { id: 'U01', username: 'op01',    name: '王建国', role: 'OPERATOR'   },
    { id: 'U02', username: 'insp01',  name: '李晓敏', role: 'INSPECTOR'  },
    { id: 'U03', username: 'appr01',  name: '陈志远', role: 'APPROVER'   },
    { id: 'U04', username: 'qa01',    name: '赵雅琴', role: 'QA_MANAGER' }
  ];

  // 检验项：定性(qual) 记 合格/不合格；定量(num) 记数值，按上下限自动判定
  const INSPECTION_ITEMS = [
    { key: 'sealStrength', name: '密封强度',   unit: 'N/15mm', type: 'num',  min: 1.5, max: 3.0 },
    { key: 'visual',       name: '外观检验',   unit: '',       type: 'qual' },
    { key: 'barrier',      name: '无菌屏障完整性', unit: '',    type: 'qual' },
    { key: 'label',        name: '标签信息',   unit: '',       type: 'qual' }
  ];

  // 产线（启用作业后才能登记批次）
  const LINES = [
    { id: 'L01', code: 'LINE-A1', name: 'A1 热成型包装线', product: '无菌注射器 10mL',   active: true },
    { id: 'L02', code: 'LINE-A2', name: 'A2 热成型包装线', product: '静脉留置针 22G',    active: true },
    { id: 'L03', code: 'LINE-B1', name: 'B1 封口包装线',   product: '手术刀片 11#',      active: true },
    { id: 'L04', code: 'LINE-B2', name: 'B2 封口包装线',   product: '无菌敷贴 7x9cm',    active: false }
  ];

  const PRODUCTS = [
    '无菌注射器 10mL', '静脉留置针 22G', '手术刀片 11#', '无菌敷贴 7x9cm'
  ];

  // 放行决定动作
  const DECISION_TYPES = {
    RELEASE:    { key: 'RELEASE',    name: '放行',   tone: 'success',
                  note: '全部检验合格，允许该批次放行出厂。' },
    QUARANTINE: { key: 'QUARANTINE', name: '隔离',   tone: 'warning',
                  note: '批次存在质量风险，移入隔离区挂起，等待调查处置。' },
    REWORK:     { key: 'REWORK',     name: '返工',   tone: 'neutral',
                  note: '退回产线返工；返工后重新取样检验，通过后再次提交审批。' },
    REJECT:     { key: 'REJECT',     name: '拒收/报废', tone: 'danger',
                  note: '批次不符合无菌包装要求，判定拒收并报废处理。' }
  };

  return { ROLES, USERS, INSPECTION_ITEMS, LINES, PRODUCTS, DECISION_TYPES };
});
