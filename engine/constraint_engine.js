/**
 * constraint_engine.js - 硬约束检查引擎（v0.1）
 *
 * 职责：检查 C-01 到 C-07 共 7 条硬约束，输出通过/违反/警告三类结果。
 *
 * 约束清单：
 *   C-01: D1 决策窗口 16h
 *   C-02: 研发资源 ≤ 3 人天
 *   C-03: 活动不可取消
 *   C-04: 事故止血时间 < 15 分钟（需 F-12 获取）
 *   C-05: P1 缺陷不可带病全量上线
 *   C-06: D2 决策须在 21:30 前提交
 *   C-07: 决策须引用至少 3 条事实证据
 */

'use strict';

const scenarioData = require('./scenario_data.json');

// 从 scenario_data.json 提取硬约束定义，便于按 id 查询
const HARD_CONSTRAINTS = scenarioData.hard_constraints || [];

/**
 * 根据 id 获取约束定义
 * @param {string} id
 * @returns {object|null}
 */
function getConstraintDef(id) {
  return HARD_CONSTRAINTS.find((c) => c.id === id) || null;
}

/**
 * 解析"今晚 21:30"语义为分钟数（以今日 17:00 为基准）
 * @param {string|number|Date} submitTime
 * @returns {number} 提交时刻的分钟偏移（17:00 = 0，21:30 = 270）
 */
function parseSubmitTimeToMinutes(submitTime) {
  // 若提交时间为 Date 对象，换算为相对 17:00 的分钟数
  if (submitTime instanceof Date) {
    const base = new Date(submitTime);
    base.setHours(17, 0, 0, 0);
    const diff = (submitTime - base) / 60000;
    return diff;
  }
  // 若为字符串如 "21:30" 或 "21:30:00"
  if (typeof submitTime === 'string') {
    const match = submitTime.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      const h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      return h * 60 + m - 17 * 60;
    }
    // 尝试 Date 解析
    const d = new Date(submitTime);
    if (!isNaN(d.getTime())) {
      const base = new Date(d);
      base.setHours(17, 0, 0, 0);
      return (d - base) / 60000;
    }
  }
  // 若为数字（视为分钟偏移）
  if (typeof submitTime === 'number') {
    return submitTime;
  }
  // 默认视为已超时
  return 9999;
}

/**
 * 从 D1 选择推导资源耗时（人时/人天）
 * 依据 scenario_data.json decision_nodes.D1.impact_on_D2.time_cost
 * @param {string} d1Choice
 * @returns {{hours:number, personDays:number, timeCostDesc:string}}
 */
function estimateD1Resource(d1Choice) {
  const d1 = scenarioData.decision_nodes && scenarioData.decision_nodes.D1;
  if (!d1 || !d1.impact_on_D2) {
    return { hours: 0, personDays: 0, timeCostDesc: '未知' };
  }
  const key = Object.keys(d1.impact_on_D2).find(
    (k) => k === d1Choice || k.indexOf(d1Choice) >= 0
  );
  const impact = key ? d1.impact_on_D2[key] : null;
  const desc = impact ? impact.time_cost || '' : '';

  // 解析 "全部16h窗口" / "8人时（研发4+QA4）" / "12人时" 等
  let hours = 0;
  let personDays = 0;

  const hourMatch = desc.match(/(\d+)\s*人时/);
  const windowMatch = desc.match(/(\d+)\s*h窗口/);
  if (hourMatch) {
    hours = parseInt(hourMatch[1], 10);
    personDays = hours / 8; // 1 人天 = 8 人时
  } else if (windowMatch) {
    hours = parseInt(windowMatch[1], 10);
    personDays = hours / 8;
  } else {
    // 无法解析时默认按 D1 选项估算
    if (d1Choice && d1Choice.indexOf('A') >= 0) {
      hours = 16; personDays = 2;
    } else if (d1Choice && d1Choice.indexOf('B') >= 0) {
      hours = 8; personDays = 1;
    } else if (d1Choice && d1Choice.indexOf('C') >= 0) {
      hours = 12; personDays = 1.5;
    }
  }

  return { hours, personDays, timeCostDesc: desc };
}

/**
 * 判断是否为带灰度/全量上线的决策（需要止血能力）
 * @param {string} option
 * @returns {boolean}
 */
function isOnlineDecision(option) {
  if (!option) return false;
  const onlinePatterns = ['Go', 'Limited', '全量', '灰度'];
  return onlinePatterns.some((p) => option.indexOf(p) >= 0);
}

