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
 * @param {object} [options] - 可选配置
 * @param {function} [options.llmIntentClassifier] - LLM 意图分类函数 (message, context) => intentString
 * @param {number} [options.llmDecisionScore] - LLM 决策质量评分 (0-100)
 * @param {number} [options.llmReflectionScore] - LLM 成长反思评分 (0-100)
 * @param {string} [options.reflectionText] - 学生复盘文字
 * @returns {object} 引擎接口对象
 */
function createEngine(options) {
  options = options || {};
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

    // 已展示的弱信号 factId 集合（避免重复展示）
    shownWeakSignals: new Set(),

    // 对话历史（按角色分组）：每个角色记录被问过的问题和披露的事实
    roleConversationHistory: {}, // { R1: [{ message, actionType, disclosedFacts, topics, timestamp }], ... }

    // 已承认的冲突（避免重复承认）
    acknowledgedConflicts: new Set(),

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
    session.shownWeakSignals = new Set();
    // 对话历史
    session.roleConversationHistory = {};
    // 已承认的冲突
    session.acknowledgedConflicts = new Set();
    // 面包屑追踪：factId → 当前轮次（0=未开始，1=已展示第1级，2=已展示第2级）
    session.breadcrumbProgress = {};
    // 已通过面包屑保证披露的事实
    session.breadcrumbDisclosed = new Set();

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
   * @param {string} [preclassifiedIntent] - 外部 LLM 预分类意图（可选，跳过内置分类）
   * @returns {{actionType:string, trustChange:object, disclosedFacts:string[], formalInquiry:object, response:string}}
   */
  function processMessage(roleId, studentMessage, preclassifiedIntent) {
    if (!session.started) {
      throw new Error('会话未初始化，请先调用 startSession()');
    }

    const relEngine = session.relationshipEngine;
    const stateEngine = session.stateEngine;

    // 1. 意图分类：优先使用 LLM 预分类 → options.llmIntentClassifier → 关键词匹配
    let actionType;
    if (preclassifiedIntent) {
      actionType = preclassifiedIntent;
    } else if (typeof options.llmIntentClassifier === 'function') {
      actionType = options.llmIntentClassifier(studentMessage, {
        roleId,
        acquiredFacts: session.acquiredFacts.slice(),
        d1Choice: session.d1Choice,
      });
    } else {
      actionType = relEngine.inferActionType(studentMessage);
    }

    // 1b. 超纲提问检测：如果学生向当前角色提出了不属于其领域的问题，覆盖动作类型
    const outOfScopeInfo = relEngine.detectOutOfScope(roleId, studentMessage);
    let isOutOfScope = false;
    if (outOfScopeInfo.isOutOfScope) {
      // 超纲提问不覆盖冒犯性表达（冒犯更严重）
      if (actionType !== 'offensive_expression') {
        actionType = 'out_of_scope_questioning';
        isOutOfScope = true;
      }
    }

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

    // 3d. 面包屑系统：对未通过正常路径披露的事实，检查面包屑推进
    const breadcrumbSignals = []; // 本轮要展示的面包屑信号
    for (const fact of roleFacts) {
      // 跳过已获取的事实
      if (session.acquiredFacts.indexOf(fact.id) >= 0) continue;
      // 跳过已通过正式质询处理的事实
      if (formalInquiry.canDiscloseFacts.indexOf(fact.id) >= 0) continue;
      // 只处理有面包屑的事实
      if (!fact.breadcrumbs) continue;

      const currentRound = session.breadcrumbProgress[fact.id] || 0;
      const nextBreadcrumb = relEngine.getCurrentBreadcrumb(fact.id, currentRound);

      if (!nextBreadcrumb) continue; // 面包屑已走完

      // 检查学生消息是否匹配面包屑触发条件
      const triggered = relEngine.matchBreadcrumbTrigger(
        studentMessage, actionType, nextBreadcrumb
      );

      if (triggered) {
        // 推进面包屑轮次
        session.breadcrumbProgress[fact.id] = nextBreadcrumb.round;

        if (nextBreadcrumb.guaranteed_disclose) {
          // 到达保证披露层级：直接披露事实，绕过信任档位
          if (session.acquiredFacts.indexOf(fact.id) < 0) {
            session.acquiredFacts.push(fact.id);
            disclosedFacts.push(fact.id);
            session.breadcrumbDisclosed.add(fact.id);
            relEngine.markDisclosed(roleId, fact.id);
            disclosureDetails.push({
              factId: fact.id,
              source: 'breadcrumb_guaranteed',
              breadcrumbRound: nextBreadcrumb.round,
              fact,
            });
          }
        } else {
          // 未到达保证披露：展示面包屑信号
          breadcrumbSignals.push({
            factId: fact.id,
            signal: nextBreadcrumb.signal,
            round: nextBreadcrumb.round,
          });
          disclosureDetails.push({
            factId: fact.id,
            source: 'breadcrumb_signal',
            breadcrumbRound: nextBreadcrumb.round,
            signal: nextBreadcrumb.signal,
          });
        }
      }
    }

    // 4. 检查交叉验证：学生是否对同一事实从不同角色获取信息
    // 简化逻辑：如果学生在不同角色的对话中提到了同一事实
    checkCrossValidation(roleId, disclosedFacts);

    // 4b. 检测跨角色事实引用：学生是否在消息中提及了从其他角色获取的事实
    const crossRoleRefs = detectCrossRoleReferences(roleId, studentMessage);

    // 5b. 检测重复提问：必须在更新对话历史之前检测
    const repeatInfo = detectRepeatQuestion(roleId, studentMessage, actionType, disclosedFacts);

    // 5. 记录访谈日志和对话历史
    const logEntry = {
      timestamp: new Date().toISOString(),
      roleId,
      studentMessage,
      actionType,
      trustChange,
      disclosedFacts: disclosedFacts.slice(),
      formalInquiryMatched: formalInquiry.matchedRules,
    };
    session.interviewLog.push(logEntry);

    // 更新角色对话历史
    if (!session.roleConversationHistory[roleId]) {
      session.roleConversationHistory[roleId] = [];
    }
    const topicsCovered = disclosedFacts.slice();
    // 也记录消息涉及的话题关键词（从已讨论的事实中提取）
    for (const factId of session.acquiredFacts) {
      const fact = getFactDef(factId);
      if (fact && fact.holder === roleId) {
        const kws = extractFactKeywords(fact);
        if (kws.some(kw => studentMessage.indexOf(kw) >= 0)) {
          if (topicsCovered.indexOf(factId) < 0) topicsCovered.push(factId);
        }
      }
    }
    session.roleConversationHistory[roleId].push({
      message: studentMessage,
      actionType,
      disclosedFacts: disclosedFacts.slice(),
      topics: topicsCovered,
      timestamp: logEntry.timestamp,
    });

    // 6. 构造角色回复
    const role = ROLES.find((r) => r.id === roleId);
    let response = '';

    // 6a. 检测立场冲突：学生持有的其他角色事实是否打脸当前角色
    const stanceConflicts = relEngine.detectStanceConflict(roleId, session.acquiredFacts);
    let conflictPrefix = '';
    const newConflicts = [];
    if (stanceConflicts.length > 0) {
      for (const sc of stanceConflicts) {
        const key = `${roleId}:${sc.factId}`;
        if (!session.acknowledgedConflicts.has(key)) {
          session.acknowledgedConflicts.add(key);
          newConflicts.push(sc);
        }
      }
      if (newConflicts.length > 0) {
        conflictPrefix = newConflicts.map((c) => c.acknowledgment).join(' ');
      }
    }

    // 6a-2. 低信任态度判断：使用动作前的信任值（否则第一次超纲扣分后就会触发低信任）
    const trustBeforeAction = trustChange.oldValue;
    const isLowTrust = trustBeforeAction < 50;
    const isResistant = trustBeforeAction < 30; // 抵触档：更严重的低信任
    const roleDef = ROLES.find((r) => r.id === roleId);
    const lowTrustResponses = roleDef && roleDef.low_trust_responses ? roleDef.low_trust_responses : null;

    /**
     * 根据场景选择低信任前缀/回复
     * @param {string} scene - 场景: default|out_of_scope|repeat|breadcrumb|weak_signal|no_info|cross_role
     * @returns {string} 低信任前缀文本（空字符串如果无配置）
     */
    function getLowTrustPrefix(scene) {
      if (!isLowTrust || !lowTrustResponses) return '';
      // 抵触档优先使用 resistant_ 前缀
      if (isResistant) {
        const resistantKey = `resistant_${scene}`;
        if (lowTrustResponses[resistantKey]) return lowTrustResponses[resistantKey];
        if (lowTrustResponses.resistant_default) return lowTrustResponses.resistant_default;
      }
      // 中性低档使用场景专属前缀
      if (lowTrustResponses[scene]) return lowTrustResponses[scene];
      return lowTrustResponses.default || '';
    }

    // 6a-3. 优先级 0：超纲提问 → 直接返回超纲回复（不进入正常披露流程）
    if (isOutOfScope && !crossRoleRefs.length) {
      let oosResponse;
      if (isLowTrust) {
        // 低信任 + 超纲：使用场景专属超纲回复
        oosResponse = getLowTrustPrefix('out_of_scope') || roleDef.out_of_scope_response || '这个问题不在我的职责范围内';
      } else if (roleDef.out_of_scope_response) {
        oosResponse = roleDef.out_of_scope_response;
      } else {
        oosResponse = '这个问题不在我的职责范围内，你可以去问问对应的人';
      }

      response = `${role.name}：${oosResponse}`;

      return {
        actionType,
        trustChange,
        disclosedFacts: [],
        disclosureDetails: [],
        formalInquiry: { matchedRules: [], canDiscloseFacts: [], details: [] },
        response,
        acquiredFactsCount: session.acquiredFacts.length,
        stanceConflicts: newConflicts,
        conflictAcknowledged: false,
        breadcrumbSignals: [],
        breadcrumbProgress: Object.assign({}, session.breadcrumbProgress),
        crossRoleReferences: crossRoleRefs,
        isRepeat: false,
        isOutOfScope: true,
        outOfScopeMatchedRole: outOfScopeInfo.matchedRole,
        isLowTrust,
        isResistant,
      };
    }

    // 6b. 优先级 1：跨角色事实引用 → 角色做出针对性反应
    if (crossRoleRefs.length > 0 && !repeatInfo.isRepeat) {
      const roleDef = ROLES.find((r) => r.id === roleId);
      const reactions = crossRoleRefs
        .map((ref) => {
          if (roleDef.cross_role_reactions && roleDef.cross_role_reactions[ref.factId]) {
            return roleDef.cross_role_reactions[ref.factId];
          }
          return null;
        })
        .filter(Boolean);

      if (reactions.length > 0) {
        // 低信任跨角色前缀
        const crossRolePrefix = getLowTrustPrefix('cross_role');
        // 如果同时有新披露的事实，先说事实再说跨角色反应
        if (disclosedFacts.length > 0) {
          const factContents = disclosedFacts.map((fid) => {
            const f = getFactDef(fid);
            let line = f ? `[${fid}] ${f.content}` : fid;
            const stance = relEngine.getStanceReaction(roleId, fid);
            if (stance) line += `（${stance}）`;
            return line;
          });
          response = `${role.name}：${conflictPrefix ? conflictPrefix + ' ' : ''}${crossRolePrefix ? crossRolePrefix + ' ' : ''}${factContents.join('；')}。${reactions[0]}`;
        } else {
          response = `${role.name}：${conflictPrefix ? conflictPrefix + ' ' : ''}${crossRolePrefix ? crossRolePrefix + ' ' : ''}${reactions.join(' ')}`;
        }

        // 记录跨角色引用为交叉验证
        for (const ref of crossRoleRefs) {
          if (ref.factId !== roleId) {
            session.crossValidationCount += 1;
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
          stanceConflicts: newConflicts,
          conflictAcknowledged: conflictPrefix.length > 0,
          breadcrumbSignals,
          breadcrumbProgress: Object.assign({}, session.breadcrumbProgress),
          crossRoleReferences: crossRoleRefs,
          isRepeat: false,
        };
      }
    }

    // 6c. 优先级 2：重复提问 → 使用 repeat_responses
    if (repeatInfo.isRepeat && disclosedFacts.length === 0) {
      const roleDef = ROLES.find((r) => r.id === roleId);
      let repeatResponse = null;

      if (roleDef.repeat_responses) {
        // 如果能匹配到具体事实的重复响应
        if (repeatInfo.relatedFactId && roleDef.repeat_responses[repeatInfo.relatedFactId]) {
          repeatResponse = roleDef.repeat_responses[repeatInfo.relatedFactId];
        }
        // 否则使用默认重复响应
        if (!repeatResponse && roleDef.repeat_responses.default) {
          repeatResponse = roleDef.repeat_responses.default;
        }
      }

      if (repeatResponse) {
        // 低信任重复提问前缀
        const repeatPrefix = getLowTrustPrefix('repeat');
        response = `${role.name}：${conflictPrefix ? conflictPrefix + ' ' : ''}${repeatPrefix ? repeatPrefix + ' ' : ''}${repeatResponse}`;
        return {
          actionType,
          trustChange,
          disclosedFacts,
          disclosureDetails,
          formalInquiry,
          response,
          acquiredFactsCount: session.acquiredFacts.length,
          stanceConflicts: newConflicts,
          conflictAcknowledged: conflictPrefix.length > 0,
          breadcrumbSignals,
          breadcrumbProgress: Object.assign({}, session.breadcrumbProgress),
          crossRoleReferences: crossRoleRefs,
          isRepeat: true,
          repeatTarget: repeatInfo.relatedFactId,
        };
      }
    }

    // 6d. 优先级 3：正常事实披露响应（原有逻辑）
    // 低信任态度前缀：按场景选择不同前缀
    let lowTrustPrefix = '';
    if (isLowTrust) {
      if (disclosedFacts.length > 0) {
        // 有事实披露 → 使用默认低信任前缀
        lowTrustPrefix = getLowTrustPrefix('default');
      } else if (breadcrumbSignals.length > 0) {
        // 只有面包屑 → 面包屑场景
        lowTrustPrefix = getLowTrustPrefix('breadcrumb');
      }
    }

    if (disclosedFacts.length > 0) {
      const factContents = disclosedFacts.map((fid) => {
        const f = getFactDef(fid);
        let line = f ? `[${fid}] ${f.content}` : fid;
        // 追加立场修饰语（角色对该事实的立场表态）
        const stance = relEngine.getStanceReaction(roleId, fid);
        if (stance) line += `（${stance}）`;
        return line;
      });
      response = `${role ? role.name : roleId}：${conflictPrefix ? conflictPrefix + ' ' : ''}${lowTrustPrefix ? lowTrustPrefix + ' ' : ''}${factContents.join('；')}`;
    } else if (breadcrumbSignals.length > 0) {
      // 优先展示面包屑信号（比弱信号更具体）
      const bc = breadcrumbSignals[0];
      response = `${role ? role.name : roleId}：${conflictPrefix ? conflictPrefix + ' ' : ''}${lowTrustPrefix ? lowTrustPrefix + ' ' : ''}（线索）${bc.signal}`;
    } else {
      // 未披露新事实时，给出弱信号提示
      // 仅展示：有弱信号 + 学生尚未获取该事实 + 本轮尚未展示过
      const weakSignalFacts = roleFacts.filter(
        (f) => f.weak_signal && !f.breadcrumbs && session.acquiredFacts.indexOf(f.id) < 0
      );
      if (weakSignalFacts.length > 0 && trustChange.newTier !== '抵触') {
        // 优先展示尚未展示过的弱信号
        const freshSignal = weakSignalFacts.find(
          (f) => !session.shownWeakSignals.has(f.id)
        );
        const signalFact = freshSignal || weakSignalFacts[0];
        const ws = signalFact.weak_signal;
        session.shownWeakSignals.add(signalFact.id);
        // 低信任弱信号前缀
        const weakPrefix = getLowTrustPrefix('weak_signal');
        response = `${role ? role.name : roleId}：${conflictPrefix ? conflictPrefix + ' ' : ''}${weakPrefix ? weakPrefix + ' ' : ''}（弱信号）${ws}`;
      } else if (conflictPrefix) {
        // 没有新事实但有冲突承认
        response = `${role ? role.name : roleId}：${conflictPrefix}`;
      } else if (isLowTrust) {
        // 低信任 + 无新信息：场景专属无信息回复
        const noInfoPrefix = getLowTrustPrefix('no_info');
        const noInfoFallback = isResistant ? '我没什么好说的。' : '我目前没有更多信息可以提供。';
        response = `${role ? role.name : roleId}：${noInfoPrefix || noInfoFallback}`;
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
      // 立场化信息
      stanceConflicts: newConflicts,
      conflictAcknowledged: conflictPrefix.length > 0,
      // 面包屑信息
      breadcrumbSignals,
      breadcrumbProgress: Object.assign({}, session.breadcrumbProgress),
      // 跨角色引用信息
      crossRoleReferences: crossRoleRefs,
      // 重复提问信息
      isRepeat: repeatInfo.isRepeat,
      // 超纲提问信息
      isOutOfScope: false,
      outOfScopeMatchedRole: null,
      // 低信任信息
      isLowTrust,
      isResistant,
    };
  }

  /**
   * 检测跨角色事实引用：学生消息中是否提及了从其他角色获取的事实
   * @param {string} currentRoleId - 当前对话角色 ID
   * @param {string} studentMessage - 学生消息
   * @returns {object[]} 跨角色引用列表 { factId, factContent, fromRole, matchedKeyword }
   */
  function detectCrossRoleReferences(currentRoleId, studentMessage) {
    const refs = [];
    const msg = studentMessage.toLowerCase();

    for (const factId of session.acquiredFacts) {
      const fact = getFactDef(factId);
      if (!fact) continue;
      // 只检测来自其他角色的事实
      if (fact.holder === currentRoleId || fact.holder === 'ALL') continue;
      // 初始可见的事实不算跨角色引用
      if (fact.access_level === 'L0' || fact.disclosure_condition === 'initial_visible') continue;

      // 检查学生消息是否提及该事实的关键词
      const keywords = extractFactKeywords(fact);
      const matchedKeyword = keywords.find((kw) => msg.indexOf(kw.toLowerCase()) >= 0);

      if (matchedKeyword) {
        refs.push({
          factId,
          factContent: fact.content,
          fromRole: fact.holder,
          matchedKeyword,
        });
      }
    }

    return refs;
  }

  /**
   * 检测重复提问：当前消息是否与之前问过同一角色的问题类似
   * @param {string} roleId - 当前角色 ID
   * @param {string} message - 学生消息
   * @param {string} actionType - 当前意图类型
   * @param {string[]} disclosedFacts - 本轮新披露的事实
   * @returns {{isRepeat:boolean, relatedFactId:string|null, previousMessage:string|null}}
   */
  function detectRepeatQuestion(roleId, message, actionType, disclosedFacts) {
    const history = session.roleConversationHistory[roleId];
    if (!history || history.length === 0) {
      return { isRepeat: false, relatedFactId: null, previousMessage: null };
    }

    // 如果本轮有新事实披露，不算重复
    if (disclosedFacts && disclosedFacts.length > 0) {
      return { isRepeat: false, relatedFactId: null, previousMessage: null };
    }

    const msg = message.toLowerCase();

    // 检查是否与历史消息在话题上重叠
    for (const entry of history) {
      // 如果之前的问题也披露了事实，且当前消息涉及相同话题
      if (entry.topics && entry.topics.length > 0) {
        for (const topicFactId of entry.topics) {
          const fact = getFactDef(topicFactId);
          if (!fact) continue;

          // 检查当前消息是否涉及该话题的关键词
          const keywords = extractFactKeywords(fact);
          const matched = keywords.some((kw) => msg.indexOf(kw.toLowerCase()) >= 0);

          if (matched) {
            return {
              isRepeat: true,
              relatedFactId: topicFactId,
              previousMessage: entry.message,
            };
          }
        }
      }

      // 完全相同的消息
      if (entry.message.toLowerCase() === msg) {
        return {
          isRepeat: true,
          relatedFactId: null,
          previousMessage: entry.message,
        };
      }

      // 相同的意图类型 + 消息相似度高（简单：共享 2+ 个关键词）
      if (entry.actionType === actionType && entry.message.length > 0) {
        const prevWords = new Set(entry.message.split(/\s+/));
        const currWords = new Set(message.split(/\s+/));
        let overlap = 0;
        for (const w of currWords) {
          if (w.length >= 2 && prevWords.has(w)) overlap++;
        }
        if (overlap >= 2) {
          return {
            isRepeat: true,
            relatedFactId: null,
            previousMessage: entry.message,
          };
        }
      }
    }

    return { isRepeat: false, relatedFactId: null, previousMessage: null };
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
      const c = fact.content;
      // 按标点和空格分割
      const segments = c.split(/[，。、；,.;：:\s]+/);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (trimmed.length >= 2 && trimmed.length <= 8) {
          keywords.push(trimmed);
        }
        // 对长度 >= 3 的段，提取前 2-3 字作为短关键词
        if (trimmed.length >= 3) {
          keywords.push(trimmed.substring(0, 2));
          if (trimmed.length >= 4) keywords.push(trimmed.substring(0, 3));
        }
      }
    }
    // 从 disclosure_action 中提取
    if (fact.disclosure_action) {
      keywords.push(fact.disclosure_action);
    }
    // 从事实 id 中提取
    keywords.push(fact.id);
    // 如果有 teaching_point，也提取关键词
    if (fact.teaching_point) {
      const tpSegs = fact.teaching_point.split(/[，。、；,.;：:\s]+/);
      for (const seg of tpSegs) {
        if (seg.length >= 2 && seg.length <= 6) keywords.push(seg);
      }
    }
    // 去重
    return [...new Set(keywords)];
  }

  /**
   * 检查交叉验证
   * 三层检测：直接重复引用 + 冲突事实识别 + 同维度跨角色验证
   * @param {string} currentRoleId
   * @param {string[]} newlyDisclosedFacts
   */
  function checkCrossValidation(currentRoleId, newlyDisclosedFacts) {
    for (const factId of newlyDisclosedFacts) {
      const fact = getFactDef(factId);
      if (!fact) continue;

      // 1. 直接交叉验证：同一事实在其他角色的对话中也被提到
      const otherRoleMentions = session.interviewLog.filter(
        (entry) => entry.roleId !== currentRoleId && entry.disclosedFacts.indexOf(factId) >= 0
      );
      if (otherRoleMentions.length > 0) {
        session.crossValidationCount += 1;
      }

      // 2. 冲突识别：学生获取了与当前事实冲突的其他事实（来自不同角色）
      if (fact.conflicts_with) {
        const conflictId = fact.conflicts_with;
        if (session.acquiredFacts.indexOf(conflictId) >= 0) {
          const conflictFact = getFactDef(conflictId);
          const conflictKey = [factId, conflictId].sort().join('↔');
          if (!session.identifiedConflicts) session.identifiedConflicts = new Set();
          if (!session.identifiedConflicts.has(conflictKey)) {
            session.identifiedConflicts.add(conflictKey);
            session.crossValidationCount += 1;
          }
        }
      }

      // 3. 同维度跨角色验证：同一评分维度的事实来自不同角色
      if (fact.scoring_dimension) {
        const sameDimFromOthers = session.acquiredFacts.filter((fid) => {
          if (fid === factId) return false;
          const f = getFactDef(fid);
          return f && f.scoring_dimension === fact.scoring_dimension && f.holder !== currentRoleId && f.holder !== 'ALL';
        });
        if (sameDimFromOthers.length > 0) {
          session._cvDimensionsChecked = session._cvDimensionsChecked || new Set();
          const dimKey = `${fact.scoring_dimension}_${currentRoleId}`;
          if (!session._cvDimensionsChecked.has(dimKey)) {
            session._cvDimensionsChecked.add(dimKey);
            session.crossValidationCount += 1;
          }
        }
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
      // LLM 评分注入（由外部通过 options 或 setLLMScores 提供）
      llmDecisionScore: session.llmDecisionScore !== undefined ? session.llmDecisionScore : options.llmDecisionScore,
      llmReflectionScore: session.llmReflectionScore !== undefined ? session.llmReflectionScore : options.llmReflectionScore,
      reflectionText: session.reflectionText || options.reflectionText || '',
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
    // LLM 评分注入接口（供外部在复盘阶段注入 LLM 评分）
    setLLMScores(scores) {
      if (scores.llmDecisionScore !== undefined) session.llmDecisionScore = scores.llmDecisionScore;
      if (scores.llmReflectionScore !== undefined) session.llmReflectionScore = scores.llmReflectionScore;
      if (scores.reflectionText !== undefined) session.reflectionText = scores.reflectionText;
    },
    // 获取当前意图分类模式
    get intentClassifierMode() {
      if (typeof options.llmIntentClassifier === 'function') return 'llm';
      return 'keyword_fallback';
    },
  };
}

module.exports = {
  createEngine,
  // 也导出一个便捷的默认引擎（单例模式）
  defaultEngine: null, // 使用时通过 createEngine() 创建
};
