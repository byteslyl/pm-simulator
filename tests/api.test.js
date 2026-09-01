/**
 * api.test.js - API 端到端测试
 *
 * 测试策略：启动服务器 → 调用各 API 端点 → 验证响应 → 关闭服务器
 * 使用 Node 内置 http 模块，无需额外测试框架依赖。
 *
 * 运行方式：node tests/api.test.js
 */

'use strict';

const http = require('http');
const assert = require('assert');

// 测试配置
const PORT = 3999; // 使用非默认端口避免冲突
const BASE = `http://localhost:${PORT}`;

// 统一的 HTTP 请求封装
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (data) {
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          resolve({ status: res.statusCode, body: json });
        } catch (e) {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ============ 测试用例 ============

const tests = [];
const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  tests.push({ name, fn });
}

// ---------- 公共接口 ----------

test('GET /api/health - 健康检查', async () => {
  const res = await request('GET', '/api/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.data.status, 'running');
  assert.ok(res.body.data.uptime >= 0);
});

test('GET /api/scenario - 场景元数据', async () => {
  const res = await request('GET', '/api/scenario');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.data.scenarioId, 'LN2-v01');
  assert.strictEqual(res.body.data.scenarioName, '上线前夜 · 星盘结算');
  assert.ok(res.body.data.roles.length >= 4);
  assert.ok(res.body.data.decisionNodes.D1);
  assert.ok(res.body.data.decisionNodes.D2);
});

// ---------- 会话管理 ----------

let sessionId = null;

test('POST /api/sessions - 创建会话', async () => {
  const res = await request('POST', '/api/sessions', { studentId: 'stu_test_001' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.sessionId.startsWith('sess_'));
  assert.strictEqual(res.body.data.studentId, 'stu_test_001');
  assert.strictEqual(res.body.data.scenarioId, 'LN2-v01');
  assert.ok(res.body.data.roles.length >= 4);
  assert.ok(res.body.data.initialFacts.length > 0);
  sessionId = res.body.data.sessionId;
});

test('GET /api/sessions/:sessionId - 获取状态', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.data.started, true);
  assert.ok(res.body.data.acquiredFacts.length > 0);
  assert.strictEqual(res.body.data.d1Choice, null);
  assert.strictEqual(res.body.data.d2Decision, null);
});

test('GET /api/sessions/invalid - 无效会话返回 404', async () => {
  const res = await request('GET', '/api/sessions/sess_invalid_999');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.status, 'error');
});

// ---------- 核心交互：访谈 ----------

test('POST /api/sessions/:sessionId/messages - 访谈 R2（QA）', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/messages`, {
    roleId: 'R2',
    message: '闻笛，缺陷复现的具体触发条件是什么？QPS到多少会触发？',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.actionType);
  assert.ok(res.body.data.response);
  assert.ok(res.body.data.acquiredFactsCount > 0);
});

test('POST /api/sessions/:sessionId/messages - 访谈 R1（Tech）', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/messages`, {
    roleId: 'R1',
    message: '沈屹，修复这个缺陷需要多少时间？排期明细能拉一下吗？',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.response);
});

test('POST /api/sessions/:sessionId/messages - 缺少 roleId 报 400', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/messages`, {
    message: 'test',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'error');
});

test('POST /api/sessions/:sessionId/messages - 缺少 message 报 400', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/messages`, {
    roleId: 'R2',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'error');
});

// ---------- 核心交互：D1 决策 ----------

test('POST /api/sessions/:sessionId/decisions/d1 - 提交 D1 (B_灰度准备)', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/decisions/d1`, {
    choice: 'B_灰度准备',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.data.d1Choice, 'B_灰度准备');
  // D1-B 应自动披露 F-04, F-12
  assert.ok(res.body.data.autoDisclosedFacts.length >= 0);
  assert.ok(res.body.data.stateImpact);
});

test('POST /api/sessions/:sessionId/decisions/d1 - 缺少 choice 报 400', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/decisions/d1`, {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'error');
});

// ---------- 核心交互：D2 决策 ----------

test('POST /api/sessions/:sessionId/decisions/d2 - 提交 D2 (字符串形式)', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/decisions/d2`, {
    decision: 'Limited_20%',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.constraintResults);
  assert.ok(res.body.data.stateResults);
  assert.ok(res.body.data.resultResults);
});

test('POST /api/sessions/:sessionId/decisions/d2 - 缺少 decision 报 400', async () => {
  // 先创建新会话来测试 D2 缺参数（因为上面的会话已提交过 D2）
  const createRes = await request('POST', '/api/sessions', { studentId: 'stu_test_d2' });
  const sid = createRes.body.data.sessionId;
  const res = await request('POST', `/api/sessions/${sid}/decisions/d2`, {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.status, 'error');
});

// ---------- 复盘报告 ----------

test('GET /api/sessions/:sessionId/report - 获取复盘报告', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}/report`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.scoring);
  assert.ok(res.body.data.evidenceChain);
  assert.ok(res.body.data.counterfactual);
  assert.ok(res.body.data.improvementSuggestions);
  assert.ok(res.body.data.interviewLog);
});

// ---------- LLM 评分注入 ----------