/**
 * 从决策选项解析灰度比例
 * @param {string} option
 * @returns {number} 0-1 之间，全量=1
 */
function parseRatio(option) {
  if (!option) return 1;
  if (option.indexOf('全量') >= 0 || option === 'Go' || option === 'Go全量') return 1;
  const m = option.match(/(\d+)%/);
  if (m) return parseInt(m[1], 10) / 100;
  if (option.indexOf('5%') >= 0) return 0.05;
  if (option.indexOf('20%') >= 0) return 0.2;
  if (option.indexOf('50%') >= 0) return 0.5;
  return 1;
}

/**
 * 检查 C-01：D1 决策窗口 16h
 * @param {string} d1Choice
 * @returns {{passed:boolean, detail:string}}
 */
function checkC01(d1Choice) {
  const def = getConstraintDef('C-01');
  const res = estimateD1Resource(d1Choice);
  const passed = res.hours <= 16;
  return {
    passed,
    id: 'C-01',
    description: def ? def.description : 'D1 决策窗口 16h',
    detail: passed
      ? `D1 资源耗时 ${res.hours}h ≤ 16h 窗口，满足约束`
      : `D1 资源耗时 ${res.hours}h > 16h 窗口，方案不可执行`,
    consequence: def ? def.violation_consequence : '方案不可执行',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { timeCost: res.timeCostDesc, hours: res.hours },
  };
}

/**
 * 检查 C-02：研发资源不超过 3 人天
 * @param {object} decision
 * @param {string} d1Choice
 * @returns {{passed:boolean, detail:string}}
 */
function checkC02(decision, d1Choice) {
  const def = getConstraintDef('C-02');
  // 优先使用 decision.resource_usage；否则用 D1 估算
  let personDays = 0;
  let source = '';
  if (decision && typeof decision.resource_usage === 'number') {
    personDays = decision.resource_usage;
    source = 'decision.resource_usage';
  } else {
    const res = estimateD1Resource(d1Choice);
    personDays = res.personDays;
    source = 'D1 估算';
  }
  const passed = personDays <= 3;
  return {
    passed,
    id: 'C-02',
    description: def ? def.description : '研发资源不超过 3 人天',
    detail: passed
      ? `研发资源 ${personDays.toFixed(2)} 人天 ≤ 3 人天，满足约束（来源：${source}）`
      : `研发资源 ${personDays.toFixed(2)} 人天 > 3 人天，方案禁止提交；决策质量-5`,
    consequence: def ? def.violation_consequence : '方案禁止提交；决策质量-5',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { personDays, source },
  };
}

/**
 * 检查 C-03：活动不可取消
 * @param {object} decision
 * @returns {{passed:boolean, detail:string}}
 */
function checkC03(decision) {
  const def = getConstraintDef('C-03');
  const option = (decision && (decision.option || decision.d2_option)) || '';
  const passed = option !== 'cancel_activity' && option.indexOf('cancel') < 0;
  return {
    passed,
    id: 'C-03',
    description: def ? def.description : '活动不可取消',
    detail: passed
      ? `决策选项 "${option}" 未取消活动，满足约束`
      : `决策选项 "${option}" 涉及取消活动，方案不可执行`,
    consequence: def ? def.violation_consequence : '方案不可执行',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { option },
  };
}

/**
 * 检查 C-04：事故止血时间 < 15 分钟（需 F-12 获取）
 * @param {object} decision
 * @param {string[]} acquiredFacts
 * @param {string} d1Choice
 * @returns {{passed:boolean, detail:string, warning?:string}}
 */
