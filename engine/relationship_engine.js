/**
 * relationship_engine.js - 关系状态引擎（v0.1）
 *
 * 职责：管理每个角色（R1-R4）的关系状态（四档：抵触/中性/配合/信任），
 * 处理信任度变更、信息披露判定和正式质询规则检查（R-FA1/FA2/FA3）。
 *
 * 关键概念：
 * - 信任度数值范围 0-100，初始为 50（中性）
 * - 四档边界：抵触 0-29 / 中性 30-59 / 配合 60-79 / 信任 80-100
 * - 跨角色隔离：不同角色的信任度互不影响
 * - 披露速度由档位决定：配合档 L2 第一问即给，L3 需一轮追问
 */

'use strict';

const scenarioData = require('./scenario_data.json');

// 从 scenario_data.json 提取关系模型
const RELATIONSHIP_MODEL = scenarioData.relationship_model || {};
const ACTION_TRUST_CHANGES = RELATIONSHIP_MODEL.action_trust_changes || {};
const TIERS = RELATIONSHIP_MODEL.tiers || [];
const TIER_DISCLOSURE_SPEED = RELATIONSHIP_MODEL.tier_disclosure_speed || {};

// 从 scenario_data.json 提取角色与事实定义
const ROLES = scenarioData.roles || [];
const FACTS = scenarioData.facts || [];
const FORMAL_INQUIRY_RULES = scenarioData.formal_inquiry_rules || [];

// 意图→动作类型映射（用于从学生消息推断 actionType）
// 这些关键词用于在学生消息中识别沟通动作类型
const INTENT_KEYWORDS = {
  structured_questioning: ['结构化', '分点', '逐条', '系统性', '哪些方面', '具体来说', '分别'],
  risk_verification: ['风险', '阈值', '复现', '触发', '压测', '止血', '回滚', '应急预案', '验证', '确认'],
  plan_negotiation: ['方案', '灰度', '比例', '折中', '协商', '能不能', '是否可以', '计划'],
  resource_inquiry: ['资源', '人力', '工时', '人天', '排期', '产能', '多久', '几个人'],
  executive_alignment: ['战略', '整体', '总账', '全部代价', '竞品', '长期', '高层', '对齐'],
  one_sided_questioning: ['只问', '就问', '不管其他'],
  offensive_expression: ['指责', '怪', '为什么不', '你们怎么', '搞什么', '垃圾', '不行'],
};

/**
 * 根据信任值获取档位名称
 * @param {number} trustValue
 * @returns {string} 抵触/中性/配合/信任
 */
function getTierByValue(trustValue) {
  for (const tier of TIERS) {
    const [low, high] = tier.range;
    if (trustValue >= low && trustValue <= high) {
      return tier.name;
    }
  }
  // 超出范围
  if (trustValue >= 80) return '信任';
  if (trustValue >= 60) return '配合';
  if (trustValue >= 30) return '中性';
  return '抵触';
}

/**
 * 根据档位名称获取边界范围
 * @param {string} tierName
 * @returns {[number, number]}
 */
function getTierRange(tierName) {
  const tier = TIERS.find((t) => t.name === tierName);
  return tier ? tier.range : [0, 100];
}

/**
 * 从学生消息推断意图/动作类型
 * @param {string} studentMessage
 * @returns {string} actionType
 */
function inferActionType(studentMessage) {
  if (!studentMessage) return 'one_sided_questioning';
  const msg = studentMessage.toLowerCase();

  // 检查冒犯性表达（优先级最高）
  const offensive = INTENT_KEYWORDS.offensive_expression;
  if (offensive.some((kw) => msg.indexOf(kw) >= 0)) {
    return 'offensive_expression';
  }

  // 检查各正面对话类型
  const types = [
    'structured_questioning',
    'risk_verification',
    'plan_negotiation',
    'resource_inquiry',
    'executive_alignment',
  ];

  let bestMatch = null;
  let bestScore = 0;

  for (const type of types) {
    const keywords = INTENT_KEYWORDS[type] || [];
    let score = 0;
    for (const kw of keywords) {
      if (msg.indexOf(kw) >= 0) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = type;
    }
  }

  // 默认为结构化提问（最常见的正面对话）
  return bestMatch || 'structured_questioning';
}

