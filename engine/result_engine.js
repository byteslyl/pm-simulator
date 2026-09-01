/**
 * result_engine.js - 结果规则引擎（v0.1）
 *
 * 职责：实现 RR-1 到 RR-6 六条确定性结果规则，
 * 计算事故判定、止血能力、延期损失、用户流失、竞品影响、综合汇总。
 *
 * 结果规则清单：
 *   RR-1: 事故判定（load = 3680 × 灰度比例 vs 2500）
 *   RR-2: 止血能力判定（F-12 是否获取 + D1 选择）
 *   RR-3: 延期损失计算（F-08 是否获取）
 *   RR-4: 用户流失计算（F-17 是否获取）
 *   RR-5: 竞品影响（F-14 是否获取）
 *   RR-6: 综合评分汇总
 */

'use strict';

const scenarioData = require('./scenario_data.json');

// 从 scenario_data.json 提取结果规则定义
const RESULT_RULES = scenarioData.result_rules || [];

// 内部参数：实际峰值 3680（学生不可见，复盘揭示）
const ACTUAL_PEAK_QPS = 3680;

// 事故触发阈值
const INCIDENT_THRESHOLD = 2500;

// 止血时间阈值（分钟）
const HEMOSTASIS_THRESHOLD = 15;

// 止血实际时间（分钟）
const ACTUAL_HEMOSTASIS_TIME = 5;

// 用户流失率（F-17）
const USER_LOSS_RATE = 0.30;

// 延期直接损失（万元）
const DELAY_DIRECT_LOSS = 80;

// 延期品牌信誉损失（万元，F-08 揭示）
const DELAY_BRAND_LOSS = 30;

/**
 * 从决策选项解析灰度比例
 * @param {string} option
 * @returns {number} 0-1 之间，全量=1
 */
function parseRatio(option) {
  if (!option) return 1;
  if (option === 'Go全量' || option === 'Go') return 1;
  const m = option.match(/(\d+)%/);
  if (m) return parseInt(m[1], 10) / 100;
  if (option.indexOf('5%') >= 0) return 0.05;
  if (option.indexOf('20%') >= 0) return 0.2;
  if (option.indexOf('50%') >= 0) return 0.5;
  return 1;
}

/**
 * RR-1: 事故判定
 * 逻辑：load = 3680 × 灰度比例；if load > 2500 then 事故触发
 * @param {string} d2Option - D2 决策选项
 * @returns {{triggered:boolean, load:number, threshold:number, detail:string, ratio:number}}
 */
function rr1Incident(d2Option) {
  const ratio = parseRatio(d2Option);
  const load = Math.round(ACTUAL_PEAK_QPS * ratio);
  const triggered = load > INCIDENT_THRESHOLD;

  let detail = '';
  if (d2Option === 'Go全量' || d2Option === 'Go') {
    detail = `load=${ACTUAL_PEAK_QPS} > ${INCIDENT_THRESHOLD} → 事故触发`;
  } else if (d2Option.indexOf('5%') >= 0) {
    detail = `load=${load} < ${INCIDENT_THRESHOLD} → 安全`;
  } else if (d2Option.indexOf('20%') >= 0) {
    detail = `load=${load} < ${INCIDENT_THRESHOLD} → 安全`;
  } else if (d2Option.indexOf('50%') >= 0) {
    // QA 预判偏差 +15% 后 load = 2116 仍 < 2500
    const adjustedLoad = Math.round(load * 1.15);
    detail = `load=${load} < ${INCIDENT_THRESHOLD} → 安全（QA预判偏差+15%后 load=${adjustedLoad} 仍<${INCIDENT_THRESHOLD}，结论正确）`;
  } else if (d2Option.indexOf('Delay') >= 0) {
    detail = 'Delay 延期，不触发上线事故';
  } else {
    detail = `load=${load} vs ${INCIDENT_THRESHOLD}`;
  }

  return {
    rule: 'RR-1',
    name: '事故判定',
    triggered,
    load,
    threshold: INCIDENT_THRESHOLD,
    ratio,
    actualPeakQPS: ACTUAL_PEAK_QPS,
    studentVisibleParam: '预估3200，偏差±30%',
    detail,
  };
}

