/**
 * scoring_engine.js - 评分引擎（v0.1）
 *
 * 职责：五维评分，输出完整评分报告。
 *
 * 五个维度及权重：
 *   1. user_insight（20%，规则引擎）：按获取事实的 L0/L2/L3 分值累加
 *   2. decision_quality（25%，混合 70%规则+30%LLM）：规则引擎+LLM 辅助
 *   3. communication（20%，规则引擎）：访谈角色数+信任变化+交叉验证
 *   4. business_balance（20%，规则引擎）：基于 S2/S3 状态+F-08/F-14 加分
 *   5. growth_reflection（15%，LLM）：LLM 评估复盘深度
 *
 * sessionData 包含：acquiredFacts, d1Choice, d2Decision, interviewLog,
 *                   constraintResults, stateResults, relationshipStates
 *
 * LLM 评分注入接口：
 *   - sessionData.llmDecisionScore (0-100): LLM 对决策推理质量的评分，用于 decision_quality 维度的 30% 权重
 *   - sessionData.llmReflectionScore (0-100): LLM 对学生复盘文字的评分，用于 growth_reflection 维度
 *   - sessionData.reflectionText (string): 学生复盘文字原文，LLM 不可用时由规则兜底
 *   当未注入 LLM 评分时，对应维度输出 pendingLLM: true，可由外部后续补充
 */

'use strict';

const scenarioData = require('./scenario_data.json');

// 从 scenario_data.json 提取评分配置
const SCORING_CONFIG = scenarioData.scoring || {};
const DIMENSIONS = SCORING_CONFIG.dimensions || {};
const INSIGHT_SCORING = SCORING_CONFIG.insight_scoring || {};
const DECISION_QUALITY_SCORING = SCORING_CONFIG.decision_quality_scoring || {};
const COMMUNICATION_SCORING = SCORING_CONFIG.communication_scoring || {};
const BUSINESS_BALANCE_SCORING = SCORING_CONFIG.business_balance_scoring || {};

// 从 scenario_data.json 提取事实定义
const FACTS = scenarioData.facts || [];
const ROLES = scenarioData.roles || [];

// 红线事实（关键事实，额外加分）
const RED_LINE_FACTS = ['F-04', 'F-06', 'F-08', 'F-11', 'F-12', 'F-14', 'F-15', 'F-17'];

/**
 * 根据事实 id 获取事实定义
 * @param {string} factId
 * @returns {object|null}
 */
function getFactDef(factId) {
  return FACTS.find((f) => f.id === factId) || null;
}

/**
 * 计算用户洞察分（user_insight 维度）
 * 规则：按获取事实的 L0/L2/L3 分值累加，红线事实额外加分
 * @param {string[]} acquiredFacts
 * @returns {{score:number, maxScore:number, details:object[], breakdown:object}}
 */
function scoreUserInsight(acquiredFacts) {
  acquiredFacts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
  const maxScore = INSIGHT_SCORING.max_insight_score || 25;
  let score = 0;
  const details = [];
  const breakdown = { L0: 0, L2: 0, L3: 0, redLineBonus: 0 };

  for (const factId of acquiredFacts) {
    const fact = getFactDef(factId);
    if (!fact) {
      details.push({ factId, score: 0, reason: '事实不存在' });
      continue;
    }

    let factScore = 0;
    const level = fact.access_level;

    if (level === 'L0') {
      factScore = INSIGHT_SCORING.L0_fact || 3;
      breakdown.L0 += factScore;
    } else if (level === 'L2') {
      factScore = INSIGHT_SCORING.L2_fact || 5;
      breakdown.L2 += factScore;
    } else if (level === 'L3') {
      factScore = INSIGHT_SCORING.L3_fact || 8;
      breakdown.L3 += factScore;
    }

    // 红线事实额外加分
    let redLineBonus = 0;
    if (RED_LINE_FACTS.indexOf(factId) >= 0) {
      redLineBonus = INSIGHT_SCORING.red_line_fact_bonus || 3;
      breakdown.redLineBonus += redLineBonus;
      factScore += redLineBonus;
    }

    score += factScore;
    details.push({
      factId,
      content: fact.content,
      accessLevel: level,
      baseScore: factScore - redLineBonus,
      redLineBonus,
      totalScore: factScore,
    });
  }

  // 限制最高分
  const finalScore = Math.min(score, maxScore);

  return {
    score: finalScore,
    maxScore,
    details,
    breakdown,
    rawScore: score,
    capped: score > maxScore,
  };
}

