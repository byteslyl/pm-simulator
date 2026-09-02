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

const express = require('express');
const cors = require('cors');
const { createEngine } = require('../engine');
const {
  createLLMClient,
  classifyIntent,
  createEngineIntentClassifier,
  scoreDecision,
  scoreReflection,
} = require('./llm-adapter');

const app = express();

// ============ LLM 客户端初始化 ============
const llmClient = createLLMClient();
const llmEnabled = !!llmClient;
console.log(`[LLM] LLM 适配器: ${llmEnabled ? '已启用' : '未启用（使用关键词兜底）'}`);

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 托管前端页面
const path = require('path');
const frontendPath = path.join(__dirname, '..', 'frontend.html');
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

    // 注入 LLM 意图分类器（如果可用）
    const engineOptions = {};
    if (llmEnabled) {
      engineOptions.llmIntentClassifier = createEngineIntentClassifier(llmClient);
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

    const result = entry.engine.processMessage(roleId, message, finalIntent);
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
