/**
 * server.js - CareerCraft 后端 API 层
 *
 * 基于 Express 封装引擎接口，为前端提供 RESTful API。
 *
 * API 端点一览：
 *   公共接口：
 *     GET  /api/health                     健康检查
 *     GET  /api/scenario                   场景元数据（角色列表、时间线、决策节点）
 *
 *   会话管理：
 *     POST /api/sessions                   创建新会话（初始化引擎）
 *     GET  /api/sessions/:sessionId        获取当前状态快照
 *     DELETE /api/sessions/:sessionId      销毁会话
 *
 *   核心交互：
 *     POST /api/sessions/:sessionId/messages           处理学生提问（访谈）
 *     POST /api/sessions/:sessionId/decisions/d1       提交 D1 决策
 *     POST /api/sessions/:sessionId/decisions/d2       提交 D2 决策
 *     GET  /api/sessions/:sessionId/report             获取完整复盘报告
 *     POST /api/sessions/:sessionId/llm-scores         注入 LLM 评分（复盘阶段）
 *
 *   辅助接口：
 *     GET  /api/sessions/:sessionId/roles               获取角色列表
 *     GET  /api/sessions/:sessionId/facts               获取已获取事实详情
 *     GET  /api/sessions/:sessionId/interview-log       获取访谈日志
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createEngine } = require('../engine');
const {
  createLLMClient,
  classifyIntent,
  createEngineIntentClassifier,
  scoreDecision,
  scoreReflection,
  generateRoleResponse,
} = require('./llm-adapter');

// 角色提示词构建器（用于 LLM 角色扮演）
const techLeadPrompt = require('../engine/agent_prompts/tech_lead');
const qaLeadPrompt = require('../engine/agent_prompts/qa_lead');
const opsLeadPrompt = require('../engine/agent_prompts/ops_lead');
const ceoPrompt = require('../engine/agent_prompts/ceo');

// 角色 ID → 提示词构建器映射
const ROLE_PROMPT_BUILDERS = {
  R1: techLeadPrompt,
  R2: qaLeadPrompt,
  R3: opsLeadPrompt,
  R4: ceoPrompt,
};

const app = express();

// ============ LLM 客户端初始化 ============
const llmClient = createLLMClient();
const llmEnabled = !!llmClient;
console.log(`[LLM] LLM 适配器: ${llmEnabled ? '已启用' : '未启用（使用关键词兜底）'}`);

// ============ LLM 角色回复器 ============

/**
 * 构建引擎回复指令（简短自然，告知 LLM 本轮回复要点）
 *
 * 引擎已经确定了信息披露、信任档位、特殊检测等游戏逻辑结果，
 * 通过简短指令传递给 LLM，让 LLM 在此框架内生成自然对话。
 *
 * @param {object} ctx - 上下文 { engineResult, currentTrust, trustTier, acquiredFacts, d1Choice, scenarioData }
 * @returns {string} 回复指令文本
 */
function buildResponseDirective(ctx) {
  const result = ctx.engineResult;
  const scenarioData = ctx.scenarioData;
  const lines = [];

  // 特殊情况优先处理
  if (result.isOutOfScope) {
    const roleMap = { R1: '技术负责人沈屹', R2: 'QA负责人闻笛', R3: '运营负责人江照', R4: 'CEO许可' };
    lines.push(`这个问题不在你的职责范围内，建议学生去找${roleMap[result.outOfScopeMatchedRole] || '对应的人'}。用你的角色语气拒绝回答。`);
  } else if (result.isRepeat) {
    lines.push('学生重复问了之前回答过的问题。简短提醒学生你已经说过了，根据信任档位决定耐心程度。');
  } else if (result.crossRoleReferences && result.crossRoleReferences.length > 0) {
    const refs = result.crossRoleReferences.map(r => {
      const fact = (scenarioData.facts || []).find(f => f.id === r.factId);
      return fact ? fact.content : r.factContent;
    });
    lines.push(`学生在提问中引用了从其他角色获取的信息：${refs.join('；')}。对此做出自然反应——可以承认对方数据，也可以表达自己的立场。`);
  }

  // 需要披露的事实
  if (result.disclosedFacts && result.disclosedFacts.length > 0) {
    const factContents = result.disclosedFacts.map(fid => {
      const fact = (scenarioData.facts || []).find(f => f.id === fid);
      return fact ? fact.content : null;
    }).filter(Boolean);
    if (factContents.length > 0) {
      lines.push(`本轮你需要在对话中自然提及以下信息（用角色口吻表达，不要引用事实编号）：${factContents.join('；')}`);
    }
  }

  // 面包屑/线索
  if (result.breadcrumbSignals && result.breadcrumbSignals.length > 0) {
    const signals = result.breadcrumbSignals.map(s => s.signal);
    lines.push(`自然地给出以下线索暗示：${signals.join('；')}`);
  }

  // 低信任无信息时的行为
  if (result.isLowTrust && !(result.disclosedFacts && result.disclosedFacts.length > 0)) {
    if (result.isResistant) {
      lines.push('你处于抵触状态，简短拒绝或表达不满。');
    } else {
      lines.push('你处于低信任状态，消极地表示没有更多信息。');
    }
  }

  // 通用要求（简短）
  lines.push('回复时用角色语气自然对话，不要暴露事实编号和信任度数值。');

  return lines.length > 1 ? lines.join('\n') : (lines[0] || '');
}

