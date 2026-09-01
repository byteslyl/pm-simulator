/**
 * llm-adapter.test.js - LLM 适配器单元测试
 *
 * 测试内容：
 *   1. 配置管理（环境变量读取、默认值）
 *   2. JSON 解析（容忍 markdown 包裹）
 *   3. 提示词构建（决策评分、反思评分）
 *   4. 意图分类（Mock LLM 客户端）
 *   5. LLM 评分（Mock LLM 客户端）
 *   6. 降级机制（LLM 不可用时返回 null）
 *   7. server.js 集成测试（LLM 未启用时的完整流程）
 */

'use strict';

const assert = require('assert');
const { createLLMClient, classifyIntent, scoreDecision, scoreReflection, parseJSONResponse,
  buildDecisionScoringPrompt, buildReflectionScoringPrompt, loadConfigFromEnv } = require('../llm-adapter');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ============ Mock LLM 客户端 ============

function createMockClient(responseText) {
  return {
    config: { model: 'mock-model', apiKey: 'mock-key', baseUrl: 'http://mock', timeout: 5000 },
    async chat() { return responseText; },
    async chatJSON() { return parseJSONResponse(responseText); },
  };
}

function createErrorMockClient(errorMsg) {
  return {
    config: { model: 'mock-model', apiKey: 'mock-key', baseUrl: 'http://mock', timeout: 5000 },
    async chat() { throw new Error(errorMsg); },
    async chatJSON() { throw new Error(errorMsg); },
  };
}

console.log('\n========== LLM 适配器单元测试 ==========\n');

// ============ 1. 配置管理 ============
console.log('--- 配置管理 ---');

test('未设置环境变量时 loadConfigFromEnv 返回 null', () => {
  const oldEnabled = process.env.LLM_ENABLED;
  delete process.env.LLM_ENABLED;
  const config = loadConfigFromEnv();
  assert.strictEqual(config, null, 'LLM_ENABLED 未设置时应返回 null');
  if (oldEnabled !== undefined) process.env.LLM_ENABLED = oldEnabled;
});

test('LLM_ENABLED=true 但无 API_KEY 时返回 null', () => {
  const oldEnabled = process.env.LLM_ENABLED;
  const oldKey = process.env.LLM_API_KEY;
  process.env.LLM_ENABLED = 'true';
  delete process.env.LLM_API_KEY;
  const config = loadConfigFromEnv();
  assert.strictEqual(config, null, '无 API_KEY 时应返回 null');
  if (oldEnabled !== undefined) process.env.LLM_ENABLED = oldEnabled;
  if (oldKey !== undefined) process.env.LLM_API_KEY = oldKey;
});