/**
 * RR-2: 止血能力判定
 * 逻辑：if F-12_acquired AND contingency includes '监控哨兵' then rollback_time=5min < 15min → C-04满足
 *       if F-12_not_acquired then blind_spot → C-04违反
 *       if D1_A_selected then 无准备时间，C-04违反
 * @param {boolean} f12Acquired
 * @param {string} d1Choice
 * @param {object} d2Decision
 * @returns {{satisfied:boolean, rollbackTime:number|null, detail:string, blindSpot:boolean}}
 */
function rr2Rollback(f12Acquired, d1Choice, d2Decision) {
  d2Decision = d2Decision || {};
  const contingency = d2Decision.contingency || d2Decision.contingency_plan || [];

  // D1 选 A 连夜修复：无准备时间
  if (d1Choice && d1Choice.indexOf('A') >= 0) {
    return {
      rule: 'RR-2',
      name: '止血能力判定',
      satisfied: false,
      rollbackTime: ACTUAL_HEMOSTASIS_TIME,
      blindSpot: false,
      detail: `D1 选择 A_连夜修复，无准备时间配置预案，即使知道 ${ACTUAL_HEMOSTASIS_TIME} 分钟止血也来不及，C-04 违反`,
      d1Choice,
    };
  }

  // 未获取 F-12：应急盲区
  if (!f12Acquired) {
    return {
      rule: 'RR-2',
      name: '止血能力判定',
      satisfied: false,
      rollbackTime: null,
      blindSpot: true,
      detail: '未获取 F-12 止血能力事实，回滚能力未知，标注应急盲区，C-04 违反',
      f12Acquired,
    };
  }

  // F-12 已获取：止血 5 分钟 < 15 分钟
  const hasMonitorSentinel = Array.isArray(contingency)
    ? contingency.some((c) => c.indexOf('监控') >= 0 || c.indexOf('哨兵') >= 0)
    : typeof contingency === 'string' && (contingency.indexOf('监控') >= 0 || contingency.indexOf('哨兵') >= 0);

  return {
    rule: 'RR-2',
    name: '止血能力判定',
    satisfied: true,
    rollbackTime: ACTUAL_HEMOSTASIS_TIME,
    blindSpot: false,
    hasMonitorSentinel,
    detail: `F-12 已获取，新引擎回滚 ${ACTUAL_HEMOSTASIS_TIME} 分钟止血 < ${HEMOSTASIS_THRESHOLD} 分钟，C-04 满足${hasMonitorSentinel ? '（含监控哨兵预案）' : ''}`,
    f12Acquired,
  };
}

/**
 * RR-3: 延期损失计算
 * 逻辑：if decision.option == 'Delay_24h' then loss = 80万(F-09) + 30万品牌(F-08 if acquired else unknown)
 * @param {string} d2Option
 * @param {boolean} f08Acquired
 * @returns {{applicable:boolean, directLoss:number, brandLoss:number|null, totalLoss:number|null, detail:string, blindSpot:boolean}}
 */
function rr3Loss(d2Option, f08Acquired) {
  const isDelay = d2Option && d2Option.indexOf('Delay') >= 0;

  if (!isDelay) {
    return {
      rule: 'RR-3',
      name: '延期损失计算',
      applicable: false,
      directLoss: 0,
      brandLoss: 0,
      totalLoss: 0,
      blindSpot: false,
      detail: `决策选项 "${d2Option}" 非 Delay，不适用延期损失计算`,
    };
  }

  const directLoss = DELAY_DIRECT_LOSS;
  const brandLoss = f08Acquired ? DELAY_BRAND_LOSS : null;
  const totalLoss = f08Acquired ? directLoss + brandLoss : null;

  return {
    rule: 'RR-3',
    name: '延期损失计算',
    applicable: true,
    directLoss,
    brandLoss,
    totalLoss,
    blindSpot: !f08Acquired,
    detail: f08Acquired
      ? `总损失 ${totalLoss} 万（直接 ${directLoss} 万 + 品牌 ${brandLoss} 万），学生可完整评估`
      : `学生只看到 ${directLoss} 万直接损失，复盘揭示额外 ${DELAY_BRAND_LOSS} 万品牌损失，实际总损失 ${directLoss + DELAY_BRAND_LOSS} 万`,
    f08Acquired,
  };
}