/**
 * 构建精简版角色系统提示词（避免过长提示词导致 LLM 回复过短）
 * 保留角色人设核心 + 关键事实 + 信任档位行为规则
 * @param {string} roleId - 角色ID
 * @param {number} trust - 当前信任值
 * @param {string[]} acquiredFacts - 已获取事实列表
 * @param {object} scenarioData - 场景数据
 * @returns {string} 精简系统提示词
 */
function buildCompactRolePrompt(roleId, trust, acquiredFacts, scenarioData) {
  const role = (scenarioData.roles || []).find(r => r.id === roleId);
  const roleFacts = (scenarioData.facts || []).filter(f => f.holder === roleId);
  const publicFacts = (scenarioData.facts || []).filter(f => f.holder === 'ALL' || f.access_level === 'L0');
  const tier = trust < 30 ? '抵触' : trust < 50 ? '失望' : trust < 70 ? '中性' : trust < 90 ? '配合' : '信任';

  // 角色人设摘要
  const personaMap = {
    R1: { name: '沈屹', title: '技术负责人', personality: '沉静、系统思维强，习惯用数字说话但不会主动展开全部细节。回答偏内敛，给出关键数字后会停顿等待追问。', stance: '先把缺陷修了再说。不修就上Go全量你不同意，但灰度+预案可以接受。', domain: '技术方案和系统稳定性' },
    R2: { name: '闻笛', title: 'QA负责人', personality: '严谨、直率，对质量底线毫不妥协。会用数据说话，不会被"感觉安全"说服。', stance: '质量底线不能突破。缺陷必须修复或绕过，不能带病上线。', domain: '质量保障和缺陷验证' },
    R3: { name: '江照', title: '运营负责人', personality: '务实、结果导向，关注商业损失和用户体验。会推动快速决策。', stance: '按时上线，商业损失不可接受。但如果有稳妥的降级方案也可以接受。', domain: '运营策略和商业损失' },
    R4: { name: '许可', title: 'CEO', personality: '宏观、战略导向，回答偏高层视角。对技术细节不熟悉，但对市场态势有独到判断。说话简洁有力。', stance: '不能因为保守错过窗口，但也不能翻车。支持专业判断。', domain: '战略方向和竞争格局' },
  };
  const p = personaMap[roleId] || { name: role?.name || roleId, title: role?.title || '', personality: '', stance: '', domain: '' };

  // 信任档位行为
  const tierBehaviors = {
    '抵触': '极度不配合、防御、冷淡。回答极简，不主动补充，可能表达不满。弱信号减少。',
    '失望': '消极、不展开。偶尔表达失望，弱信号减少。',
    '中性': '职业、保留。正常回答但不展开，可暗示风险存在但不给具体数字。',
    '配合': '友好、配合。回答详细，主动补充关联信息。弱信号增加。',
    '信任': '坦诚、主动。主动给出未问到的信息，分享个人判断。',
  };

  // 格式化事实列表：已获取的显示完整内容，未获取的只显示弱信号
  const publicFactsText = publicFacts.map(f => `- ${f.content}`).join('\n');
  const roleFactsText = roleFacts.map(f => {
    const acquired = acquiredFacts.includes(f.id);
    if (acquired) {
      return `- ${f.content}（已获取，可自由讨论）`;
    }
    // 未获取的事实：只显示弱信号，不显示完整内容
    if (f.weak_signal) {
      return `- 未公开信息。弱信号暗示方式：${f.weak_signal}`;
    }
    return `- 未公开信息。学生追问相关话题时可暗示"这个问题确实关键，需要进一步确认"。`;
  }).join('\n');

  return [
    `# 角色身份`,
    `你是${p.name}，「星盘结算」（支付链路SaaS产品）的${p.title}。`,
    `场景：上线前夜，产品计划明日09:00上线。新引擎核心支付接口存在已知缺陷。`,
    ``,
    `## 性格与立场`,
    `性格：${p.personality}`,
    `立场：${p.stance}`,
    `职责范围：${p.domain}。不属于你领域的问题，引导学生去找对应的人。`,
    ``,
    `## 当前信任档位：${tier}（信任值约${trust}/100，不要透露数值）`,
    `行为要求：${tierBehaviors[tier]}`,
    ``,
    `## 公开事实（所有人可知）`,
    publicFactsText,
    ``,
    `## 你持有的私有事实`,
    roleFactsText || '（无）',
    ``,
    `## 核心规则`,
    `1. 已标注"已获取"的事实可以自由讨论。未标注的事实，只能给弱信号暗示，严禁直接说出具体内容或数字。`,
    `2. 严禁创造上述事实以外的任何数据。如果学生问的不在你的事实列表中，说"这个数据我目前手上没有"或"需要进一步确认"。`,
    `3. 不要泄露其他角色（R1沈屹/R2闻笛/R3江照/R4许可）的私有信息。`,
    `4. 用角色语气自然对话，不要像在念清单。`,
    `5. 不要暴露事实编号、信任度数值等元信息。`,
  ].join('\n');
}