test('完整配置时返回正确对象', () => {
  const oldEnabled = process.env.LLM_ENABLED;
  const oldKey = process.env.LLM_API_KEY;
  const oldUrl = process.env.LLM_BASE_URL;
  const oldModel = process.env.LLM_MODEL;
  process.env.LLM_ENABLED = 'true';
  process.env.LLM_API_KEY = 'sk-test-key';
  process.env.LLM_BASE_URL = 'https://api.deepseek.com/v1';
  process.env.LLM_MODEL = 'deepseek-chat';
  const config = loadConfigFromEnv();
  assert.ok(config, '应返回配置对象');
  assert.strictEqual(config.apiKey, 'sk-test-key');
  assert.strictEqual(config.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(config.model, 'deepseek-chat');
  if (oldEnabled !== undefined) process.env.LLM_ENABLED = oldEnabled; else delete process.env.LLM_ENABLED;
  if (oldKey !== undefined) process.env.LLM_API_KEY = oldKey; else delete process.env.LLM_API_KEY;
  if (oldUrl !== undefined) process.env.LLM_BASE_URL = oldUrl; else delete process.env.LLM_BASE_URL;
  if (oldModel !== undefined) process.env.LLM_MODEL = oldModel; else delete process.env.LLM_MODEL;
});

test('createLLMClient 无配置时返回 null', () => {
  const client = createLLMClient(null);
  assert.strictEqual(client, null);
});

// ============ 2. JSON 解析 ============
console.log('\n--- JSON 解析 ---');

test('解析纯 JSON', () => {
  const result = parseJSONResponse('{"score": 85, "feedback": "good"}');
  assert.strictEqual(result.score, 85);
  assert.strictEqual(result.feedback, 'good');
});

test('解析 markdown 代码块包裹的 JSON', () => {
  const result = parseJSONResponse('```json\n{"score": 90, "reason": "excellent"}\n```');
  assert.strictEqual(result.score, 90);
  assert.strictEqual(result.reason, 'excellent');
});

test('解析包含前后文本的 JSON', () => {
  const result = parseJSONResponse('好的，以下是评分结果：\n{"score": 75}\n以上是我的评价。');
  assert.strictEqual(result.score, 75);
});

test('解析无 json 标记的代码块', () => {
  const result = parseJSONResponse('```\n{"score": 60}\n```');
  assert.strictEqual(result.score, 60);
});

// ============ 3. 提示词构建 ============
console.log('\n--- 提示词构建 ---');

test('buildDecisionScoringPrompt 包含关键信息', () => {
  const prompt = buildDecisionScoringPrompt({
    d1Choice: 'B_灰度准备',
    d2Decision: 'Limited_20%',
    acquiredFacts: ['F-01', 'F-04', 'F-12'],
  });
  assert.ok(prompt.includes('决策质量评估'), '应包含标题');
  assert.ok(prompt.includes('B_灰度准备'), '应包含 D1 决策');
  assert.ok(prompt.includes('Limited_20%'), '应包含 D2 决策');
  assert.ok(prompt.includes('0-100'), '应包含评分范围');
  assert.ok(prompt.includes('evidence_sufficiency'), '应包含 JSON 输出格式');
});

test('buildReflectionScoringPrompt 包含关键信息', () => {
  const prompt = buildReflectionScoringPrompt({
    reflectionText: '我在这次决策中遗漏了QA的关键信息',
    missedRedLineFacts: ['F-04', 'F-07'],
  });
  assert.ok(prompt.includes('成长反思评估'), '应包含标题');
  assert.ok(prompt.includes('遗漏了QA'), '应包含反思文本');
  assert.ok(prompt.includes('F-04'), '应包含遗漏的红线事实');
  assert.ok(prompt.includes('万能模板'), '应包含反模式说明');
  assert.ok(prompt.includes('specificity'), '应包含 JSON 输出格式');
});

// ============ 4. 意图分类 ============
console.log('\n--- 意图分类 ---');

asyncTest('LLM 返回有效意图时正确分类', async () => {
  const mockClient = createMockClient(JSON.stringify({
    action_name: 'structured_questioning',
    confidence: 0.95,
    reason: '学生询问具体触发条件',
  }));
  const intent = await classifyIntent('触发条件是多少', { roleId: 'R2' }, mockClient);
  assert.strictEqual(intent, 'structured_questioning');
});

asyncTest('LLM 返回 category 代码时正确映射', async () => {
  const mockClient = createMockClient(JSON.stringify({
    category: 'B',
    action_name: 'risk_verification',
    confidence: 0.88,
  }));
  const intent = await classifyIntent('这个风险有多大', { roleId: 'R2' }, mockClient);
  assert.strictEqual(intent, 'risk_verification');
});

asyncTest('LLM 返回别名时正确归一化', async () => {
  const mockClient = createMockClient(JSON.stringify({
    action_name: 'risk_inquiry',
    confidence: 0.82,
  }));
  const intent = await classifyIntent('风险怎样', {}, mockClient);
  assert.strictEqual(intent, 'risk_verification', 'risk_inquiry 应归一化为 risk_verification');
});

asyncTest('LLM 返回 strategic_alignment 时归一化为 executive_alignment', async () => {
  const mockClient = createMockClient(JSON.stringify({
    action_name: 'strategic_alignment',
    confidence: 0.90,
  }));
  const intent = await classifyIntent('公司战略怎么考虑', {}, mockClient);
  assert.strictEqual(intent, 'executive_alignment');
});

asyncTest('LLM 返回无效意图时降级返回 null', async () => {
  const mockClient = createMockClient(JSON.stringify({
    action_name: 'invalid_intent',
    confidence: 0.3,
  }));
  const intent = await classifyIntent('test message', {}, mockClient);
  assert.strictEqual(intent, null, '无效意图应返回 null 触发降级');
});

asyncTest('LLM 调用失败时降级返回 null', async () => {
  const mockClient = createErrorMockClient('Connection timeout');
  const intent = await classifyIntent('触发条件', {}, mockClient);
  assert.strictEqual(intent, null, 'LLM 失败应返回 null');
});

asyncTest('client 为 null 时返回 null', async () => {
  const intent = await classifyIntent('test', {}, null);
  assert.strictEqual(intent, null);
});

// ============ 5. LLM 评分 ============
console.log('\n--- LLM 评分 ---');

asyncTest('scoreDecision 正确解析评分结果', async () => {
  const mockResponse = JSON.stringify({
    score: 78,
    evidence_sufficiency: '获取了3条红线事实，证据基本充分',
    plan_rationality: '灰度20%在阈值以下，方案合理',
    risk_awareness: '有回滚方案但不够具体',
    balance: '平衡了技术和质量',
    overall_feedback: '决策整体合理，但回滚方案需要更具体。',
  });
  const mockClient = createMockClient(mockResponse);
  const result = await scoreDecision({
    d1Choice: 'B_灰度准备',
    d2Decision: 'Limited_20%',
    acquiredFacts: ['F-01', 'F-04', 'F-12'],
  }, mockClient);

  assert.ok(result, '应返回评分结果');
  assert.strictEqual(result.score, 78);
  assert.ok(result.feedback.evidenceSufficiency.includes('证据基本充分'));
  assert.ok(result.feedback.overallFeedback);
});

asyncTest('scoreDecision 分数限制在 0-100', async () => {
  const mockClient = createMockClient(JSON.stringify({ score: 150 }));
  const result = await scoreDecision({}, mockClient);
  assert.strictEqual(result.score, 100, '超过 100 应截断');

  const mockClient2 = createMockClient(JSON.stringify({ score: -10 }));
  const result2 = await scoreDecision({}, mockClient2);
  assert.strictEqual(result2.score, 0, '低于 0 应截断');
});

asyncTest('scoreDecision LLM 失败时返回 null', async () => {
  const mockClient = createErrorMockClient('API error');
  const result = await scoreDecision({}, mockClient);
  assert.strictEqual(result, null);
});

asyncTest('scoreReflection 正确解析评分结果', async () => {
  const mockResponse = JSON.stringify({
    score: 82,
    specificity: '针对F-04遗漏做了具体分析',
    self_attribution: '承认自己没有追问QA',
    actionability: '改进计划明确：下次用结构化提问清单',
    metacognition: '反思了信息获取策略的不足',
    overall_feedback: '反思质量较高，有具体的改进计划。',
  });
  const mockClient = createMockClient(mockResponse);
  const result = await scoreReflection({
    reflectionText: '我遗漏了F-04，因为没有追问QA',
    missedRedLineFacts: ['F-04'],
  }, mockClient);

  assert.ok(result);
  assert.strictEqual(result.score, 82);
  assert.ok(result.feedback.specificity.includes('具体分析'));
  assert.ok(result.feedback.actionability.includes('改进计划'));
});

asyncTest('scoreReflection LLM 失败时返回 null', async () => {
  const mockClient = createErrorMockClient('Timeout');
  const result = await scoreReflection({}, mockClient);
  assert.strictEqual(result, null);
});

asyncTest('scoreDecision client 为 null 时返回 null', async () => {
  const result = await scoreDecision({}, null);
  assert.strictEqual(result, null);
});

asyncTest('scoreReflection client 为 null 时返回 null', async () => {
  const result = await scoreReflection({}, null);
  assert.strictEqual(result, null);
});

// ============ 6. server.js 集成测试（LLM 未启用） ============
console.log('\n--- server.js 集成（LLM 未启用模式） ---');

// 由于 server.js 在加载时即初始化 LLM 客户端，
// 在 LLM_ENABLED 未设置时应正常工作
const http = require('http');

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let serverPort = 3456;
let serverInstance = null;

async function startServer() {
  const app = require('../server');
  return new Promise((resolve) => {
    serverInstance = app.listen(serverPort, () => resolve());
  });
}

async function stopServer() {
  return new Promise((resolve) => {
    if (serverInstance) serverInstance.close(() => resolve());
    else resolve();
  });
}

asyncTest('健康检查包含 LLM 状态', async () => {
  await startServer();
  const res = await httpRequest({
    hostname: 'localhost', port: serverPort, path: '/api/health', method: 'GET',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok('llmEnabled' in res.body.data, '应包含 llmEnabled 字段');
  assert.strictEqual(res.body.data.llmEnabled, false, '未配置时应为 false');
});

asyncTest('创建会话返回 llmEnabled 字段', async () => {
  const res = await httpRequest({
    hostname: 'localhost', port: serverPort, path: '/api/sessions', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { studentId: 'test_llm' });
  assert.strictEqual(res.status, 200);
  assert.ok('llmEnabled' in res.body.data);
  assert.strictEqual(res.body.data.llmEnabled, false);
});

asyncTest('发送消息在 LLM 未启用时使用关键词分类', async () => {
  // 创建会话
  const createRes = await httpRequest({
    hostname: 'localhost', port: serverPort, path: '/api/sessions', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {});
  const sessionId = createRes.body.data.sessionId;

  // 发送消息
  const msgRes = await httpRequest({
    hostname: 'localhost', port: serverPort,
    path: `/api/sessions/${sessionId}/messages`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { roleId: 'R2', message: '触发条件是多少' });

  assert.strictEqual(msgRes.status, 200);
  assert.ok(msgRes.body.data.intentSource, '应包含 intentSource 字段');
  assert.strictEqual(msgRes.body.data.intentSource, 'keyword', 'LLM 未启用时应为 keyword');
});

asyncTest('意图分类预览端点正常工作', async () => {
  const createRes = await httpRequest({
    hostname: 'localhost', port: serverPort, path: '/api/sessions', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {});
  const sessionId = createRes.body.data.sessionId;

  const classifyRes = await httpRequest({
    hostname: 'localhost', port: serverPort,
    path: `/api/sessions/${sessionId}/classify-intent`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { message: '风险有多大' });

  assert.strictEqual(classifyRes.status, 200);
  assert.strictEqual(classifyRes.body.data.source, 'keyword');
  assert.ok(classifyRes.body.data.intent, '应返回意图分类结果');
});

asyncTest('LLM 手动评分注入正常工作', async () => {
  const createRes = await httpRequest({
    hostname: 'localhost', port: serverPort, path: '/api/sessions', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {});
  const sessionId = createRes.body.data.sessionId;

  const scoreRes = await httpRequest({
    hostname: 'localhost', port: serverPort,
    path: `/api/sessions/${sessionId}/llm-scores`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, { llmDecisionScore: 75, llmReflectionScore: 80, reflectionText: '我学到了很多' });

  assert.strictEqual(scoreRes.status, 200);
  assert.strictEqual(scoreRes.body.data.source, 'manual');
  assert.strictEqual(scoreRes.body.data.llmDecisionScore, 75);
});

// ============ 运行结果 ============

setTimeout(async () => {
  await stopServer();
  console.log('\n========================================');
  console.log(`  LLM 适配器测试结果: ${passed} 通过, ${failed} 失败`);
  console.log('========================================\n');
  if (failed > 0) process.exit(1);
}, 500);
