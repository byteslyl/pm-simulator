/**
 * llm-adapter.js - LLM 适配器模块
 *
 * 采用 OpenAI 兼容 API 格式，支持所有兼容 OpenAI Chat Completions 的 LLM 服务：
 *   - OpenAI (GPT-4o / GPT-4o-mini)
 *   - 智谱 AI (glm-4 / glm-4-flash)
 *   - 月之暗面 (moonshot-v1-8k / moonshot-v1-32k)
 *   - DeepSeek (deepseek-chat / deepseek-coder)
 *   - 通义千问 (qwen-plus / qwen-turbo)
 *   - 任何自部署的 vLLM / Ollama 等兼容服务
 *
 * 功能：
 *   1. createLLMClient(config) — 创建 LLM 客户端
 *   2. classifyIntent(message, context, client) — LLM 意图分类
 *   3. scoreDecision(decisionData, client) — LLM 决策质量评分
 *   4. scoreReflection(reflectionData, client) — LLM 成长反思评分
 *
 * 配置方式（环境变量）：
 *   LLM_API_KEY=sk-xxx          — API 密钥
 *   LLM_BASE_URL=https://...    — API 基地址（默认 OpenAI）
 *   LLM_MODEL=gpt-4o-mini       — 模型名称
 *   LLM_TIMEOUT=10000           — 请求超时（ms，默认 10000）
 *   LLM_ENABLED=true            — 是否启用 LLM（默认 false，使用关键词兜底）
 *
 * 当 LLM 不可用或调用失败时，自动降级到关键词分类器，保证服务不中断。
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const { buildIntentClassifierPrompt, intentCategories } = require('../engine/agent_prompts/intent_classifier');
const { inferActionType } = require('../engine/relationship_engine');

// ============ 配置管理 ============

/**
 * 从环境变量读取 LLM 配置
 * @returns {object|null} 配置对象，未配置则返回 null
 */
function loadConfigFromEnv() {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const timeout = parseInt(process.env.LLM_TIMEOUT || '10000', 10);
  const enabled = (process.env.LLM_ENABLED || 'false').toLowerCase() === 'true';

  if (!enabled) return null;
  if (!apiKey) {
    console.warn('[LLM] LLM_ENABLED=true 但未设置 LLM_API_KEY，将使用关键词兜底');
    return null;
  }

  return { apiKey, baseUrl, model, timeout, enabled: true };
}

// ============ LLM 客户端 ============

/**
 * 创建 LLM 客户端
 * @param {object} [config] - 配置，不传则从环境变量读取
 * @returns {object|null} 客户端对象，不可用则返回 null
 */
function createLLMClient(config) {
  const cfg = config || loadConfigFromEnv();
  if (!cfg || !cfg.apiKey) return null;

  return {
    config: cfg,

    /**
     * 调用 LLM Chat Completions API
     * @param {string} systemPrompt - 系统提示词
     * @param {string} userMessage - 用户消息
     * @returns {Promise<string>} LLM 返回的文本内容
     */
    async chat(systemPrompt, userMessage) {
      return callChatAPI(cfg, systemPrompt, userMessage);
    },

    /**
     * 调用 LLM 并解析 JSON 输出
     * @param {string} systemPrompt - 系统提示词
     * @param {string} userMessage - 用户消息
     * @returns {Promise<object>} 解析后的 JSON 对象
     */
    async chatJSON(systemPrompt, userMessage) {
      const raw = await callChatAPI(cfg, systemPrompt, userMessage);
      return parseJSONResponse(raw);
    },
  };
}

/**
 * 调用 OpenAI 兼容的 Chat Completions API
 * @param {object} cfg - 配置
 * @param {string} systemPrompt - 系统提示词
 * @param {string} userMessage - 用户消息
 * @returns {Promise<string>} LLM 返回的文本
 */