/**
 * 创建 LLM 角色回复器
 * 每个角色使用独立的系统提示词和对话记忆，确保角色间信息隔离。
 *
 * @param {object} client - LLM 客户端
 * @param {object} scenarioData - 场景数据（用于查询事实内容）
 * @returns {function|null} 异步角色回复函数
 */
function createRoleResponder(client, scenarioData) {
  if (!client) return null;

  return async function llmRoleResponder(params) {
    const { roleId, conversationHistory, studentMessage, currentTrust, acquiredFacts, d1Choice } = params;

    // 构建精简版系统提示词
    const systemPrompt = buildCompactRolePrompt(roleId, currentTrust, acquiredFacts, scenarioData);

    // 构建引擎回复指令
    const responseDirective = buildResponseDirective({
      engineResult: params.engineResult,
      currentTrust,
      trustTier: params.trustTier,
      acquiredFacts,
      d1Choice,
      scenarioData,
    });

    // 调用 LLM 生成角色回复
    const response = await generateRoleResponse({
      systemPrompt,
      conversationHistory,
      studentMessage,
      responseDirective,
    }, client);

    return response;
  };
}

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 托管前端页面和静态资源
const frontendDir = path.join(__dirname, '..', 'frontend');
const frontendPath = path.join(frontendDir, 'index.html');
app.use(express.static(frontendDir));
app.get('/', (req, res) => {
  res.sendFile(frontendPath);
});

// 请求日志中间件
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// ============ 会话存储 ============
// Map<sessionId, { engine, createdAt, lastActivity }>
const sessionStore = new Map();

// 会话自动清理：超过 2 小时无活动则移除
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of sessionStore) {
    if (now - entry.lastActivity > SESSION_TIMEOUT_MS) {
      sessionStore.delete(sid);
      console.log(`[GC] 会话 ${sid} 已超时清理`);
    }
  }
}, 10 * 60 * 1000); // 每 10 分钟检查一次

/**
 * 生成会话 ID
 */
function generateSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `sess_${ts}${rand}`;
}

/**
 * 获取会话，不存在则返回 null
 */
function getSession(sessionId) {
  const entry = sessionStore.get(sessionId);
  if (!entry) return null;
  entry.lastActivity = Date.now();
  return entry;
}

/**
 * 统一成功响应
 */
function successResponse(res, data, message) {
  res.json({
    status: 'success',
    message: message || '',
    data,
  });
}

/**
 * 统一错误响应
 */
function errorResponse(res, code, message, details) {
  res.status(code).json({
    status: 'error',
    message,
    details: details || undefined,
  });
}

// ============ 公共接口 ============

/**
 * GET /api/health
 * 健康检查
 */