/**
 * 计算决策质量分（decision_quality 维度）
 * 混合：规则引擎 70% + LLM 30%
 * @param {object} sessionData
 * @returns {{ruleScore:number, llmScore:number, hybridScore:number, maxScore:number, details:object[]}}
 */
function scoreDecisionQuality(sessionData) {
  sessionData = sessionData || {};
  const acquiredFacts = Array.isArray(sessionData.acquiredFacts) ? sessionData.acquiredFacts : [];
  const constraintResults = sessionData.constraintResults || { passed: [], violated: [], warnings: [] };
  const d2Decision = sessionData.d2Decision || {};
  const maxScore = 25;

  // ---- 规则引擎部分（70%）----
  let ruleScore = 0;
  const details = [];

  // 硬约束满足加分
  const constraintBonus = (constraintResults.passed || []).length * (DECISION_QUALITY_SCORING.constraint_satisfied || 5);
  ruleScore += constraintBonus;
  details.push({
    item: '硬约束满足',
    count: (constraintResults.passed || []).length,
    perPoint: DECISION_QUALITY_SCORING.constraint_satisfied || 5,
    score: constraintBonus,
  });

  // 硬约束违反扣分
  const violationPenalty = (constraintResults.violated || []).length * 3;
  ruleScore -= violationPenalty;
  details.push({
    item: '硬约束违反',
    count: (constraintResults.violated || []).length,
    perPoint: -3,
    score: -violationPenalty,
  });

  // 证据引用加分（兼容 evidence_refs / cited_facts / citedFacts）
  const citedFacts = d2Decision.evidence_refs || d2Decision.cited_facts || d2Decision.citedFacts || d2Decision.d2_params?.evidence_refs || [];
  const validCitations = citedFacts.filter((f) => acquiredFacts.indexOf(f) >= 0);
  const citationBonus = validCitations.length * (DECISION_QUALITY_SCORING.evidence_cited || 3);
  ruleScore += citationBonus;
  details.push({
    item: '有效证据引用',
    count: validCitations.length,
    perPoint: DECISION_QUALITY_SCORING.evidence_cited || 3,
    score: citationBonus,
  });

  // 幻觉证据扣分
  const hallucinated = citedFacts.filter((f) => acquiredFacts.indexOf(f) < 0);
  const hallucinationPenalty = hallucinated.length * (DECISION_QUALITY_SCORING.hallucinated_evidence || -10);
  ruleScore += hallucinationPenalty;
  details.push({
    item: '幻觉证据',
    count: hallucinated.length,
    perPoint: DECISION_QUALITY_SCORING.hallucinated_evidence || -10,
    score: hallucinationPenalty,
  });

  // P1 评估缺失扣分
  const option = d2Decision.option || d2Decision.d2_option || '';
  const isGoFull = option === 'Go全量' || option === 'Go' || option.indexOf('全量') >= 0;
  const f04Acquired = acquiredFacts.indexOf('F-04') >= 0;
  const f16Acquired = acquiredFacts.indexOf('F-16') >= 0;
  if (isGoFull && !f04Acquired && !f16Acquired) {
    ruleScore += DECISION_QUALITY_SCORING.missing_p1_assessment || -5;
    details.push({
      item: 'P1 缺陷评估缺失',
      score: DECISION_QUALITY_SCORING.missing_p1_assessment || -5,
    });
  }

  // 忽视 QA 建议扣分
  const f07Acquired = acquiredFacts.indexOf('F-07') >= 0;
  const optionHasLimited = option.indexOf('Limited') >= 0 || option.indexOf('灰度') >= 0;
  if (f07Acquired && optionHasLimited) {
    // 学生获取了 QA 灰度安全建议且选了灰度，说明采纳了 QA 意见，不扣分
    details.push({ item: '采纳 QA 灰度建议', score: 0 });
  } else if (!f07Acquired && optionHasLimited) {
    // 未获取 QA 建议就选灰度，忽视专业意见
    ruleScore += DECISION_QUALITY_SCORING.ignored_qa_advice || -3;
    details.push({
      item: '忽视 QA 灰度专业意见',
      score: DECISION_QUALITY_SCORING.ignored_qa_advice || -3,
    });
  }

  // C-04 盲区扣分
  const f12Acquired = acquiredFacts.indexOf('F-12') >= 0;
  const isOnline = option.indexOf('Go') >= 0 || option.indexOf('Limited') >= 0 || option.indexOf('全量') >= 0;
  if (isOnline && !f12Acquired) {
    ruleScore += DECISION_QUALITY_SCORING.blind_spot_c04 || -8;
    details.push({
      item: 'C-04 止血能力盲区',
      score: DECISION_QUALITY_SCORING.blind_spot_c04 || -8,
    });
  }

  // 规则分归一化到 0-25 范围（规则部分满分上限 25 * 0.7 = 17.5）
  const normalizedRuleScore = Math.max(0, Math.min(17.5, ruleScore * 0.35)); // 乘以系数使规则分合理分布

  // ---- LLM 部分（30%）----
  // LLM 评分由外部注入，此处预留接口
  // 若 sessionData 中提供 llmDecisionScore 则直接使用
  const llmScore = sessionData.llmDecisionScore !== undefined ? sessionData.llmDecisionScore : null;
  const llmContribution = llmScore !== null ? (llmScore / 100) * 7.5 : 0; // 30% 的 25 分 = 7.5

  // ---- 混合分 ----
  const hybridScore = normalizedRuleScore + llmContribution;
  const finalScore = Math.max(0, Math.min(maxScore, hybridScore));

  return {
    ruleScore: normalizedRuleScore,
    llmScore,
    llmContribution,
    hybridScore: finalScore,
    maxScore,
    rawRuleScore: ruleScore,
    details,
    pendingLLM: llmScore === null,
  };
}