function checkC04(decision, acquiredFacts, d1Choice) {
  const def = getConstraintDef('C-04');
  const option = (decision && (decision.option || decision.d2_option)) || '';
  const facts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
  const f12Acquired = facts.indexOf('F-12') >= 0;

  // 非上线类决策（如 Delay）不强制要求止血能力，视为通过
  if (!isOnlineDecision(option)) {
    return {
      passed: true,
      id: 'C-04',
      description: def ? def.description : '事故止血时间 < 15 分钟',
      detail: `决策选项 "${option}" 非上线类，不适用 C-04 止血约束`,
      consequence: def ? def.violation_consequence : '',
      knowledgePoint: def ? def.knowledge_point : '',
      evidence: { option, f12Acquired, applicable: false },
    };
  }

  // D1 选 A 连夜修复：无准备时间，即使知道 5 分钟也来不及配置
  if (d1Choice && d1Choice.indexOf('A') >= 0) {
    return {
      passed: false,
      id: 'C-04',
      description: def ? def.description : '事故止血时间 < 15 分钟',
      detail: 'D1 选择 A_连夜修复，无准备时间配置预案，C-04 违反',
      warning: 'D1-A 路径下即使知道止血 5 分钟也来不及配置预案',
      consequence: def ? def.violation_consequence : '方案可提交但标注"应急能力不足"；决策质量-8',
      knowledgePoint: def ? def.knowledge_point : '',
      evidence: { option, f12Acquired, d1Choice, applicable: true },
    };
  }

  // 上线类决策但未获取 F-12：应急盲区
  if (!f12Acquired) {
    return {
      passed: false,
      id: 'C-04',
      description: def ? def.description : '事故止血时间 < 15 分钟',
      detail: '上线类决策但未获取 F-12 止血能力事实，应急能力未知，C-04 违反',
      warning: '回滚能力未知，标注应急盲区，决策质量-8',
      consequence: def ? def.violation_consequence : '方案可提交但标注"应急能力不足"；决策质量-8',
      knowledgePoint: def ? def.knowledge_point : '',
      evidence: { option, f12Acquired, applicable: true },
    };
  }

  // F-12 已获取：止血 5 分钟 < 15 分钟
  return {
    passed: true,
    id: 'C-04',
    description: def ? def.description : '事故止血时间 < 15 分钟',
    detail: 'F-12 已获取，新引擎回滚 5 分钟止血 < 15 分钟，C-04 满足',
    consequence: def ? def.violation_consequence : '',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { option, f12Acquired, rollbackTime: 5, applicable: true },
  };
}

/**
 * 检查 C-05：P1 缺陷不可带病全量上线
 * @param {object} decision
 * @param {string[]} acquiredFacts
 * @returns {{passed:boolean, detail:string, warning?:string}}
 */
function checkC05(decision, acquiredFacts) {
  const def = getConstraintDef('C-05');
  const option = (decision && (decision.option || decision.d2_option)) || '';
  const facts = Array.isArray(acquiredFacts) ? acquiredFacts : [];

  // 仅 Go 全量需要检查 P1 缺陷处理
  const isGoFull = option === 'Go全量' || option === 'Go' || option.indexOf('全量') >= 0;
  if (!isGoFull) {
    return {
      passed: true,
      id: 'C-05',
      description: def ? def.description : 'P1 缺陷不可带病全量上线',
      detail: `决策选项 "${option}" 非全量上线，不触发 C-05`,
      consequence: def ? def.violation_consequence : '',
      knowledgePoint: def ? def.knowledge_point : '',
      evidence: { option, applicable: false },
    };
  }

  // Go 全量：需要 F-04 已"解决"（含 F-16 降级）
  // 场景设定中 F-04 是缺陷阈值事实，F-16 是 P1→P2 降级方案
  // 学生决策中需体现"已修复"或"已降级"
  const resolved = decision && (decision.p1_resolved === true || decision.p1_fixed === true);
  const downgraded = facts.indexOf('F-16') >= 0 && decision && decision.p1_downgraded === true;
  const f04Acquired = facts.indexOf('F-04') >= 0;

  if (resolved || downgraded) {
    return {
      passed: true,
      id: 'C-05',
      description: def ? def.description : 'P1 缺陷不可带病全量上线',
      detail: downgraded
        ? 'P1 已通过 F-16 方案降级为 P2，绕过阈值但留技术债，C-05 通过（需关注技术债）'
        : 'P1 缺陷已修复，C-05 通过',
      consequence: def ? def.violation_consequence : '',
      knowledgePoint: def ? def.knowledge_point : '',
      evidence: { option, resolved, downgraded, f04Acquired, applicable: true },
    };
  }

  // 未处理 P1 即全量上线
  return {
    passed: false,
    id: 'C-05',
    description: def ? def.description : 'P1 缺陷不可带病全量上线',
    detail: 'Go 全量方案但 P1 缺陷未修复/未降级，带病全量上线，C-05 违反',
    warning: 'Go全量方案自动标记为高风险；S2 风险 +25',
    consequence: def ? def.violation_consequence : 'Go全量方案自动标记为高风险；S2风险+25',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { option, resolved, downgraded, f04Acquired, applicable: true },
  };
}