app.get('/api/health', (req, res) => {
  successResponse(res, {
    status: 'running',
    uptime: process.uptime(),
    sessionCount: sessionStore.size,
    llmEnabled,
    llmModel: llmEnabled ? llmClient.config.model : null,
    timestamp: new Date().toISOString(),
  }, '服务正常运行');
});

/**
 * GET /api/scenario
 * 获取场景元数据（无需创建会话）
 */
app.get('/api/scenario', (req, res) => {
  try {
    const tempEngine = createEngine();
    const scenarioData = tempEngine.scenarioData;
    successResponse(res, {
      scenarioId: scenarioData.scenario_id,
      scenarioName: scenarioData.scenario_name,
      version: scenarioData.version,
      description: scenarioData.description,
      timeline: scenarioData.timeline,
      decisionNodes: scenarioData.decision_nodes,
      roles: (scenarioData.roles || []).map(r => ({
        id: r.id,
        name: r.name,
        title: r.title,
        coreConcern: r.core_concern,
      })),
    }, '场景元数据');
  } catch (err) {
    errorResponse(res, 500, '获取场景数据失败', err.message);
  }
});

// ============ 会话管理 ============

/**
 * POST /api/sessions
 * 创建新会话
 *
 * Body (可选):
 *   {
 *     "llmIntentClassifier": null,     // 暂不支持通过 API 传函数，预留
 *     "studentId": "stu_001"           // 学生标识（可选，用于日志）
 *   }
 */
app.post('/api/sessions', (req, res) => {
  try {
    const { studentId } = req.body || {};
    const sessionId = generateSessionId();

    // 注入 LLM 意图分类器和角色回复器（如果可用）
    const engineOptions = {};
    if (llmEnabled) {
      engineOptions.llmIntentClassifier = createEngineIntentClassifier(llmClient);
      // 创建角色回复器（注入场景数据供查询事实内容）
      const tempEngine = createEngine();
      engineOptions.llmRoleResponder = createRoleResponder(llmClient, tempEngine.scenarioData);
    }
    const engine = createEngine(engineOptions);
    const initResult = engine.startSession();

    sessionStore.set(sessionId, {
      engine,
      studentId: studentId || 'anonymous',
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
    });

    console.log(`[Session] 创建会话 ${sessionId} (student: ${studentId || 'anonymous'})`);

    successResponse(res, {
      sessionId,
      studentId: studentId || 'anonymous',
      scenarioId: initResult.scenarioId,
      scenarioName: initResult.scenarioName,
      version: initResult.version,
      timeline: initResult.timeline,
      roles: initResult.roles,
      initialFacts: initResult.initialFacts,
      intentClassifierMode: engine.intentClassifierMode,
      llmEnabled,
    }, '会话已创建');
  } catch (err) {
    errorResponse(res, 500, '创建会话失败', err.message);
  }
});

/**
 * GET /api/sessions/:sessionId
 * 获取当前状态快照
 */
app.get('/api/sessions/:sessionId', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const state = entry.engine.getState();
    successResponse(res, state, '当前状态');
  } catch (err) {
    errorResponse(res, 500, '获取状态失败', err.message);
  }
});

/**
 * DELETE /api/sessions/:sessionId
 * 销毁会话
 */
app.delete('/api/sessions/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  if (sessionStore.has(sessionId)) {
    sessionStore.delete(sessionId);
    console.log(`[Session] 销毁会话 ${sessionId}`);
    successResponse(res, { sessionId }, '会话已销毁');
  } else {
    errorResponse(res, 404, '会话不存在');
  }
});

// ============ 核心交互 ============

/**
 * POST /api/sessions/:sessionId/messages
 * 处理学生提问（访谈）
 *
 * Body:
 *   {
 *     "roleId": "R2",                      // 必填：被提问角色 ID
 *     "message": "缺陷的触发条件是什么？",   // 必填：学生提问原文
 *     "preclassifiedIntent": "risk_inquiry" // 可选：外部预分类意图（跳过 LLM 分类）
 *   }
 *
 * 当 LLM 启用时：
 *   - 如果未提供 preclassifiedIntent，会自动调用 LLM 进行意图分类
 *   - LLM 分类失败时自动降级到关键词分类
 *   - 返回结果中包含 intentSource 字段（llm / keyword / preclassified）
 *
 * Response:
 *   {
 *     actionType: "risk_verification",
 *     intentSource: "llm",
 *     trustChange: { ... },
 *     disclosedFacts: ["F-04"],
 *     ...
 *   }
 */