/**
 * 计算沟通分（communication 维度）
 * 规则：访谈角色数 + 信任变化 + 交叉验证
 * @param {object} sessionData
 * @returns {{score:number, maxScore:number, details:object[]}}
 */
function scoreCommunication(sessionData) {
  sessionData = sessionData || {};
  const maxScore = 20;
  let score = 0;
  const details = [];

  // 访谈角色数
  const interviewLog = Array.isArray(sessionData.interviewLog) ? sessionData.interviewLog : [];
  const interviewedRoles = new Set();
  for (const entry of interviewLog) {
    if (entry.roleId) interviewedRoles.add(entry.roleId);
  }
  const roleCount = interviewedRoles.size;
  const roleBonus = roleCount * (COMMUNICATION_SCORING.per_role_interviewed || 3);
  score += roleBonus;
  details.push({
    item: '访谈角色数',
    count: roleCount,
    roles: Array.from(interviewedRoles),
    perPoint: COMMUNICATION_SCORING.per_role_interviewed || 3,
    score: roleBonus,
  });

  // 仅访谈单角色扣分
  if (roleCount === 1) {
    score += COMMUNICATION_SCORING.single_role_only || -8;
    details.push({
      item: '仅访谈单一角色',
      score: COMMUNICATION_SCORING.single_role_only || -8,
    });
  }

  // 信任净变化
  const relationshipStates = sessionData.relationshipStates || {};
  const trustChanges = relationshipStates.getTrustNetChanges
    ? relationshipStates.getTrustNetChanges()
    : (sessionData.trustNetChanges || {});

  let totalTrustChange = 0;
  for (const roleId of Object.keys(trustChanges)) {
    const change = trustChanges[roleId];
    const netChange = change.netChange !== undefined ? change.netChange : 0;
    totalTrustChange += netChange;
  }
  const trustMultiplier = COMMUNICATION_SCORING.trust_net_change_multiplier || 0.5;
  const trustScore = totalTrustChange * trustMultiplier;
  score += trustScore;
  details.push({
    item: '信任度净变化',
    totalChange: totalTrustChange,
    multiplier: trustMultiplier,
    score: trustScore,
  });

  // 交叉验证：检查学生是否对同一事实从不同角色获取了信息
  // 简化逻辑：检查访谈记录中是否出现对同一事实的跨角色追问
  const crossValidationCount = (sessionData.crossValidationCount || 0);
  const crossValidationBonus = crossValidationCount * (COMMUNICATION_SCORING.cross_validation || 4);
  score += crossValidationBonus;
  details.push({
    item: '交叉验证',
    count: crossValidationCount,
    perPoint: COMMUNICATION_SCORING.cross_validation || 4,
    score: crossValidationBonus,
  });

  const finalScore = Math.max(0, Math.min(maxScore, score));
  return { score: finalScore, maxScore, details };
}