/**
 * RR-4: 用户流失计算
 * 逻辑：if 事故触发 AND decision.option in ['Go全量'] then user_loss = affected_users × 30%(F-17)
 * @param {boolean} incidentTriggered - 是否事故触发
 * @param {string} d2Option
 * @param {boolean} f17Acquired
 * @returns {{applicable:boolean, lossRate:number, detail:string, blindSpot:boolean}}
 */
function rr4UserLoss(incidentTriggered, d2Option, f17Acquired) {
  const isGoFull = d2Option === 'Go全量' || d2Option === 'Go' || (d2Option && d2Option.indexOf('全量') >= 0);

  if (!incidentTriggered || !isGoFull) {
    return {
      rule: 'RR-4',
      name: '用户流失计算',
      applicable: false,
      lossRate: 0,
      detail: incidentTriggered
        ? '事故未触发或非全量上线，不计算用户流失'
        : `决策选项 "${d2Option}" 未触发事故，无需计算用户流失`,
      f17Acquired,
    };
  }

  // Go 全量且事故触发：30% 用户永久流失
  return {
    rule: 'RR-4',
    name: '用户流失计算',
    applicable: true,
    lossRate: USER_LOSS_RATE,
    detail: f17Acquired
      ? `全量用户受影响，${USER_LOSS_RATE * 100}% 永久流失（F-17 已获取），学生知道流失率`
      : `全量用户受影响，${USER_LOSS_RATE * 100}% 永久流失（F-17 未获取），学生不知道流失率，复盘揭示长期影响`,
    blindSpot: !f17Acquired,
    f17Acquired,
  };
}

/**
 * RR-5: 竞品影响
 * 逻辑：if decision.option == 'Delay_24h' AND F-14_acquired then strategic_pressure = 'high'
 *       if F-14_not_acquired then blind_spot
 * @param {string} d2Option
 * @param {boolean} f14Acquired
 * @returns {{applicable:boolean, strategicPressure:string, detail:string, blindSpot:boolean}}
 */
function rr5Strategic(d2Option, f14Acquired) {
  const isDelay = d2Option && d2Option.indexOf('Delay') >= 0;

  if (!isDelay) {
    return {
      rule: 'RR-5',
      name: '竞品影响',
      applicable: false,
      strategicPressure: 'none',
      detail: `决策选项 "${d2Option}" 非 Delay，竞品影响不作为关键因素`,
      f14Acquired,
    };
  }

  // Delay 决策：检查是否获取 F-14
  return {
    rule: 'RR-5',
    name: '竞品影响',
    applicable: true,
    strategicPressure: f14Acquired ? 'high' : 'unknown',
    blindSpot: !f14Acquired,
    detail: f14Acquired
      ? '学生知道竞品下周上线，Delay 决策有战略代价意识'
      : '学生不知道竞品压力，Delay 决策缺少战略维度',
    f14Acquired,
  };
}

/**
 * RR-6: 综合评分汇总
 * 逻辑：combine(rule_engine_score × 0.7, llm_score × 0.3) for decision_quality
 * 此处在 result_engine 中汇总各 RR 结果，最终评分由 scoring_engine 计算
 * @param {object} rrResults - RR-1 到 RR-5 的结果
 * @returns {{summary:object, detail:string}}
 */