app.post('/api/sessions/:sessionId/messages', async (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const { roleId, message, preclassifiedIntent } = req.body || {};

    // 参数校验
    if (!roleId) {
      return errorResponse(res, 400, '缺少必填参数: roleId');
    }
    if (!message || typeof message !== 'string') {
      return errorResponse(res, 400, '缺少必填参数: message');
    }

    // 意图分类：preclassifiedIntent > LLM > 关键词兜底
    let finalIntent = preclassifiedIntent || null;
    let intentSource = 'keyword';

    if (finalIntent) {
      intentSource = 'preclassified';
    } else if (llmEnabled) {
      const state = entry.engine.getState();
      const llmIntent = await classifyIntent(message, {
        roleId,
        acquiredFacts: state.acquiredFacts,
        d1Choice: state.d1Choice,
      }, llmClient);

      if (llmIntent) {
        finalIntent = llmIntent;
        intentSource = 'llm';
      }
    }

    const result = await entry.engine.processMessage(roleId, message, finalIntent);
    result.intentSource = intentSource;

    successResponse(res, result, '消息处理完成');
  } catch (err) {
    errorResponse(res, 400, '消息处理失败', err.message);
  }
});

/**
 * POST /api/sessions/:sessionId/decisions/d1
 * 提交 D1 决策（中间决策：资源投向）
 *
 * Body:
 *   {
 *     "choice": "B_灰度准备"   // 必填：A_连夜修复 / B_灰度准备 / C_继续回归
 *   }
 *
 * Response:
 *   {
 *     "d1Choice": "B_灰度准备",
 *     "autoDisclosedFacts": ["F-04", "F-12"],
 *     "stateImpact": { S1: ..., S2: ..., S3: ... },
 *     "teachingIntent": "信息增量最大路径..."
 *   }
 */
app.post('/api/sessions/:sessionId/decisions/d1', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const { choice } = req.body || {};
    if (!choice) {
      return errorResponse(res, 400, '缺少必填参数: choice');
    }

    const result = entry.engine.submitD1(choice);
    console.log(`[D1] 会话 ${req.params.sessionId} 提交 D1: ${choice}`);
    successResponse(res, result, 'D1 决策已提交');
  } catch (err) {
    errorResponse(res, 400, 'D1 决策提交失败', err.message);
  }
});

/**
 * POST /api/sessions/:sessionId/decisions/d2
 * 提交 D2 决策（最终决策：上线方案）
 *
 * Body:
 *   {
 *     "decision": "Limited_20%"          // 字符串形式
 *     // 或对象形式：
 *     "decision": {
 *       "option": "Limited_20%",
 *       "limited_pct": 20,
 *       "evidence_refs": ["F-04", "F-05", "F-12"],
 *       "rationale": "灰度20%在阈值以下",
 *       "contingency_plan": "5分钟内切回老引擎"
 *     }
 *   }
 *
 * Response:
 *   {
 *     "constraintResults": { ... },
 *     "stateResults": { ... },
 *     "resultResults": { ... }
 *   }
 */
app.post('/api/sessions/:sessionId/decisions/d2', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const { decision } = req.body || {};
    if (!decision) {
      return errorResponse(res, 400, '缺少必填参数: decision');
    }

    const result = entry.engine.submitD2(decision);
    const optionStr = typeof decision === 'string' ? decision : (decision.option || JSON.stringify(decision));
    console.log(`[D2] 会话 ${req.params.sessionId} 提交 D2: ${optionStr}`);
    successResponse(res, result, 'D2 决策已提交');
  } catch (err) {
    errorResponse(res, 400, 'D2 决策提交失败', err.message);
  }
});

/**
 * GET /api/sessions/:sessionId/report
 * 获取完整复盘报告
 *
 * Response: 完整复盘报告对象（评分 + 证据链 + 反事实分析 + 改进建议）
 */
app.get('/api/sessions/:sessionId/report', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const report = entry.engine.getReport();
    successResponse(res, report, '复盘报告已生成');
  } catch (err) {
    errorResponse(res, 400, '生成复盘报告失败', err.message);
  }
});