/**
 * 计算商业平衡分（business_balance 维度）
 * 规则：基于 S2/S3 状态 + F-08/F-14 获取加分
 * @param {object} sessionData
 * @returns {{score:number, maxScore:number, details:object[]}}
 */
function scoreBusinessBalance(sessionData) {
  sessionData = sessionData || {};
  const maxScore = 20;
  let score = 10; // 基础分
  const details = [];

  const stateResults = sessionData.stateResults || {};
  const s2 = stateResults.S2 || '中';
  const s3 = stateResults.S3 !== undefined ? stateResults.S3 : 70;
  const acquiredFacts = Array.isArray(sessionData.acquiredFacts) ? sessionData.acquiredFacts : [];

  // S3 支持度
  if (s3 >= 70) {
    score += BUSINESS_BALANCE_SCORING.s3_above_70 || 5;
    details.push({
      item: 'S3 支持度 ≥ 70',
      value: s3,
      score: BUSINESS_BALANCE_SCORING.s3_above_70 || 5,
    });
  } else if (s3 < 50) {
    score += BUSINESS_BALANCE_SCORING.s3_below_50 || -5;
    details.push({
      item: 'S3 支持度 < 50',
      value: s3,
      score: BUSINESS_BALANCE_SCORING.s3_below_50 || -5,
    });
  }

  // S2 风险
  if (s2 === '高') {
    score += BUSINESS_BALANCE_SCORING.s2_high || -5;
    details.push({
      item: 'S2 质量风险高',
      score: BUSINESS_BALANCE_SCORING.s2_high || -5,
    });
  }

  // S4 在 v0.1 中不存在，该扣分项预留
  // BUSINESS_BALANCE_SCORING.s4_above_30 暂不使用

  // F-08 获取加分
  if (acquiredFacts.indexOf('F-08') >= 0) {
    score += BUSINESS_BALANCE_SCORING.f08_acquired_bonus || 4;
    details.push({
      item: '获取 F-08 总损失数据',
      score: BUSINESS_BALANCE_SCORING.f08_acquired_bonus || 4,
    });
  }

  // F-14 获取加分
  if (acquiredFacts.indexOf('F-14') >= 0) {
    score += BUSINESS_BALANCE_SCORING.f14_acquired_bonus || 3;
    details.push({
      item: '获取 F-14 竞品情报',
      score: BUSINESS_BALANCE_SCORING.f14_acquired_bonus || 3,
    });
  }

  const finalScore = Math.max(0, Math.min(maxScore, score));
  return { score: finalScore, maxScore, details };
}

/**
 * 计算成长反思分（growth_reflection 维度）
 * LLM 评估：由外部注入 LLM 评分
 * @param {object} sessionData
 * @returns {{score:number, maxScore:number, details:object[], pendingLLM:boolean}}
 */
function scoreGrowthReflection(sessionData) {
  sessionData = sessionData || {};
  const maxScore = 15;

  // LLM 评分由外部注入
  const llmScore = sessionData.llmReflectionScore !== undefined ? sessionData.llmReflectionScore : null;

  if (llmScore !== null) {
    const score = (llmScore / 100) * maxScore;
    return {
      score,
      maxScore,
      llmScore,
      pendingLLM: false,
      details: [{
        item: 'LLM 成长反思评估',
        llmScore,
        convertedScore: score,
      }],
    };
  }

  // 未提供 LLM 评分时，根据复盘内容的完整度给出基础分
  const reflectionText = sessionData.reflectionText || '';
  let baseScore = 0;

  // 简单规则：复盘文本长度作为完整度参考
  if (reflectionText.length > 200) baseScore = 8;
  else if (reflectionText.length > 100) baseScore = 6;
  else if (reflectionText.length > 50) baseScore = 4;
  else baseScore = 2;

  // 检查是否包含关键反思关键词
  const reflectionKeywords = ['教训', '改进', '下次', '应该', '反思', '不足', '经验'];
  const keywordCount = reflectionKeywords.filter((kw) => reflectionText.indexOf(kw) >= 0).length;
  baseScore += Math.min(4, keywordCount);

  const finalScore = Math.max(0, Math.min(maxScore, baseScore));
  return {
    score: finalScore,
    maxScore,
    pendingLLM: true,
    details: [{
      item: '规则兜底评估（待 LLM 替换）',
      textLength: reflectionText.length,
      keywordCount,
      score: finalScore,
    }],
  };
}

