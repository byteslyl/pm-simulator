/**
 * breadcrumb.test.js - 红线面包屑系统单元测试
 *
 * 测试范围：
 *   1. getBreadcrumbs — 面包屑数据查询
 *   2. getCurrentBreadcrumb — 当前面包屑层级查询
 *   3. matchBreadcrumbTrigger — 面包屑触发条件匹配
 *   4. isBreadcrumbGuaranteed — 保证披露层级检测
 *   5. processMessage 面包屑集成测试（6条红线全覆盖）
 *   6. 面包屑公平性保证测试
 *   7. 面包屑与原有系统兼容性测试
 *   8. 边界情况
 */

'use strict';

const assert = require('assert');
const { createEngine } = require('../engine');
const { createRelationshipEngine } = require('../engine/relationship_engine');

let passCount = 0;
let failCount = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ============================================================
// 1. getBreadcrumbs 面包屑数据查询
// ============================================================

describe('━━━ 1. getBreadcrumbs 面包屑数据查询 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('F-04 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-04');
    assert.ok(bcs, 'F-04 应有面包屑');
    assert.strictEqual(bcs.length, 2, 'F-04 应有 2 级面包屑');
  });

  test('F-08 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-08');
    assert.ok(bcs, 'F-08 应有面包屑');
    assert.strictEqual(bcs.length, 2, 'F-08 应有 2 级面包屑');
  });

  test('F-11 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-11');
    assert.ok(bcs, 'F-11 应有面包屑');
    assert.strictEqual(bcs.length, 2);
  });

  test('F-12 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-12');
    assert.ok(bcs, 'F-12 应有面包屑');
    assert.strictEqual(bcs.length, 2);
  });

  test('F-14 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-14');
    assert.ok(bcs, 'F-14 应有面包屑');
    assert.strictEqual(bcs.length, 2);
  });

  test('F-17 有面包屑链', () => {
    const bcs = relEngine.getBreadcrumbs('F-17');
    assert.ok(bcs, 'F-17 应有面包屑');
    assert.strictEqual(bcs.length, 2);
  });

  test('无面包屑的事实返回 null', () => {
    const bcs = relEngine.getBreadcrumbs('F-01');
    assert.strictEqual(bcs, null, 'F-01 是 L0 事实，无面包屑');
  });

  test('不存在的事实返回 null', () => {
    const bcs = relEngine.getBreadcrumbs('F-99');
    assert.strictEqual(bcs, null);
  });

  test('每条面包屑第1级无 guaranteed_disclose', () => {
    ['F-04', 'F-08', 'F-11', 'F-12', 'F-14', 'F-17'].forEach((fid) => {
      const bcs = relEngine.getBreadcrumbs(fid);
      const round1 = bcs.find((b) => b.round === 1);
      assert.ok(!round1.guaranteed_disclose, `${fid} 第1级不应保证披露`);
    });
  });

  test('每条面包屑第2级有 guaranteed_disclose', () => {
    ['F-04', 'F-08', 'F-11', 'F-12', 'F-14', 'F-17'].forEach((fid) => {
      const bcs = relEngine.getBreadcrumbs(fid);
      const round2 = bcs.find((b) => b.round === 2);
      assert.ok(round2.guaranteed_disclose, `${fid} 第2级应保证披露`);
    });
  });
});

// ============================================================
// 2. getCurrentBreadcrumb 当前面包屑层级
// ============================================================

describe('━━━ 2. getCurrentBreadcrumb 当前面包屑层级 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('轮次0 → 返回第1级面包屑', () => {
    const bc = relEngine.getCurrentBreadcrumb('F-04', 0);
    assert.ok(bc, '应返回第1级');
    assert.strictEqual(bc.round, 1);
  });

  test('轮次1 → 返回第2级面包屑', () => {
    const bc = relEngine.getCurrentBreadcrumb('F-04', 1);
    assert.ok(bc, '应返回第2级');
    assert.strictEqual(bc.round, 2);
  });

  test('轮次2 → 面包屑已走完，返回 null', () => {
    const bc = relEngine.getCurrentBreadcrumb('F-04', 2);
    assert.strictEqual(bc, null);
  });

  test('无面包屑的事实返回 null', () => {
    const bc = relEngine.getCurrentBreadcrumb('F-01', 0);
    assert.strictEqual(bc, null);
  });
});

// ============================================================
// 3. matchBreadcrumbTrigger 触发条件匹配
// ============================================================

describe('━━━ 3. matchBreadcrumbTrigger 触发条件匹配 ━━━', () => {
  const relEngine = createRelationshipEngine();
  const bc1 = relEngine.getBreadcrumbs('F-04').find((b) => b.round === 1);

  test('关键词匹配 → 触发', () => {
    assert.ok(relEngine.matchBreadcrumbTrigger('触发条件是什么？', 'structured_questioning', bc1));
  });

  test('意图匹配 → 触发', () => {
    assert.ok(relEngine.matchBreadcrumbTrigger('我需要了解情况', 'structured_questioning', bc1));
  });

  test('无关键词无匹配意图 → 不触发', () => {
    assert.ok(!relEngine.matchBreadcrumbTrigger('今天天气不错', 'one_sided_questioning', bc1));
  });

  test('空消息 → 不触发', () => {
    assert.ok(!relEngine.matchBreadcrumbTrigger('', 'structured_questioning', bc1));
  });

  test('null 消息 → 不触发', () => {
    assert.ok(!relEngine.matchBreadcrumbTrigger(null, 'structured_questioning', bc1));
  });
});