/**
 * 检查 C-06：D2 决策须在 21:30 前提交
 * @param {string|number|Date} submitTime
 * @returns {{passed:boolean, detail:string}}
 */
function checkC06(submitTime) {
  const def = getConstraintDef('C-06');
  const minutes = parseSubmitTimeToMinutes(submitTime);
  // 21:30 相对 17:00 为 270 分钟
  const deadlineMinutes = 4.5 * 60; // 270
  const passed = minutes <= deadlineMinutes;
  // 构造可读时刻
  const totalMin = 17 * 60 + minutes;
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return {
    passed,
    id: 'C-06',
    description: def ? def.description : 'D2 决策须在 21:30 前提交',
    detail: passed
      ? `D2 提交时刻 ${timeStr} ≤ 21:30，满足约束`
      : `D2 提交时刻 ${timeStr} > 21:30，超时系统自动执行默认方案（C继续回归+Go全量）`,
    consequence: def ? def.violation_consequence : '超时系统自动执行默认方案（C继续回归+Go全量）',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { submitTime, parsedMinutes: minutes, deadline: '21:30' },
  };
}

/**
 * 检查 C-07：决策须引用至少 3 条事实证据
 * @param {object} decision
 * @param {string[]} acquiredFacts
 * @returns {{passed:boolean, detail:string, warning?:string}}
 */
function checkC07(decision, acquiredFacts) {
  const def = getConstraintDef('C-07');
  const facts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
  const cited = (decision && (decision.cited_facts || decision.citedFacts || [])) || [];
  const citedArr = Array.isArray(cited) ? cited : [];

  // 检查引用数量
  const countOk = citedArr.length >= 3;

  // 检查引用的事实是否都已获取（避免幻觉证据）
  const hallucinated = citedArr.filter((f) => facts.indexOf(f) < 0);
  const allAcquired = hallucinated.length === 0;

  const passed = countOk && allAcquired;

  let detail = '';
  if (countOk && allAcquired) {
    detail = `引用 ${citedArr.length} 条事实证据且全部已获取，C-07 满足`;
  } else if (!countOk) {
    detail = `仅引用 ${citedArr.length} 条事实证据 < 3 条，C-07 违反，决策质量-5`;
  } else if (!allAcquired) {
    detail = `引用证据中 ${hallucinated.join(',')} 未获取，存在幻觉证据，每条-10`;
  }

  const result = {
    passed,
    id: 'C-07',
    description: def ? def.description : '决策须引用至少 3 条事实证据',
    detail,
    consequence: def ? def.violation_consequence : '决策质量-5；幻觉证据-10/条',
    knowledgePoint: def ? def.knowledge_point : '',
    evidence: { citedFacts: citedArr, count: citedArr.length, hallucinated },
  };

  if (hallucinated.length > 0) {
    result.warning = `幻觉证据：${hallucinated.join(',')}，每条扣 10 分`;
  }
  return result;
}

/**
 * 主入口：检查全部 7 条硬约束
 * @param {object} decision - 学生 D2 决策对象，含 option/cited_facts/resource_usage 等
 * @param {string[]} acquiredFacts - 已获取事实 id 数组
 * @param {string} d1Choice - D1 选择（A_连夜修复/B_灰度准备/C_继续回归）
 * @param {string|number|Date} submitTime - D2 提交时间
 * @returns {{passed:object[], violated:object[], warnings:object[]}}
 */
function checkConstraints(decision, acquiredFacts, d1Choice, submitTime) {
  decision = decision || {};
  acquiredFacts = Array.isArray(acquiredFacts) ? acquiredFacts : [];

  const checks = [
    checkC01(d1Choice),
    checkC02(decision, d1Choice),
    checkC03(decision),
    checkC04(decision, acquiredFacts, d1Choice),
    checkC05(decision, acquiredFacts),
    checkC06(submitTime),
    checkC07(decision, acquiredFacts),
  ];

  const passed = checks.filter((c) => c.passed);
  const violated = checks.filter((c) => !c.passed);
  const warnings = checks.filter((c) => c.warning);

  return { passed, violated, warnings };
}

module.exports = {
  checkConstraints,
  // 导出单条检查函数便于单元测试
  checkC01,
  checkC02,
  checkC03,
  checkC04,
  checkC05,
  checkC06,
  checkC07,
  // 工具函数
  estimateD1Resource,
  parseSubmitTimeToMinutes,
  parseRatio,
  isOnlineDecision,
};
