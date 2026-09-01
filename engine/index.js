/**
 * index.js - 引擎入口（v0.1）
 *
 * 职责：串联所有引擎模块，导出统一的引擎接口。
 *
 * 核心接口：
 *   - startSession(): 初始化会话（加载场景数据，初始化状态和关系）
 *   - processMessage(roleId, studentMessage): 处理学生提问（意图分类→关系更新→信息披露判定）
 *   - submitD1(d1Choice): 提交 D1 决策
 *   - submitD2(d2Decision): 提交 D2 决策
 *   - getReport(): 生成完整复盘报告（评分+证据链+反事实分析+改进建议）
 *   - getState(): 获取当前状态快照
 *
 * 模块依赖：
 *   - constraint_engine: 硬约束检查
 *   - state_engine: 状态机
 *   - relationship_engine: 关系状态
 *   - scoring_engine: 评分
 *   - result_engine: 结果规则
 */

'use strict';

const scenarioData = require('./scenario_data.json');
const constraintEngine = require('./constraint_engine');
const { createStateEngine } = require('./state_engine');
const { createRelationshipEngine } = require('./relationship_engine');
const scoringEngine = require('./scoring_engine');
const resultEngine = require('./result_engine');

// 从 scenario_data.json 提取角色与事实定义
const ROLES = scenarioData.roles || [];
const FACTS = scenarioData.facts || [];

/**
 * 获取事实定义
 * @param {string} factId
 * @returns {object|null}
 */
function getFactDef(factId) {
  return FACTS.find((f) => f.id === factId) || null;
}

/**
 * 创建引擎会话实例
 * 每次调用返回一个全新的、独立的会话上下文
 * @returns {object} 引擎接口对象
 */