/**
 * POST /api/sessions/:sessionId/llm-scores
 * 注入或自动生成 LLM 评分
 *
 * 模式 1 — 手动注入（不依赖 LLM 服务）:
 *   Body: { "llmDecisionScore": 75, "llmReflectionScore": 80, "reflectionText": "..." }
 *
 * 模式 2 — LLM 自动评分（需 LLM_ENABLED=true）:
 *   Body: { "reflectionText": "我下次会...", "autoScore": true }
 *   自动收集会话数据，调用 LLM 评分，注入引擎
 *
 * Response:
 *   {
 *     llmDecisionScore: 75,
 *     llmReflectionScore: 80,
 *     decisionFeedback: { ... },      // LLM 自动评分时返回
 *     reflectionFeedback: { ... },    // LLM 自动评分时返回
 *     source: "auto" | "manual"
 *   }
 */
app.post('/api/sessions/:sessionId/llm-scores', async (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const { llmDecisionScore, llmReflectionScore, reflectionText, autoScore } = req.body || {};

    // 模式 2：LLM 自动评分
    if (autoScore && llmEnabled) {
      const state = entry.engine.getState();
      const scenarioData = entry.engine.scenarioData;

      // 收集决策数据供 LLM 评分
      const decisionData = {
        d1Choice: state.d1Choice,
        d2Decision: state.d2Decision,
        acquiredFacts: state.acquiredFacts,
        constraintResults: state.constraintResults,
        interviewLogCount: state.interviewLogCount,
        crossValidationCount: state.crossValidationCount,
      };

      // 收集反思数据
      const allFacts = scenarioData.facts || [];
      const missedRedLineFacts = allFacts
        .filter(f => f.red_line && !state.acquiredFacts.includes(f.id))
        .map(f => f.id);

      const reflectionData = {
        d1Choice: state.d1Choice,
        d2Decision: state.d2Decision,
        acquiredFacts: state.acquiredFacts,
        missedRedLineFacts,
        reflectionText: reflectionText || '',
      };

      // 并行调用两个 LLM 评分
      const [decisionResult, reflectionResult] = await Promise.all([
        scoreDecision(decisionData, llmClient),
        scoreReflection(reflectionData, llmClient),
      ]);

      const scores = {};
      if (decisionResult) {
        scores.llmDecisionScore = decisionResult.score;
      }
      if (reflectionResult) {
        scores.llmReflectionScore = reflectionResult.score;
      }
      if (reflectionText) {
        scores.reflectionText = reflectionText;
      }
      entry.engine.setLLMScores(scores);

      console.log(`[LLM-Score] 会话 ${req.params.sessionId} 自动评分: decision=${decisionResult?.score || 'N/A'}, reflection=${reflectionResult?.score || 'N/A'}`);

      return successResponse(res, {
        llmDecisionScore: decisionResult?.score || null,
        llmReflectionScore: reflectionResult?.score || null,
        decisionFeedback: decisionResult?.feedback || null,
        reflectionFeedback: reflectionResult?.feedback || null,
        source: 'auto',
      }, 'LLM 自动评分完成');
    }

    // 模式 1：手动注入
    entry.engine.setLLMScores({ llmDecisionScore, llmReflectionScore, reflectionText });

    successResponse(res, {
      llmDecisionScore,
      llmReflectionScore,
      reflectionText: reflectionText ? reflectionText.substring(0, 100) + '...' : '',
      source: 'manual',
    }, 'LLM 评分已注入');
  } catch (err) {
    errorResponse(res, 400, 'LLM 评分处理失败', err.message);
  }
});

/**
 * POST /api/sessions/:sessionId/classify-intent
 * 独立意图分类端点（预览模式，不修改会话状态）
 *
 * Body:
 *   { "message": "缺陷的触发阈值是多少？" }
 *
 * Response:
 *   {
 *     intent: "structured_questioning",
 *     source: "llm" | "keyword",
 *     raw: { ... }              // LLM 原始返回（仅 LLM 模式）
 *   }
 */
app.post('/api/sessions/:sessionId/classify-intent', async (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const { message } = req.body || {};
    if (!message) {
      return errorResponse(res, 400, '缺少必填参数: message');
    }

    let intent = null;
    let source = 'keyword';

    if (llmEnabled) {
      const state = entry.engine.getState();
      intent = await classifyIntent(message, {
        acquiredFacts: state.acquiredFacts,
        d1Choice: state.d1Choice,
      }, llmClient);
      if (intent) source = 'llm';
    }

    // 关键词兜底
    if (!intent) {
      const { inferActionType } = require('../engine/relationship_engine');
      intent = inferActionType(message);
    }

    successResponse(res, { intent, source }, '意图分类完成');
  } catch (err) {
    errorResponse(res, 400, '意图分类失败', err.message);
  }
});