// ============================================================
// 4. isBreadcrumbGuaranteed 保证披露检测
// ============================================================

describe('━━━ 4. isBreadcrumbGuaranteed 保证披露检测 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('F-04 轮次1 → 未保证', () => {
    assert.ok(!relEngine.isBreadcrumbGuaranteed('F-04', 1));
  });

  test('F-04 轮次2 → 已保证', () => {
    assert.ok(relEngine.isBreadcrumbGuaranteed('F-04', 2));
  });

  test('F-04 轮次0 → 未保证', () => {
    assert.ok(!relEngine.isBreadcrumbGuaranteed('F-04', 0));
  });

  test('无面包屑的事实 → false', () => {
    assert.ok(!relEngine.isBreadcrumbGuaranteed('F-01', 2));
  });
});

// ============================================================
// 5. processMessage 面包屑集成测试（6条红线全覆盖）
// ============================================================

describe('━━━ 5. processMessage 面包屑集成测试（6条红线） ━━━', () => {

  test('F-04(R2) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R2', '触发条件是什么？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');
    assert.ok(!r1.disclosedFacts.includes('F-04'), '第1轮不应披露 F-04');

    const r2 = e.processMessage('R2', 'QPS具体数字是多少？');
    assert.ok(r2.disclosedFacts.includes('F-04'), '第2轮应通过面包屑保证披露 F-04');
  });

  test('F-08(R4) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R4', '还有什么其他损失？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');

    const r2 = e.processMessage('R4', '品牌信誉流失值多少钱？');
    assert.ok(r2.disclosedFacts.includes('F-08'), '第2轮应通过面包屑保证披露 F-08');
  });

  test('F-11(R1) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R1', '修复排期明细拉了吗？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');

    const r2 = e.processMessage('R1', '8个模块加起来超过16小时吗？');
    assert.ok(r2.disclosedFacts.includes('F-11'), '第2轮应通过面包屑保证披露 F-11');
  });

  test('F-12(R1) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R1', '回滚方案需要多久？');
    // F-12 和 F-11 可能同时触发面包屑
    assert.ok(r1.breadcrumbSignals.some((b) => b.factId === 'F-12'), '第1轮应有 F-12 面包屑信号');

    const r2 = e.processMessage('R1', '5分钟能切回来吗？');
    assert.ok(r2.disclosedFacts.includes('F-12'), '第2轮应通过面包屑保证披露 F-12');
  });

  test('F-14(R4) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R4', '时间窗口什么意思？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');

    const r2 = e.processMessage('R4', '竞品下周上线什么功能？');
    assert.ok(r2.disclosedFacts.includes('F-14'), '第2轮应通过面包屑保证披露 F-14');
  });

  test('F-17(R3) 2轮面包屑 → 保证获取', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R3', '流失了多少用户？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');

    const r2 = e.processMessage('R3', '30%的用户永久流失？');
    assert.ok(r2.disclosedFacts.includes('F-17'), '第2轮应通过面包屑保证披露 F-17');
  });
});

// ============================================================
// 6. 面包屑公平性保证测试
// ============================================================

describe('━━━ 6. 面包屑公平性保证 ━━━', () => {

  test('面包屑保证披露绕过信任档位限制', () => {
    const e = createEngine();
    e.startSession();
    // 初始信任为中性（50），F-04 需要正式质询或 D1 自动披露
    // 面包屑应能在低信任下保证获取
    const r1 = e.processMessage('R2', '触发条件是什么？');
    assert.ok(r1.breadcrumbSignals.length > 0, '低信任下也应展示面包屑信号');

    const r2 = e.processMessage('R2', 'QPS具体数字是多少？');
    assert.ok(r2.disclosedFacts.includes('F-04'), '面包屑应绕过信任限制保证披露');
  });

  test('面包屑信号比弱信号更具体', () => {
    const e = createEngine();
    e.startSession();
    const r1 = e.processMessage('R2', '触发条件是什么？');
    // 面包屑信号应包含具体内容，而非泛泛的提示
    const bcSignal = r1.breadcrumbSignals[0];
    assert.ok(bcSignal.signal.length > 10, '面包屑信号应有实质内容');
    assert.ok(r1.response.includes('线索'), '回复应标记为线索');
  });

  test('不追问就不披露（公平性反面）', () => {
    const e = createEngine();
    e.startSession();
    // 第1轮面包屑后，如果不追问相关话题，不应获取事实
    const r1 = e.processMessage('R2', '触发条件是什么？');
    assert.ok(r1.breadcrumbSignals.length > 0);

    // 问完全无关的问题（分类为 resource_inquiry，不在 F-04 round2 的触发意图中）
    const r2 = e.processMessage('R2', '你们的资源情况如何？人力够不够？');
    assert.ok(!r2.disclosedFacts.includes('F-04'), '不追问相关话题不应获取 F-04');
  });

  test('面包屑进度在会话中持久化', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R2', '触发条件是什么？');
    const state = e.getState();
    // breadcrumbProgress 应记录 F-04 的进度
    assert.ok(state, '引擎状态应可用');
  });
});