/**
 * 主入口：计算完整评分报告
 * @param {object} sessionData - 会话数据
 * @returns {object} 完整评分报告
 */
function calculateScore(sessionData) {
  sessionData = sessionData || {};

  // 各维度评分
  const insight = scoreUserInsight(sessionData.acquiredFacts);
  const decisionQuality = scoreDecisionQuality(sessionData);
  const communication = scoreCommunication(sessionData);
  const businessBalance = scoreBusinessBalance(sessionData);
  const growthReflection = scoreGrowthReflection(sessionData);

  // 按权重计算总分
  const weights = {
    user_insight: DIMENSIONS.user_insight ? DIMENSIONS.user_insight.weight : 0.20,
    decision_quality: DIMENSIONS.decision_quality ? DIMENSIONS.decision_quality.weight : 0.25,
    communication: DIMENSIONS.communication ? DIMENSIONS.communication.weight : 0.20,
    business_balance: DIMENSIONS.business_balance ? DIMENSIONS.business_balance.weight : 0.20,
    growth_reflection: DIMENSIONS.growth_reflection ? DIMENSIONS.growth_reflection.weight : 0.15,
  };

  // 各维度归一化为百分制
  const insightPct = (insight.score / insight.maxScore) * 100;
  const decisionPct = (decisionQuality.hybridScore / decisionQuality.maxScore) * 100;
  const communicationPct = (communication.score / communication.maxScore) * 100;
  const businessPct = (businessBalance.score / businessBalance.maxScore) * 100;
  const growthPct = (growthReflection.score / growthReflection.maxScore) * 100;

  // 加权总分
  const totalScore =
    insightPct * weights.user_insight +
    decisionPct * weights.decision_quality +
    communicationPct * weights.communication +
    businessPct * weights.business_balance +
    growthPct * weights.growth_reflection;

  // 评级
  let grade = '';
  if (totalScore >= 90) grade = 'A（优秀）';
  else if (totalScore >= 80) grade = 'B（良好）';
  else if (totalScore >= 70) grade = 'C（合格）';
  else if (totalScore >= 60) grade = 'D（待改进）';
  else grade = 'F（不合格）';

  return {
    totalScore: Math.round(totalScore * 10) / 10,
    grade,
    weights,
    dimensions: {
      user_insight: {
        score: insight.score,
        maxScore: insight.maxScore,
        percentage: Math.round(insightPct * 10) / 10,
        engine: 'rule',
        details: insight.details,
        breakdown: insight.breakdown,
      },
      decision_quality: {
        score: Math.round(decisionQuality.hybridScore * 10) / 10,
        maxScore: decisionQuality.maxScore,
        percentage: Math.round(decisionPct * 10) / 10,
        engine: 'hybrid_70_30',
        ruleScore: Math.round(decisionQuality.ruleScore * 10) / 10,
        llmScore: decisionQuality.llmScore,
        pendingLLM: decisionQuality.pendingLLM,
        details: decisionQuality.details,
      },
      communication: {
        score: Math.round(communication.score * 10) / 10,
        maxScore: communication.maxScore,
        percentage: Math.round(communicationPct * 10) / 10,
        engine: 'rule',
        details: communication.details,
      },
      business_balance: {
        score: Math.round(businessBalance.score * 10) / 10,
        maxScore: businessBalance.maxScore,
        percentage: Math.round(businessPct * 10) / 10,
        engine: 'rule',
        details: businessBalance.details,
      },
      growth_reflection: {
        score: Math.round(growthReflection.score * 10) / 10,
        maxScore: growthReflection.maxScore,
        percentage: Math.round(growthPct * 10) / 10,
        engine: 'llm',
        pendingLLM: growthReflection.pendingLLM,
        details: growthReflection.details,
      },
    },
    evaluationLayers: SCORING_CONFIG.evaluation_layers || [],
  };
}

module.exports = {
  calculateScore,
  scoreUserInsight,
  scoreDecisionQuality,
  scoreCommunication,
  scoreBusinessBalance,
  scoreGrowthReflection,
};