// ============ 辅助接口 ============

/**
 * GET /api/sessions/:sessionId/roles
 * 获取角色列表（含立场信息）
 */
app.get('/api/sessions/:sessionId/roles', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const scenarioData = entry.engine.scenarioData;
    const relEngine = entry.engine.relationshipEngine;
    const roles = (scenarioData.roles || []).map(r => {
      const tier = relEngine ? relEngine.getTier(r.id) : 'neutral';
      const trustScore = relEngine ? relEngine.getTrustValue(r.id) : 50;
      return {
        id: r.id,
        name: r.name,
        title: r.title,
        coreConcern: r.core_concern,
        agenda: r.agenda || '',
        bias: r.bias || '',
        currentTier: tier,
        currentTrustScore: trustScore,
      };
    });

    successResponse(res, roles, '角色列表');
  } catch (err) {
    errorResponse(res, 500, '获取角色列表失败', err.message);
  }
});

/**
 * GET /api/sessions/:sessionId/facts
 * 获取已获取事实详情
 */
app.get('/api/sessions/:sessionId/facts', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    const state = entry.engine.getState();
    const scenarioData = entry.engine.scenarioData;
    const allFacts = scenarioData.facts || [];

    const acquiredDetails = state.acquiredFacts.map(factId => {
      const fact = allFacts.find(f => f.id === factId);
      return fact ? {
        id: fact.id,
        content: fact.content,
        holder: fact.holder,
        accessLevel: fact.access_level,
        isRedLine: fact.red_line || false,
        scoringDimension: fact.scoring_dimension || '',
        teachingPoint: fact.teaching_point || '',
        weakSignal: fact.weak_signal || '',
      } : { id: factId, content: '(未知事实)' };
    });

    const missingFacts = allFacts.filter(f => !state.acquiredFacts.includes(f.id));

    successResponse(res, {
      acquired: acquiredDetails,
      acquiredCount: acquiredDetails.length,
      missing: missingFacts.map(f => ({
        id: f.id,
        content: f.content,
        holder: f.holder,
        accessLevel: f.access_level,
        isRedLine: f.red_line || false,
      })),
      missingCount: missingFacts.length,
      totalCount: allFacts.length,
    }, '事实详情');
  } catch (err) {
    errorResponse(res, 500, '获取事实详情失败', err.message);
  }
});

/**
 * GET /api/sessions/:sessionId/interview-log
 * 获取访谈日志
 */
app.get('/api/sessions/:sessionId/interview-log', (req, res) => {
  try {
    const entry = getSession(req.params.sessionId);
    if (!entry) {
      return errorResponse(res, 404, '会话不存在或已过期');
    }

    // 从 report 中提取 interviewLog，或直接从 state 获取
    const state = entry.engine.getState();
    // interviewLog 存储在 session 内部，通过 getReport 可获取完整版
    // 这里用一种轻量方式：从 relationshipEngine 获取交互统计
    const relEngine = entry.engine.relationshipEngine;
    const allTiers = relEngine ? relEngine.getAllTiers() : {};

    successResponse(res, {
      interviewLogCount: state.interviewLogCount,
      crossValidationCount: state.crossValidationCount,
      relationshipStates: allTiers,
    }, '访谈日志摘要');
  } catch (err) {
    errorResponse(res, 500, '获取访谈日志失败', err.message);
  }
});

// ============ 404 & 错误处理 ============

// 未匹配的路由
app.use('/api', (req, res) => {
  errorResponse(res, 404, `API 路径不存在: ${req.method} ${req.path}`);
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  errorResponse(res, 500, '服务器内部错误', err.message);
});

// ============ 启动服务器 ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  CareerCraft 项目决策模拟器 - 后端 API');
  console.log('========================================');
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/api/health`);
  console.log(`  场景信息: http://localhost:${PORT}/api/scenario`);
  console.log(`  LLM 状态: ${llmEnabled ? '已启用 (' + llmClient.config.model + ')' : '未启用（关键词兜底）'}`);
  console.log(`  会话超时: ${SESSION_TIMEOUT_MS / 60000} 分钟无活动自动清理`);
  console.log('========================================');
  console.log('');
});

module.exports = app;