/**
 * 构造关系状态引擎实例
 * 每个会话应创建一个独立实例
 */
function createRelationshipEngine() {
  // 信任度状态：{ R1: 50, R2: 50, R3: 50, R4: 50 }
  // 初始信任取自角色定义的 initial_trust 或全局 initial_trust
  const trustValues = {};
  const initialTrust = RELATIONSHIP_MODEL.initial_trust || 50;
  for (const role of ROLES) {
    trustValues[role.id] = role.initial_trust !== undefined ? role.initial_trust : initialTrust;
  }

  // 每个角色的提问历史（用于计算轮次和跨角色隔离）
  const inquiryHistory = {};
  for (const role of ROLES) {
    inquiryHistory[role.id] = {
      totalQuestions: 0,
      actionTypes: {},
      disclosedFacts: [],
      pendingFollowUp: {}, // factId → 是否需要追问
    };
  }

  // 信任度变更日志
  const trustLog = [];

  /**
   * 记录信任度变更
   * @param {string} roleId
   * @param {number} oldValue
   * @param {number} newValue
   * @param {string} actionType
   * @param {string} reason
   */
  function logTrustChange(roleId, oldValue, newValue, actionType, reason) {
    trustLog.push({
      timestamp: new Date().toISOString(),
      roleId,
      oldValue,
      newValue,
      delta: newValue - oldValue,
      actionType,
      reason,
    });
  }

  /**
   * 获取角色当前档位名称
   * @param {string} roleId
   * @returns {string} 抵触/中性/配合/信任
   */
  function getTier(roleId) {
    const val = trustValues[roleId];
    if (val === undefined) return '中性';
    return getTierByValue(val);
  }

  /**
   * 获取角色内部信任数值
   * @param {string} roleId
   * @returns {number}
   */
  function getTrustValue(roleId) {
    return trustValues[roleId] !== undefined ? trustValues[roleId] : initialTrust;
  }

  /**
   * 根据沟通动作更新信任度
   * @param {string} roleId
   * @param {string} actionType - 动作类型（见 ACTION_TRUST_CHANGES）
   * @returns {{oldValue:number, newValue:number, delta:number, newTier:string}}
   */
  function applyAction(roleId, actionType) {
    const delta = ACTION_TRUST_CHANGES[actionType];
    if (delta === undefined) {
      return {
        oldValue: trustValues[roleId],
        newValue: trustValues[roleId],
        delta: 0,
        newTier: getTier(roleId),
      };
    }

    const oldValue = trustValues[roleId];
    let newValue = oldValue + delta;
    // 限制在 0-100 范围
    newValue = Math.max(0, Math.min(100, newValue));

    trustValues[roleId] = newValue;

    // 记录提问历史
    const hist = inquiryHistory[roleId];
    hist.totalQuestions += 1;
    hist.actionTypes[actionType] = (hist.actionTypes[actionType] || 0) + 1;

    logTrustChange(roleId, oldValue, newValue, actionType, `动作 ${actionType} 导致信任 ${delta >= 0 ? '+' : ''}${delta}`);

    return {
      oldValue,
      newValue,
      delta: newValue - oldValue,
      newTier: getTierByValue(newValue),
    };
  }

  /**
   * 判定该角色当前是否可以披露某条事实
   * 基于：角色持有该事实 + 信任档位 + 披露条件 + 提问轮次
   * @param {string} roleId
   * @param {string} factId
   * @returns {{canDisclose:boolean, reason:string, actionType?:string}}
   */
  function canDisclose(roleId, factId) {
    // 查找事实定义
    const fact = FACTS.find((f) => f.id === factId);
    if (!fact) {
      return { canDisclose: false, reason: `事实 ${factId} 不存在` };
    }

    // 检查事实持有者是否匹配
    if (fact.holder !== 'ALL' && fact.holder !== roleId) {
      return { canDisclose: false, reason: `事实 ${factId} 的持有者是 ${fact.holder}，非 ${roleId}` };
    }

    // L0 事实初始可见
    if (fact.access_level === 'L0' || fact.disclosure_condition === 'initial_visible') {
      return { canDisclose: true, reason: 'L0 事实，初始可见', actionType: null };
    }

    // 获取当前档位
    const tier = getTier(roleId);
    const trustVal = getTrustValue(roleId);

    // 解析披露条件
    const condition = fact.disclosure_condition || '';

    // 检查是否需要 trust >= 配合（60）
    const needsCooperation = condition.indexOf('trust>=配合') >= 0 || condition.indexOf('trust >= 配合') >= 0;
    if (needsCooperation && trustVal < 60) {
      return {
        canDisclose: false,
        reason: `事实 ${factId} 需要信任 ≥ 配合（60），当前 ${tier}（${trustVal}）`,
        actionType: fact.disclosure_action,
      };
    }

    // 检查是否包含 D1 自动披露条件
    if (condition.indexOf('D1_') >= 0 && condition.indexOf('auto_disclose') >= 0) {
      // D1 自动披露由 index.js 在 submitD1 时处理，此处返回需要外部触发
      return {
        canDisclose: false,
        reason: `事实 ${factId} 需要 D1 选择触发自动披露`,
        actionType: 'd1_auto_disclose',
      };
    }

    // 按档位判断 L2/L3 披露速度
    const accessLevel = fact.access_level;
    const hist = inquiryHistory[roleId];
    const alreadyDisclosed = hist.disclosedFacts.indexOf(factId) >= 0;

    if (alreadyDisclosed) {
      return { canDisclose: true, reason: '已披露过，可重复提供', actionType: null };
    }

    // 检查是否有正式质询条件
    if (condition.indexOf('formal_inquiry') >= 0) {
      // 需要正式质询触发，由 checkFormalInquiry 处理
      // 此处先判断信任档位是否满足
      if (needsCooperation && trustVal < 60) {
        return {
          canDisclose: false,
          reason: `事实 ${factId} 需要正式质询且信任 ≥ 配合，当前信任不足`,
          actionType: 'formal_inquiry',
        };
      }
      return {
        canDisclose: false,
        reason: `事实 ${factId} 需要通过正式质询触发`,
        actionType: 'formal_inquiry',
      };
    }

    // 按档位 + access_level 判断
    const speed = TIER_DISCLOSURE_SPEED[tier];
    if (!speed) {
      return { canDisclose: false, reason: `无法确定 ${tier} 档位的披露速度` };
    }

    // L2 事实
    if (accessLevel === 'L2') {
      if (tier === '抵触') {
        // L2 需 3 轮追问
        const rounds = hist.pendingFollowUp[factId] || 0;
        if (rounds >= 3) {
          return { canDisclose: true, reason: `抵触档 L2 需 3 轮追问，已满足`, actionType: fact.disclosure_action };
        }
        return {
          canDisclose: false,
          reason: `抵触档 L2 事实需 3 轮追问，当前 ${rounds} 轮`,
          actionType: fact.disclosure_action,
          needsRounds: 3 - rounds,
        };
      } else if (tier === '中性') {
        // L2 需 1 轮追问
        const rounds = hist.pendingFollowUp[factId] || 0;
        if (rounds >= 1) {
          return { canDisclose: true, reason: `中性档 L2 需 1 轮追问，已满足`, actionType: fact.disclosure_action };
        }
        return {
          canDisclose: false,
          reason: `中性档 L2 事实需 1 轮追问，当前 ${rounds} 轮`,
          actionType: fact.disclosure_action,
          needsRounds: 1 - rounds,
        };
      } else if (tier === '配合') {
        // L2 第一问即给
        return { canDisclose: true, reason: '配合档 L2 事实第一问即给', actionType: fact.disclosure_action };
      } else if (tier === '信任') {
        // L2/L3 第一问即给
        return { canDisclose: true, reason: '信任档 L2 事实第一问即给', actionType: fact.disclosure_action };
      }
    }

    // L3 事实
    if (accessLevel === 'L3') {
      if (tier === '抵触' || tier === '中性') {
        // L3 不披露
        return {
          canDisclose: false,
          reason: `${tier}档 L3 事实不披露`,
          actionType: 'formal_inquiry',
        };
      } else if (tier === '配合') {
        // L3 需 1 轮追问
        const rounds = hist.pendingFollowUp[factId] || 0;
        if (rounds >= 1) {
          return { canDisclose: true, reason: `配合档 L3 需 1 轮追问，已满足`, actionType: fact.disclosure_action };
        }
        return {
          canDisclose: false,
          reason: `配合档 L3 事实需 1 轮追问，当前 ${rounds} 轮`,
          actionType: fact.disclosure_action,
          needsRounds: 1 - rounds,
        };
      } else if (tier === '信任') {
        // L3 第一问即给
        return { canDisclose: true, reason: '信任档 L3 事实第一问即给', actionType: fact.disclosure_action };
      }
    }

    return { canDisclose: false, reason: '无法判定披露条件' };
  }

  /**
   * 检查 R-FA1/FA2/FA3 三条正式质询规则
   * @param {string} studentMessage - 学生提问原文
   * @param {string} roleId - 被提问角色 id
   * @param {string[]} acquiredFacts - 已获取事实 id 数组
   * @returns {{matchedRules:string[], canDiscloseFacts:string[], details:object[]}}
   */
  function checkFormalInquiry(studentMessage, roleId, acquiredFacts) {
    acquiredFacts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
    const msg = studentMessage || '';
    const matchedRules = [];
    const canDiscloseFacts = [];
    const details = [];

    // ---- R-FA1: 前置证据法 ----
    // 条件：学生已获取一条关联事实，并以此为据追问当前角色
    const fa1Def = FORMAL_INQUIRY_RULES.find((r) => r.id === 'R-FA1');
    if (fa1Def) {
      // 查找当前角色持有、且 access_level 为 L2/L3 的事实
      const roleFacts = FACTS.filter(
        (f) => (f.holder === roleId || f.holder === 'ALL') && (f.access_level === 'L2' || f.access_level === 'L3')
      );

      for (const fact of roleFacts) {
        // 检查学生消息是否引用了某条已获取的关联事实
        // 简化逻辑：检查消息中是否出现已获取事实的 id 或内容关键词
        const referencedFacts = acquiredFacts.filter((fid) => {
          // 检查消息中是否直接引用了事实 id 或包含事实内容关键词
          if (msg.indexOf(fid) >= 0) return true;
          const refFact = FACTS.find((f) => f.id === fid);
          if (refFact && refFact.content) {
            // 取内容的前 4 个字作为关键词匹配
            const kw = refFact.content.substring(0, 4);
            if (kw && msg.indexOf(kw) >= 0) return true;
          }
          return false;
        });

        if (referencedFacts.length > 0) {
          // R-FA1 命中：可以触发该事实披露
          matchedRules.push('R-FA1');
          canDiscloseFacts.push(fact.id);
          details.push({
            rule: 'R-FA1',
            ruleName: fa1Def.name,
            factId: fact.id,
            reason: `学生已获取 ${referencedFacts.join(',')} 并以此为据追问，触发 ${fact.id} 披露`,
            referencedFacts,
          });
          break; // 每条规则命中一次即可
        }
      }
    }

    // ---- R-FA2: 用途说明法 ----
    // 条件：学生在提问中明确说明决策用途或分析目的
    const fa2Def = FORMAL_INQUIRY_RULES.find((r) => r.id === 'R-FA2');
    if (fa2Def) {
      const purposeKeywords = ['为了', '需要评估', '需要了解', '用来', '目的是', '分析', '决策用', '预案用', '需要知道'];
      const hasPurpose = purposeKeywords.some((kw) => msg.indexOf(kw) >= 0);

      if (hasPurpose) {
        // 查找当前角色持有的 L2 事实
        const roleL2Facts = FACTS.filter(
          (f) => (f.holder === roleId || f.holder === 'ALL') && f.access_level === 'L2'
        );
        for (const fact of roleL2Facts) {
          if (canDiscloseFacts.indexOf(fact.id) < 0) {
            matchedRules.push('R-FA2');
            canDiscloseFacts.push(fact.id);
            details.push({
              rule: 'R-FA2',
              ruleName: fa2Def.name,
              factId: fact.id,
              reason: `学生明确说明了决策用途，触发 ${fact.id} 披露`,
            });
            break;
          }
        }
      }
    }

    // ---- R-FA3: 角色身份法 ----
    // 条件：学生以项目负责人身份直接询问该角色的核心职责范围
    const fa3Def = FORMAL_INQUIRY_RULES.find((r) => r.id === 'R-FA3');
    if (fa3Def) {
      const identityKeywords = ['作为项目负责人', '项目负责人', '我需要了解', '我负责', '代表项目'];
      const hasIdentity = identityKeywords.some((kw) => msg.indexOf(kw) >= 0);

      if (hasIdentity) {
        // 查找当前角色持有的 L2/L3 事实
        const roleFacts = FACTS.filter(
          (f) => (f.holder === roleId || f.holder === 'ALL') && (f.access_level === 'L2' || f.access_level === 'L3')
        );
        for (const fact of roleFacts) {
          if (canDiscloseFacts.indexOf(fact.id) < 0) {
            matchedRules.push('R-FA3');
            canDiscloseFacts.push(fact.id);
            details.push({
              rule: 'R-FA3',
              ruleName: fa3Def.name,
              factId: fact.id,
              reason: `学生以项目负责人身份直接询问核心职责，触发 ${fact.id} 披露`,
            });
            break;
          }
        }
      }
    }

    return {
      matchedRules: Array.from(new Set(matchedRules)), // 去重
      canDiscloseFacts: Array.from(new Set(canDiscloseFacts)),
      details,
    };
  }

  /**
   * 返回所有角色当前档位
   * @returns {object} { R1: '中性', R2: '配合', ... }
   */
  function getAllTiers() {
    const result = {};
    for (const role of ROLES) {
      result[role.id] = {
        tier: getTier(role.id),
        trustValue: trustValues[role.id],
        roleName: role.name,
        roleTitle: role.title,
      };
    }
    return result;
  }

  /**
   * 标记某条事实已被该角色披露（用于后续轮次判断）
   * @param {string} roleId
   * @param {string} factId
   */
  function markDisclosed(roleId, factId) {
    const hist = inquiryHistory[roleId];
    if (hist && hist.disclosedFacts.indexOf(factId) < 0) {
      hist.disclosedFacts.push(factId);
    }
  }

  /**
   * 增加追问轮次（用于档位不够时需要多轮追问的场景）
   * @param {string} roleId
   * @param {string} factId
   */
  function incrementFollowUp(roleId, factId) {
    const hist = inquiryHistory[roleId];
    if (hist) {
      hist.pendingFollowUp[factId] = (hist.pendingFollowUp[factId] || 0) + 1;
    }
  }

  /**
   * 获取所有角色信任度变更日志
   * @returns {object[]}
   */
  function getTrustLog() {
    return trustLog.slice();
  }

  /**
   * 获取信任度净变化（用于评分）
   * @returns {object} { R1: {start:number, end:number, netChange:number}, ... }
   */
  function getTrustNetChanges() {
    const result = {};
    for (const role of ROLES) {
      const startVal = role.initial_trust !== undefined ? role.initial_trust : initialTrust;
      const endVal = trustValues[role.id];
      result[role.id] = {
        start: startVal,
        end: endVal,
        netChange: endVal - startVal,
        roleName: role.name,
      };
    }
    return result;
  }

  return {
    getTier,
    getTrustValue,
    applyAction,
    canDisclose,
    checkFormalInquiry,
    getAllTiers,
    markDisclosed,
    incrementFollowUp,
    getTrustLog,
    getTrustNetChanges,
    inferActionType,
  };
}

module.exports = {
  createRelationshipEngine,
  // 导出工具函数
  getTierByValue,
  getTierRange,
  inferActionType,
};