function createEngine() {
  // 会话级状态
  const session = {
    started: false,
    scenarioId: scenarioData.scenario_id,
    scenarioName: scenarioData.scenario_name,
    version: scenarioData.version,

    // 已获取事实
    acquiredFacts: [],

    // D1/D2 决策
    d1Choice: null,
    d1SubmittedAt: null,
    d2Decision: null,
    d2SubmittedAt: null,

    // 访谈日志
    interviewLog: [],

    // 交叉验证计数
    crossValidationCount: 0,

    // 引擎实例
    stateEngine: null,
    relationshipEngine: null,

    // 约束检查结果
    constraintResults: null,

    // 结果规则结果
    resultResults: null,
  };

  /**
   * 初始化会话
   */
  function startSession() {
    session.started = true;
    session.acquiredFacts = [];
    session.d1Choice = null;
    session.d2Decision = null;
    session.interviewLog = [];
    session.crossValidationCount = 0;

    // 创建状态引擎和关系引擎实例
    session.stateEngine = createStateEngine();
    session.relationshipEngine = createRelationshipEngine();

    // 加载初始可见事实（L0 / initial_visible）
    for (const fact of FACTS) {
      if (fact.access_level === 'L0' || fact.disclosure_condition === 'initial_visible') {
        if (session.acquiredFacts.indexOf(fact.id) < 0) {
          session.acquiredFacts.push(fact.id);
        }
      }
    }

    return {
      scenarioId: session.scenarioId,
      scenarioName: session.scenarioName,
      version: session.version,
      timeline: scenarioData.timeline,
      roles: ROLES.map((r) => ({ id: r.id, name: r.name, title: r.title })),
      initialFacts: session.acquiredFacts.slice(),
      message: `会话已初始化：${session.scenarioName}（${session.scenarioId} v${session.version}）`,
    };
  }

  /**
   * 处理学生提问
   * 流程：意图分类 → 关系更新 → 信息披露判定
   * @param {string} roleId - 被提问角色 id（R1/R2/R3/R4）
   * @param {string} studentMessage - 学生提问原文
   * @returns {{actionType:string, trustChange:object, disclosedFacts:string[], formalInquiry:object, response:string}}
   */
  function processMessage(roleId, studentMessage) {
    if (!session.started) {
      throw new Error('会话未初始化，请先调用 startSession()');
    }

    const relEngine = session.relationshipEngine;
    const stateEngine = session.stateEngine;

    // 1. 意图分类：从学生消息推断动作类型
    const actionType = relEngine.inferActionType(studentMessage);

    // 2. 关系更新：根据动作类型更新信任度
    const trustChange = relEngine.applyAction(roleId, actionType);

    // 3. 信息披露判定
    const disclosedFacts = [];
    const disclosureDetails = [];

    // 3a. 检查正式质询规则（R-FA1/FA2/FA3）
    const formalInquiry = relEngine.checkFormalInquiry(studentMessage, roleId, session.acquiredFacts);

    // 3b. 正式质询命中的事实可以直接披露
    for (const factId of formalInquiry.canDiscloseFacts) {
      const discResult = relEngine.canDisclose(roleId, factId);
      // 正式质询命中可覆盖档位限制
      if (session.acquiredFacts.indexOf(factId) < 0) {
        session.acquiredFacts.push(factId);
        disclosedFacts.push(factId);
        relEngine.markDisclosed(roleId, factId);
        disclosureDetails.push({
          factId,
          source: 'formal_inquiry',
          rules: formalInquiry.matchedRules,
          fact: getFactDef(factId),
        });
      } else {
        // 已获取但标记为已披露
        relEngine.markDisclosed(roleId, factId);
        disclosureDetails.push({
          factId,
          source: 'formal_inquiry_already_acquired',
          rules: formalInquiry.matchedRules,
        });
      }
    }

    // 3c. 检查该角色持有的、可按档位披露的事实
    const roleFacts = FACTS.filter(
      (f) => f.holder === roleId && f.access_level !== 'L0' && f.disclosure_condition !== 'initial_visible'
    );

    for (const fact of roleFacts) {
      // 跳过已通过正式质询处理的事实
      if (formalInquiry.canDiscloseFacts.indexOf(fact.id) >= 0) continue;
      // 跳过需要 D1 自动披露的事实
      if (fact.disclosure_condition && fact.disclosure_condition.indexOf('D1_') >= 0) continue;

      // 检查消息是否涉及该事实的关键词
      const factKeywords = extractFactKeywords(fact);
      const messageRelevant = factKeywords.some((kw) => studentMessage.indexOf(kw) >= 0);

      if (messageRelevant) {
        const discResult = relEngine.canDisclose(roleId, fact.id);

        if (discResult.canDisclose) {
          if (session.acquiredFacts.indexOf(fact.id) < 0) {
            session.acquiredFacts.push(fact.id);
            disclosedFacts.push(fact.id);
            relEngine.markDisclosed(roleId, fact.id);
            disclosureDetails.push({
              factId: fact.id,
              source: 'tier_disclosure',
              tier: relEngine.getTier(roleId),
              fact,
            });
          }
        } else if (discResult.needsRounds && discResult.needsRounds > 0) {
          // 需要追问，增加追问轮次
          relEngine.incrementFollowUp(roleId, fact.id);
          disclosureDetails.push({
            factId: fact.id,
            source: 'needs_followup',
            reason: discResult.reason,
            needsRounds: discResult.needsRounds,
          });
        } else {
          disclosureDetails.push({
            factId: fact.id,
            source: 'not_disclosable',
            reason: discResult.reason,
          });
        }
      }
    }

    // 4. 检查交叉验证：学生是否对同一事实从不同角色获取信息
    // 简化逻辑：如果学生在不同角色的对话中提到了同一事实
    checkCrossValidation(roleId, disclosedFacts);

    // 5. 记录访谈日志
    session.interviewLog.push({
      timestamp: new Date().toISOString(),
      roleId,
      studentMessage,
      actionType,
      trustChange,
      disclosedFacts: disclosedFacts.slice(),
      formalInquiryMatched: formalInquiry.matchedRules,
    });

    // 6. 构造角色回复
    const role = ROLES.find((r) => r.id === roleId);
    let response = '';

    if (disclosedFacts.length > 0) {
      const factContents = disclosedFacts.map((fid) => {
        const f = getFactDef(fid);
        return f ? `[${fid}] ${f.content}` : fid;
      });
      response = `${role ? role.name : roleId}：${factContents.join('；')}`;
    } else {
      // 未披露新事实时，给出弱信号提示
      const weakSignalFacts = roleFacts.filter(
        (f) => f.weak_signal && studentMessage.indexOf(f.weak_signal.substring(0, 4)) < 0
      );
      if (weakSignalFacts.length > 0 && trustChange.newTier !== '抵触') {
        const ws = weakSignalFacts[0].weak_signal;
        response = `${role ? role.name : roleId}：（弱信号）${ws}`;
      } else {
        response = `${role ? role.name : roleId}：我目前没有更多信息可以提供。`;
      }
    }

    return {
      actionType,
      trustChange,
      disclosedFacts,
      disclosureDetails,
      formalInquiry,
      response,
      acquiredFactsCount: session.acquiredFacts.length,
    };
  }

  /**
   * 从事实定义中提取关键词（用于匹配学生消息）
   * @param {object} fact
   * @returns {string[]}
   */
  function extractFactKeywords(fact) {
    const keywords = [];
    // 从事实 content 中提取关键词
    if (fact.content) {
      // 取内容中较独特的词组（简化：取前 4 字）
      const c = fact.content;
      // 按标点分割
      const segments = c.split(/[，。、；,.;]/);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (trimmed.length >= 2 && trimmed.length <= 8) {
          keywords.push(trimmed);
        }
      }
    }
    // 从 disclosure_action 中提取
    if (fact.disclosure_action) {
      keywords.push(fact.disclosure_action);
    }
    // 从事实 id 中提取
    keywords.push(fact.id);
    return keywords;
  }

  /**
   * 检查交叉验证
   * @param {string} currentRoleId
   * @param {string[]} newlyDisclosedFacts
   */
  function checkCrossValidation(currentRoleId, newlyDisclosedFacts) {
    for (const factId of newlyDisclosedFacts) {
      // 检查该事实是否在其他角色的对话中也被提到
      const otherRoleMentions = session.interviewLog.filter(
        (entry) => entry.roleId !== currentRoleId && entry.disclosedFacts.indexOf(factId) >= 0
      );
      if (otherRoleMentions.length > 0) {
        session.crossValidationCount += 1;
      }
    }
  }

  /**
   * 提交 D1 决策
   * @param {string} d1Choice - A_连夜修复 / B_灰度准备 / C_继续回归
   * @returns {{d1Choice:string, autoDisclosedFacts:string[], stateImpact:object}}
   */
  function submitD1(d1Choice) {
    if (!session.started) {
      throw new Error('会话未初始化，请先调用 startSession()');
    }

    session.d1Choice = d1Choice;
    session.d1SubmittedAt = new Date().toISOString();

    // 查找 D1 选项的 impact_on_D2 配置
    const d1 = scenarioData.decision_nodes && scenarioData.decision_nodes.D1;
    const key = d1 && d1.impact_on_D2
      ? Object.keys(d1.impact_on_D2).find(
          (k) => k === d1Choice || k.indexOf(d1Choice) >= 0
        )
      : null;
    const impact = key ? d1.impact_on_D2[key] : null;

    // 自动披露事实
    const autoDisclosedFacts = [];
    if (impact && impact.auto_disclose) {
      for (const factId of impact.auto_disclose) {
        if (session.acquiredFacts.indexOf(factId) < 0) {
          session.acquiredFacts.push(factId);
          autoDisclosedFacts.push(factId);
        }
      }
    }

    // 应用 D1 对状态的影响
    session.stateEngine.applyD1Impact(d1Choice);

    return {
      d1Choice,
      autoDisclosedFacts,
      stateImpact: session.stateEngine.getState(),
      teachingIntent: impact ? impact.teaching_intent : '',
    };
  }

  /**
   * 提交 D2 决策
   * @param {object|string} d2Decision - D2 决策对象或选项字符串
   * @returns {{constraintResults:object, stateResults:object, resultResults:object}}
   */
  function submitD2(d2Decision) {
    if (!session.started) {
      throw new Error('会话未初始化，请先调用 startSession()');
    }

    session.d2Decision = d2Decision;
    session.d2SubmittedAt = new Date().toISOString();

    const option = typeof d2Decision === 'string'
      ? d2Decision
      : (d2Decision && (d2Decision.option || d2Decision.d2_option)) || '';

    // 1. 硬约束检查
    session.constraintResults = constraintEngine.checkConstraints(
      typeof d2Decision === 'object' ? d2Decision : { option: d2Decision },
      session.acquiredFacts,
      session.d1Choice,
      session.d2SubmittedAt
    );

    // 2. 状态机计算
    session.stateEngine.applyD2Decision(d2Decision, session.acquiredFacts);

    // 3. 结果规则计算
    session.resultResults = resultEngine.calculateResults(
      d2Decision,
      session.acquiredFacts,
      session.d1Choice
    );

    return {
      constraintResults: session.constraintResults,
      stateResults: session.stateEngine.getState(),
      resultResults: session.resultResults,
    };
  }

  /**
   * 获取当前状态快照
   * @returns {object}
   */
  function getState() {
    return {
      started: session.started,
      scenarioId: session.scenarioId,
      acquiredFacts: session.acquiredFacts.slice(),
      d1Choice: session.d1Choice,
      d1SubmittedAt: session.d1SubmittedAt,
      d2Decision: session.d2Decision,
      d2SubmittedAt: session.d2SubmittedAt,
      state: session.stateEngine ? session.stateEngine.getState() : null,
      relationships: session.relationshipEngine ? session.relationshipEngine.getAllTiers() : null,
      interviewLogCount: session.interviewLog.length,
      crossValidationCount: session.crossValidationCount,
    };
  }

  /**
   * 生成完整复盘报告
   * 包含：评分 + 证据链 + 反事实分析 + 改进建议
   * @returns {object} 完整复盘报告
   */
  function getReport() {
    if (!session.started) {
      throw new Error('会话未初始化，请先调用 startSession()');
    }

    const stateResults = session.stateEngine.getState();
    const stateSummary = session.stateEngine.getSSummary();
    const relationshipStates = session.relationshipEngine;
    const trustNetChanges = relationshipStates.getTrustNetChanges();

    // 构造评分所需的 sessionData
    const sessionData = {
      acquiredFacts: session.acquiredFacts,
      d1Choice: session.d1Choice,
      d2Decision: session.d2Decision,
      interviewLog: session.interviewLog,
      constraintResults: session.constraintResults,
      stateResults,
      relationshipStates,
      trustNetChanges,
      crossValidationCount: session.crossValidationCount,
    };

    // 计算评分
    const scoring = scoringEngine.calculateScore(sessionData);

    // 构造证据链
    const evidenceChain = buildEvidenceChain();

    // 反事实分析
    const counterfactual = buildCounterfactualAnalysis();

    // 改进建议
    const improvementSuggestions = buildImprovementSuggestions(scoring, session.constraintResults, session.resultResults);

    return {
      // 基本信息
      scenarioId: session.scenarioId,
      scenarioName: session.scenarioName,
      version: session.version,

      // 学生决策
      studentDecisions: {
        d1Choice: session.d1Choice,
        d2Decision: typeof session.d2Decision === 'object'
          ? session.d2Decision
          : { option: session.d2Decision },
        acquiredFacts: session.acquiredFacts.slice(),
      },

      // 评分
      scoring,

      // 状态摘要
      stateSummary,

      // 关系状态
      relationshipStates: relationshipStates.getAllTiers(),
      trustNetChanges,

      // 约束检查结果
      constraintResults: session.constraintResults,

      // 结果规则
      resultResults: session.resultResults,

      // 证据链
      evidenceChain,

      // 反事实分析
      counterfactual,

      // 改进建议
      improvementSuggestions,

      // 访谈日志
      interviewLog: session.interviewLog,

      // 生成时间
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 构造证据链：展示学生从哪些角色获取了哪些事实
   * @returns {object[]}
   */
  function buildEvidenceChain() {
    const chain = [];
    for (const factId of session.acquiredFacts) {
      const fact = getFactDef(factId);
      if (!fact) continue;

      // 查找该事实是从哪次访谈中获取的
      const acquisition = session.interviewLog.find((entry) => entry.disclosedFacts.indexOf(factId) >= 0);
      const isInitial = fact.access_level === 'L0' || fact.disclosure_condition === 'initial_visible';
      const isAutoDisclosed = session.d1Choice &&
        acquisition === undefined &&
        fact.disclosure_condition &&
        fact.disclosure_condition.indexOf('D1_') >= 0;

      chain.push({
        factId,
        content: fact.content,
        accessLevel: fact.access_level,
        holder: fact.holder,
        source: isInitial
          ? '初始可见'
          : isAutoDisclosed
            ? `D1 自动披露（${session.d1Choice}）`
            : acquisition
              ? `访谈 ${acquisition.roleId}（${actionType2Text(acquisition.actionType)}）`
              : '未知来源',
        acquiredAt: acquisition ? acquisition.timestamp : session.d1SubmittedAt,
        scoringDimension: fact.scoring_dimension,
        teachingPoint: fact.teaching_point,
      });
    }
    return chain;
  }

  /**
   * 将动作类型转为中文描述
   * @param {string} actionType
   * @returns {string}
   */
  function actionType2Text(actionType) {
    const map = {
      structured_questioning: '结构化提问',
      risk_verification: '风险求证',
      plan_negotiation: '方案协商',
      resource_inquiry: '资源询问',
      executive_alignment: '高层对齐',
      one_sided_questioning: '单方面追问',
      offensive_expression: '冒犯表达',
    };
    return map[actionType] || actionType;
  }

  /**
   * 构造反事实分析：对比不同决策路径的结果
   * @returns {object[]}
   */
  function buildCounterfactualAnalysis() {
    const cfData = scenarioData.counterfactual_analysis || [];
    const studentOption = typeof session.d2Decision === 'string'
      ? session.d2Decision
      : (session.d2Decision && (session.d2Decision.option || session.d2Decision.d2_option)) || '';

    // 找到与学生决策匹配的反事实条目
    const matched = cfData.filter((cf) => cf.option === studentOption);

    // 构造所有反事实场景的对比
    return cfData.map((cf) => {
      const isStudentChoice = cf.option === studentOption;
      return {
        option: cf.option,
        condition: cf.condition,
        result: cf.result,
        isStudentChoice,
        studentFacts: session.acquiredFacts.slice(),
      };
    });
  }

  /**
   * 构造改进建议
   * @param {object} scoring - 评分结果
   * @param {object} constraintResults - 约束检查结果
   * @param {object} resultResults - 结果规则结果
   * @returns {string[]}
   */
  function buildImprovementSuggestions(scoring, constraintResults, resultResults) {
    const suggestions = [];

    // 基于约束违反
    if (constraintResults && constraintResults.violated) {
      for (const v of constraintResults.violated) {
        suggestions.push(`【约束${v.id}】${v.detail}。建议：${v.knowledgePoint || '加强相关理论学习'}`);
      }
    }

    // 基于评分短板
    const dims = scoring.dimensions || {};
    for (const [dimName, dimData] of Object.entries(dims)) {
      if (dimData.percentage < 60) {
        const dimLabels = {
          user_insight: '用户洞察',
          decision_quality: '决策质量',
          communication: '沟通能力',
          business_balance: '商业平衡',
          growth_reflection: '成长反思',
        };
        suggestions.push(`【${dimLabels[dimName] || dimName}】得分偏低（${dimData.percentage}%），建议加强该维度能力`);
      }
    }

    // 基于结果盲区
    if (resultResults) {
      if (resultResults.rollback && resultResults.rollback.blindSpot) {
        suggestions.push('【应急盲区】未获取 F-12 止血能力信息，建议在决策前确认回滚能力');
      }
      if (resultResults.loss && resultResults.loss.blindSpot) {
        suggestions.push('【商业盲区】未获取 F-08 总损失信息，建议追问隐性成本');
      }
      if (resultResults.strategic && resultResults.strategic.blindSpot) {
        suggestions.push('【战略盲区】未获取 F-14 竞品情报，建议关注战略维度');
      }
    }

    // 基于访谈覆盖
    const interviewedRoles = new Set(session.interviewLog.map((e) => e.roleId));
    const missingRoles = ROLES.filter((r) => !interviewedRoles.has(r.id));
    if (missingRoles.length > 0) {
      suggestions.push(`【访谈覆盖不足】未访谈角色：${missingRoles.map((r) => r.name).join('、')}，建议全面收集干系人信息`);
    }

    // 基于信任变化
    const trustChanges = session.relationshipEngine.getTrustNetChanges();
    const negativeRoles = Object.entries(trustChanges).filter(([, v]) => v.netChange < 0);
    if (negativeRoles.length > 0) {
      suggestions.push(`【关系维护】以下角色信任度下降：${negativeRoles.map(([id, v]) => `${v.roleName}(${v.netChange})`).join('、')}，建议改善沟通方式`);
    }

    // 如果没有问题
    if (suggestions.length === 0) {
      suggestions.push('表现优秀，各维度均达到要求，继续保持');
    }

    return suggestions;
  }

  // 返回引擎接口
  return {
    startSession,
    processMessage,
    submitD1,
    submitD2,
    getReport,
    getState,
    // 暴露底层引擎实例（供高级用法）
    get stateEngine() { return session.stateEngine; },
    get relationshipEngine() { return session.relationshipEngine; },
    // 暴露场景数据
    scenarioData,
  };
}

module.exports = {
  createEngine,
  // 也导出一个便捷的默认引擎（单例模式）
  defaultEngine: null, // 使用时通过 createEngine() 创建
};