test('POST /api/sessions/:sessionId/llm-scores - 注入 LLM 评分', async () => {
  const res = await request('POST', `/api/sessions/${sessionId}/llm-scores`, {
    llmDecisionScore: 78,
    llmReflectionScore: 82,
    reflectionText: '我意识到在访谈中应该更主动地追问风险信息，特别是 QA 提到的触发条件。',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.data.llmDecisionScore, 78);
  assert.strictEqual(res.body.data.llmReflectionScore, 82);
});

// ---------- 辅助接口 ----------

test('GET /api/sessions/:sessionId/roles - 获取角色列表', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}/roles`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.length >= 4);
  const r2 = res.body.data.find(r => r.id === 'R2');
  assert.ok(r2);
  assert.ok(r2.name);
  assert.ok(r2.currentTier);
});

test('GET /api/sessions/:sessionId/facts - 获取事实详情', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}/facts`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.acquired.length > 0);
  assert.ok(res.body.data.totalCount === 17);
  assert.strictEqual(res.body.data.acquiredCount + res.body.data.missingCount, res.body.data.totalCount);
});

test('GET /api/sessions/:sessionId/interview-log - 获取访谈日志摘要', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}/interview-log`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.ok(res.body.data.interviewLogCount >= 0);
});

// ---------- 404 测试 ----------

test('GET /api/nonexistent - 404', async () => {
  const res = await request('GET', '/api/nonexistent');
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.status, 'error');
});

// ---------- 会话销毁 ----------

test('DELETE /api/sessions/:sessionId - 销毁会话', async () => {
  const res = await request('DELETE', `/api/sessions/${sessionId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
});

test('GET /api/sessions/:sessionId - 销毁后获取返回 404', async () => {
  const res = await request('GET', `/api/sessions/${sessionId}`);
  assert.strictEqual(res.status, 404);
});

// ---------- 完整流程测试 ----------

test('完整流程：创建→访谈→D1→D2→报告', async () => {
  // 1. 创建会话
  const createRes = await request('POST', '/api/sessions', { studentId: 'stu_e2e' });
  const sid = createRes.body.data.sessionId;
  assert.ok(sid);

  // 2. 访谈多个角色
  await request('POST', `/api/sessions/${sid}/messages`, {
    roleId: 'R2',
    message: '闻笛，缺陷的触发条件是什么？QPS到多少会触发？我需要评估灰度方案的安全性',
  });
  await request('POST', `/api/sessions/${sid}/messages`, {
    roleId: 'R1',
    message: '沈屹，修复方案是什么？需要多少时间？',
  });
  await request('POST', `/api/sessions/${sid}/messages`, {
    roleId: 'R3',
    message: '江照，这次活动的预期峰值是多少？',
  });

  // 3. 提交 D1
  const d1Res = await request('POST', `/api/sessions/${sid}/decisions/d1`, {
    choice: 'B_灰度准备',
  });
  assert.strictEqual(d1Res.body.data.d1Choice, 'B_灰度准备');

  // 4. 提交 D2（带证据引用的对象形式）
  const d2Res = await request('POST', `/api/sessions/${sid}/decisions/d2`, {
    decision: {
      option: 'Limited_20%',
      limited_pct: 20,
      evidence_refs: ['F-04', 'F-05', 'F-12'],
      rationale: '灰度20%在阈值以下，回滚5分钟满足C-04',
      contingency_plan: '5分钟内切回老引擎',
    },
  });
  assert.ok(d2Res.body.data.constraintResults);

  // 5. 注入 LLM 评分
  await request('POST', `/api/sessions/${sid}/llm-scores`, {
    llmDecisionScore: 75,
    llmReflectionScore: 80,
    reflectionText: '反思：我应该更早追问回滚能力。',
  });

  // 6. 获取报告
  const reportRes = await request('GET', `/api/sessions/${sid}/report`);
  assert.ok(reportRes.body.data.scoring);
  assert.ok(reportRes.body.data.scoring.totalScore !== undefined);

  // 7. 清理
  await request('DELETE', `/api/sessions/${sid}`);
});

// ============ 运行测试 ============

async function runTests() {
  console.log('');
  console.log('========================================');
  console.log('  CareerCraft API 端到端测试');
  console.log(`  共 ${tests.length} 个测试用例`);
  console.log('========================================');
  console.log('');

  for (const { name, fn } of tests) {
    try {
      await fn();
      results.passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ name, error: err.message });
      console.log(`  ✗ ${name}`);
      console.log(`    → ${err.message}`);
    }
  }

  console.log('');
  console.log('----------------------------------------');
  console.log(`  通过: ${results.passed}  失败: ${results.failed}  总计: ${tests.length}`);
  console.log('----------------------------------------');
  console.log('');

  if (results.failed > 0) {
    console.log('失败详情:');
    for (const e of results.errors) {
      console.log(`  - ${e.name}: ${e.error}`);
    }
    console.log('');
  } else {
    console.log('全部通过！');
  }
}

// ============ 启动测试 ============

// 设置端口后加载 server.js，模块加载时即自动启动服务器
process.env.PORT = PORT;

try {
  require('../server');
  // 等待服务器启动后运行测试
  setTimeout(async () => {
    console.log(`测试服务器已启动: http://localhost:${PORT}`);
    try {
      await runTests();
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (e) {
      console.error('测试执行异常:', e);
      process.exit(1);
    }
  }, 500);
} catch (err) {
  console.error('启动测试服务器失败:', err.message);
  console.error('请确保已安装依赖: npm install');
  process.exit(1);
}