function callChatAPI(cfg, systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const url = new URL(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const transport = url.protocol === 'https:' ? https : http;

    const body = JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1, // 低温度保证分类稳定性
      max_tokens: 1024,
    });

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: cfg.timeout,
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`LLM API 返回 ${res.statusCode}: ${data.substring(0, 500)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : '';
          resolve(content.trim());
        } catch (e) {
          reject(new Error(`LLM 响应解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`LLM 请求失败: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`LLM 请求超时 (${cfg.timeout}ms)`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * 从 LLM 输出中解析 JSON（容忍 markdown 代码块包裹）
 * @param {string} raw
 * @returns {object}
 */
function parseJSONResponse(raw) {
  let cleaned = raw.trim();

  // 去除可能的 markdown 代码块标记
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  }

  // 尝试提取第一个 JSON 对象
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  return JSON.parse(cleaned);
}

// ============ 意图分类 ============

/**
 * 使用 LLM 进行意图分类
 *
 * @param {string} message - 学生提问原文
 * @param {object} context - 上下文 { roleId, acquiredFacts, d1Choice }
 * @param {object} client - LLM 客户端
 * @returns {Promise<string>} 意图分类结果（action_name）
 *   返回值: structured_questioning / risk_verification / plan_negotiation / resource_inquiry / executive_alignment
 *   失败时返回 null，由调用方降级
 */
async function classifyIntent(message, context, client) {
  if (!client) return null;

  try {
    // 构建系统提示词（复用 intent_classifier.js 的提示词模板）
    const systemPrompt = buildIntentClassifierPrompt(message);

    // 补充上下文信息
    const contextStr = [
      `当前访谈角色: ${context.roleId || '未知'}`,
      `已获取事实: ${(context.acquiredFacts || []).join(', ') || '无'}`,
      `D1 决策: ${context.d1Choice || '未决策'}`,
      '',
      '请对以下学生消息进行意图分类，严格按照输出格式要求返回 JSON：',
    ].join('\n');

    const result = await client.chatJSON(systemPrompt, contextStr);

    // 验证分类结果
    const validIntents = intentCategories.map((c) => c.name);
    // 同时兼容引擎使用的变体名
    const intentAliases = {
      structured_questioning: 'structured_questioning',
      structured_query: 'structured_questioning',
      risk_inquiry: 'risk_verification',
      risk_verification: 'risk_verification',
      plan_negotiation: 'plan_negotiation',
      resource_inquiry: 'resource_inquiry',
      executive_alignment: 'executive_alignment',
      strategic_alignment: 'executive_alignment',
    };

    const rawIntent = result.action_name || result.intent || result.category_name || '';
    const normalized = intentAliases[rawIntent] || rawIntent;

    if (validIntents.includes(normalized)) {
      console.log(`[LLM] 意图分类: "${message.substring(0, 30)}..." → ${normalized} (confidence: ${result.confidence || 'N/A'})`);
      return normalized;
    }

    // 尝试从 category 字段映射 (A/B/C/D/E)
    if (result.category) {
      const cat = intentCategories.find((c) => c.code === result.category);
      if (cat) {
        console.log(`[LLM] 意图分类(通过category): ${cat.name}`);
        return cat.name;
      }
    }

    console.warn(`[LLM] 意图分类返回无效值: ${rawIntent}，降级到关键词分类`);
    return null;
  } catch (err) {
    console.warn(`[LLM] 意图分类失败: ${err.message}，降级到关键词分类`);
    return null;
  }
}

/**
 * 创建可注入引擎的 LLM 意图分类函数
 * 引擎要求: (message, context) => intentString  (同步)
 * LLM 调用是异步的，所以这里需要特殊处理：
 *   方案 A：预分类模式（前端先调 /api/classify-intent，拿到结果后传给 messages 接口）
 *   方案 B：异步包装（引擎改为 async）— 改动太大
 *   方案 C：server.js 层面预调 LLM，拿到结果后传 preclassifiedIntent 给引擎
 *
 * 实际采用方案 C：在 server.js 的 messages 接口中先调 LLM 分类，
 * 然后将结果作为 preclassifiedIntent 传给 engine.processMessage()
 *
 * @param {object} client - LLM 客户端
 * @returns {function|null} 兼容引擎接口的分类函数（同步，使用关键词兜底）
 */
function createEngineIntentClassifier(client) {
  if (!client) return null;

  // 引擎接口要求同步返回，这里返回一个标记函数
  // 实际 LLM 分类在 server.js 层异步完成，通过 preclassifiedIntent 传入
  // 这个函数仅在引擎内部 fallback 时使用（不应该被调用到）
  return function fallbackClassifier(message, context) {
    console.log('[LLM] 引擎内部 fallback 分类器被调用（应该使用 preclassifiedIntent）');
    return inferActionType(message);
  };
}

// ============ LLM 评分 ============

/**
 * LLM 决策质量评分提示词
 */
function buildDecisionScoringPrompt(decisionData) {
  return [
    '# 决策质量评估',
    '',
    '你是项目管理教官，需要评估学生在"上线前夜 · 星盘结算"模拟场景中的决策质量。',
    '',
    '## 场景背景',
    '支付链路 SaaS 产品「星盘结算」计划明日 09:00 上线。',
    '新引擎核心支付接口存在已知缺陷，触发阈值 QPS>2500，预估活动峰值 3200 笔/秒。',
    '学生需要在 D1（资源投向）和 D2（上线方案）两个节点做出决策。',
    '',
    '## 学生决策信息',
    `- D1 决策: ${decisionData.d1Choice || '未决策'}`,
    `- D2 决策: ${typeof decisionData.d2Decision === 'object' ? JSON.stringify(decisionData.d2Decision) : decisionData.d2Decision || '未决策'}`,
    `- 已获取事实数: ${(decisionData.acquiredFacts || []).length} / 17`,
    `- 已获取事实: ${(decisionData.acquiredFacts || []).join(', ')}`,
    `- 约束检查结果: ${decisionData.constraintResults ? (decisionData.constraintResults.all_passed ? '全部通过' : `违反${decisionData.constraintResults.violated_count}条`) : '未检查'}`,
    `- 访谈轮次: ${decisionData.interviewLogCount || 0}`,
    `- 交叉验证次数: ${decisionData.crossValidationCount || 0}`,
    '',
    '## 评分标准（0-100 分）',
    '- 90-100: 决策逻辑严密，基于充分证据，方案与风险匹配，考虑了多方利益',
    '- 75-89: 决策基本合理，证据较充分，但存在小的盲区',
    '- 60-74: 决策可执行但有明显缺陷，如证据不足或未考虑关键风险',
    '- 40-59: 决策存在较大问题，如忽视红线事实或约束违反',
    '- 0-39: 决策严重失误，如带病全量上线或完全无视关键信息',
    '',
    '## 评估维度',
    '1. 证据充分性：是否获取了足够的红线事实来支撑决策',
    '2. 方案合理性：选择的方案是否与已知风险匹配',
    '3. 风险意识：是否考虑了回滚能力、应急方案',
    '4. 利益平衡：是否平衡了技术、质量、商业多方利益',
    '5. 约束遵守：是否遵守了硬约束',
    '',
    '请严格按照以下 JSON 格式输出评分结果（不要输出其他内容）：',
    '',
    '{',
    '  "score": 0到100的整数,',
    '  "evidence_sufficiency": "证据充分性评价(一句话)",',
    '  "plan_rationality": "方案合理性评价(一句话)",',
    '  "risk_awareness": "风险意识评价(一句话)",',
    '  "balance": "利益平衡评价(一句话)",',
    '  "overall_feedback": "总体反馈(2-3句话)"',
    '}',
  ].join('\n');
}

/**
 * LLM 评估决策质量
 * @param {object} decisionData - 决策数据
 * @param {object} client - LLM 客户端
 * @returns {Promise<{score:number, feedback:object}|null>}
 */
async function scoreDecision(decisionData, client) {
  if (!client) return null;

  try {
    const prompt = buildDecisionScoringPrompt(decisionData);
    const result = await client.chatJSON(prompt, '请评估上述学生决策。');

    const score = Math.max(0, Math.min(100, parseInt(result.score, 10) || 0));
    console.log(`[LLM] 决策质量评分: ${score}/100`);

    return {
      score,
      feedback: {
        evidenceSufficiency: result.evidence_sufficiency || '',
        planRationality: result.plan_rationality || '',
        riskAwareness: result.risk_awareness || '',
        balance: result.balance || '',
        overallFeedback: result.overall_feedback || '',
      },
    };
  } catch (err) {
    console.warn(`[LLM] 决策质量评分失败: ${err.message}`);
    return null;
  }
}

/**
 * LLM 成长反思评分提示词
 */
function buildReflectionScoringPrompt(reflectionData) {
  return [
    '# 成长反思评估',
    '',
    '你是项目管理教官，需要评估学生在模拟场景结束后的复盘反思质量。',
    '',
    '## 学生决策概要',
    `- D1 决策: ${reflectionData.d1Choice || '未决策'}`,
    `- D2 决策: ${typeof reflectionData.d2Decision === 'object' ? JSON.stringify(reflectionData.d2Decision) : reflectionData.d2Decision || '未决策'}`,
    `- 已获取事实: ${(reflectionData.acquiredFacts || []).length} / 17`,
    `- 遗漏的红线事实: ${(reflectionData.missedRedLineFacts || []).join(', ') || '无'}`,
    '',
    '## 学生反思文本',
    `"${reflectionData.reflectionText || '(未提交)'}"`,
    '',
    '## 评分标准（0-100 分）',
    '- 90-100: 反思深刻，能具体指出自己的决策盲区，有明确的改进计划和可操作的方法',
    '- 75-89: 反思较为具体，能识别主要问题，但改进计划不够具体',
    '- 60-74: 反思有一定内容，但偏笼统（如"我下次会更注意沟通"），缺乏具体性',
    '- 40-59: 反思过于简短或套话，没有触及具体决策问题',
    '- 0-39: 未反思或完全无意义内容',
    '',
    '## 评估维度',
    '1. 具体性：是否针对具体的决策节点和事实',
    '2. 自我归因：是否分析自己的认知偏差而非归咎外部',
    '3. 改进可操作性：改进计划是否具体可执行',
    '4. 元认知：是否反思了自己的信息获取策略',
    '',
    '## 反模式（应扣分）',
    '- 万能模板式回答（"我下次会更注意沟通/更仔细"）',
    '- 只描述做了什么而不反思为什么',
    '- 归咎于外部因素（"信息不够明确""角色不配合"）',
    '',
    '请严格按照以下 JSON 格式输出评分结果（不要输出其他内容）：',
    '',
    '{',
    '  "score": 0到100的整数,',
    '  "specificity": "具体性评价(一句话)",',
    '  "self_attribution": "自我归因评价(一句话)",',
    '  "actionability": "改进可操作性评价(一句话)",',
    '  "metacognition": "元认知评价(一句话)",',
    '  "overall_feedback": "总体反馈(2-3句话)"',
    '}',
  ].join('\n');
}

/**
 * LLM 评估成长反思
 * @param {object} reflectionData - 反思数据
 * @param {object} client - LLM 客户端
 * @returns {Promise<{score:number, feedback:object}|null>}
 */
async function scoreReflection(reflectionData, client) {
  if (!client) return null;

  try {
    const prompt = buildReflectionScoringPrompt(reflectionData);
    const result = await client.chatJSON(prompt, '请评估上述学生反思。');

    const score = Math.max(0, Math.min(100, parseInt(result.score, 10) || 0));
    console.log(`[LLM] 成长反思评分: ${score}/100`);

    return {
      score,
      feedback: {
        specificity: result.specificity || '',
        selfAttribution: result.self_attribution || '',
        actionability: result.actionability || '',
        metacognition: result.metacognition || '',
        overallFeedback: result.overall_feedback || '',
      },
    };
  } catch (err) {
    console.warn(`[LLM] 成长反思评分失败: ${err.message}`);
    return null;
  }
}

// ============ 导出 ============

module.exports = {
  loadConfigFromEnv,
  createLLMClient,
  classifyIntent,
  createEngineIntentClassifier,
  scoreDecision,
  scoreReflection,
  // 暴露内部函数供测试
  parseJSONResponse,
  buildDecisionScoringPrompt,
  buildReflectionScoringPrompt,
};