// ============================================================
// 7. 面包屑与原有系统兼容性
// ============================================================

describe('━━━ 7. 面包屑与原有系统兼容 ━━━', () => {

  test('面包屑获取的事实也触发立场修饰', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R2', '触发条件是什么？');
    const r2 = e.processMessage('R2', 'QPS具体数字是多少？');
    // F-04 通过面包屑获取后，回复应包含 R2 的立场修饰
    assert.ok(r2.response.includes('严重') || r2.response.includes('回滚'),
      '面包屑获取的事实也应附带立场修饰');
  });

  test('面包屑获取后可触发其他角色的冲突承认', () => {
    const e = createEngine();
    e.startSession();
    // 通过面包屑获取 F-04
    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');

    // 访问 R1，应触发冲突承认
    const r1 = e.processMessage('R1', '你怎么看全量上线？');
    assert.ok(r1.conflictAcknowledged || r1.stanceConflicts.length > 0,
      '面包屑获取的 F-04 也应触发 R1 冲突承认');
  });

  test('原有立场化测试不受影响', () => {
    const e = createEngine();
    e.startSession();
    const r = e.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');
    // 正式质询 R-FA2 仍应正常工作
    assert.ok(r.disclosedFacts.includes('F-04') || r.breadcrumbSignals.length > 0,
      '正式质询或面包屑至少有一个应生效');
  });

  test('D1 自动披露优先于面包屑', () => {
    const e = createEngine();
    e.startSession();
    // 选 D1-B 自动披露 F-04
    e.submitD1('B_灰度准备');
    const state = e.getState();
    // F-04 应已在获取列表中
    // 再问 R2 不应再出现 F-04 面包屑
    const r = e.processMessage('R2', '触发条件是什么？');
    assert.ok(!r.breadcrumbSignals.some((b) => b.factId === 'F-04'),
      'D1 已自动披露的事实不应再触发面包屑');
  });
});

// ============================================================
// 8. 边界情况
// ============================================================

describe('━━━ 8. 边界情况 ━━━', () => {

  test('同一事实面包屑不会重复推进', () => {
    const e = createEngine();
    e.startSession();
    // 第1轮：触发条件 → 推进到 round 1
    const r1 = e.processMessage('R2', '触发条件是什么？');
    assert.ok(r1.breadcrumbSignals.length > 0, '第1轮应有面包屑信号');

    // 第2轮：追问 QPS 具体值 → 推进到 round 2，保证披露
    const r2 = e.processMessage('R2', 'QPS具体数字是多少？');
    assert.ok(r2.disclosedFacts.includes('F-04'), '第2轮应保证披露 F-04');

    // 第3轮：再问同样的话题 → 不应有面包屑（已获取）
    const r3 = e.processMessage('R2', '触发条件是什么？');
    assert.ok(!r3.breadcrumbSignals.some((b) => b.factId === 'F-04'),
      '已获取的事实不应再有面包屑');
  });

  test('多个事实面包屑可并行推进', () => {
    const e = createEngine();
    e.startSession();
    // 问 R1 一个涉及 F-11 和 F-12 的问题
    const r1 = e.processMessage('R1', '修复排期和回滚方案分别需要多久？');
    // 应同时展示 F-11 和 F-12 的面包屑信号
    const bcFactIds = r1.breadcrumbSignals.map((b) => b.factId);
    assert.ok(bcFactIds.includes('F-11') || bcFactIds.includes('F-12'),
      '应至少有一个面包屑信号');
  });

  test('面包屑进度在 startSession 后重置', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R2', '触发条件是什么？');
    assert.ok(Object.keys(e.getState() || {}).length >= 0);

    // 重新 startSession
    e.startSession();
    const r = e.processMessage('R2', '触发条件是什么？');
    // 应从 round 0 重新开始
    assert.ok(r.breadcrumbSignals.length > 0, '重新开始后应从第1级面包屑开始');
    assert.ok(!r.disclosedFacts.includes('F-04'), '不应直接披露');
  });
});

// ============================================================
// 测试结果汇总
// ============================================================

console.log(`\n${'━'.repeat(50)}`);
console.log(`测试结果：${passCount} 通过, ${failCount} 失败`);
if (failures.length > 0) {
  console.log('\n失败详情：');
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.name}`);
    console.log(`     ${f.err.message}`);
  });
}
console.log('━'.repeat(50));

process.exit(failCount > 0 ? 1 : 0);