function rr6Summary(rrResults) {
  const incident = rrResults.rr1;
  const rollback = rrResults.rr2;
  const loss = rrResults.rr3;
  const userLoss = rrResults.rr4;
  const strategic = rrResults.rr5;

  // 汇总风险等级
  let riskLevel = '低';
  const risks = [];

  if (incident.triggered) {
    risks.push('事故触发');
    riskLevel = '高';
  }
  if (!rollback.satisfied) {
    risks.push(rollback.blindSpot ? '应急盲区' : '止血能力不足');
    riskLevel = '高';
  }
  if (loss.applicable && loss.totalLoss >= 100) {
    risks.push(`延期损失 ${loss.totalLoss} 万`);
    if (riskLevel !== '高') riskLevel = '中';
  }
  if (userLoss.applicable) {
    risks.push(`用户流失 ${userLoss.lossRate * 100}%`);
    riskLevel = '高';
  }
  if (strategic.applicable && strategic.blindSpot) {
    risks.push('战略盲区（未获取竞品情报）');
    if (riskLevel === '低') riskLevel = '中';
  }

  // 盲区数量
  const blindSpots = [loss.blindSpot, userLoss.blindSpot, strategic.blindSpot].filter((b) => b === true).length;

  const summary = {
    riskLevel,
    riskCount: risks.length,
    risks,
    blindSpotCount: blindSpots,
    incidentTriggered: incident.triggered,
    rollbackSatisfied: rollback.satisfied,
    totalLoss: loss.totalLoss,
    userLossRate: userLoss.lossRate,
    strategicPressure: strategic.strategicPressure,
  };

  let detail = `综合结果：风险等级 ${riskLevel}`;
  if (risks.length > 0) {
    detail += `，风险项：${risks.join('、')}`;
  }
  if (blindSpots > 0) {
    detail += `，盲区数：${blindSpots}`;
  }

  return {
    rule: 'RR-6',
    name: '综合评分汇总',
    summary,
    detail,
  };
}

/**
 * 主入口：计算全部结果
 * @param {object|string} d2Decision - D2 决策对象或选项字符串
 * @param {string[]} acquiredFacts - 已获取事实 id 数组
 * @param {string} d1Choice - D1 选择
 * @returns {{incident:object, rollback:object, loss:object, user_loss:object, strategic:object, summary:object}}
 */
function calculateResults(d2Decision, acquiredFacts, d1Choice) {
  acquiredFacts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
  const option = typeof d2Decision === 'string'
    ? d2Decision
    : (d2Decision && (d2Decision.option || d2Decision.d2_option)) || '';

  const f12Acquired = acquiredFacts.indexOf('F-12') >= 0;
  const f08Acquired = acquiredFacts.indexOf('F-08') >= 0;
  const f17Acquired = acquiredFacts.indexOf('F-17') >= 0;
  const f14Acquired = acquiredFacts.indexOf('F-14') >= 0;

  // RR-1: 事故判定
  const incident = rr1Incident(option);

  // RR-2: 止血能力判定
  const rollback = rr2Rollback(f12Acquired, d1Choice, typeof d2Decision === 'object' ? d2Decision : {});

  // RR-3: 延期损失计算
  const loss = rr3Loss(option, f08Acquired);

  // RR-4: 用户流失计算
  const userLoss = rr4UserLoss(incident.triggered, option, f17Acquired);

  // RR-5: 竞品影响
  const strategic = rr5Strategic(option, f14Acquired);

  // RR-6: 综合评分汇总
  const summary = rr6Summary({
    rr1: incident,
    rr2: rollback,
    rr3: loss,
    rr4: userLoss,
    rr5: strategic,
  });

  return {
    incident,
    rollback,
    loss,
    user_loss: userLoss,
    strategic,
    summary,
  };
}

module.exports = {
  calculateResults,
  rr1Incident,
  rr2Rollback,
  rr3Loss,
  rr4UserLoss,
  rr5Strategic,
  rr6Summary,
  parseRatio,
};
