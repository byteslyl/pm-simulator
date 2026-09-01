/**
 * stance.test.js - 角色立场化单元测试
 *
 * 测试范围：
 *   1. getStanceReaction — 立场修饰语查询
 *   2. detectStanceConflict — 冲突检测
 *   3. getConflictAcknowledgment — 冲突承认语查询
 *   4. getRoleStance — 角色立场信息
 *   5. processMessage 立场化集成测试
 *   6. 冲突去重测试
 *   7. 边界情况测试
 */

'use strict';

const assert = require('assert');
const { createEngine } = require('../engine');
const { createRelationshipEngine } = require('../engine/relationship_engine');

// ============================================================
// 测试工具
// ============================================================

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
// 1. getStanceReaction 测试
// ============================================================

describe('━━━ 1. getStanceReaction 立场修饰语查询 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('R1 对 F-06 有立场修饰语', () => {
    const reaction = relEngine.getStanceReaction('R1', 'F-06');
    assert.ok(reaction, 'R1 对 F-06 应有立场修饰语');
    assert.ok(reaction.includes('问题不大') || reaction.includes('加班'), 'R1 对 F-06 应淡化修复风险');
  });

  test('R1 对 F-12 有立场修饰语', () => {
    const reaction = relEngine.getStanceReaction('R1', 'F-12');
    assert.ok(reaction, 'R1 对 F-12 应有立场修饰语');
    assert.ok(reaction.includes('5分钟') || reaction.includes('放心'), 'R1 对 F-12 应自信表态');
  });

  test('R2 对 F-04 有立场修饰语且放大风险', () => {
    const reaction = relEngine.getStanceReaction('R2', 'F-04');
    assert.ok(reaction, 'R2 对 F-04 应有立场修饰语');
    assert.ok(reaction.includes('严重') || reaction.includes('回滚'), 'R2 对 F-04 应放大风险');
  });

  test('R3 对 F-09 有立场修饰语', () => {
    const reaction = relEngine.getStanceReaction('R3', 'F-09');
    assert.ok(reaction, 'R3 对 F-09 应有立场修饰语');
  });

  test('R4 对 F-08 有立场修饰语', () => {
    const reaction = relEngine.getStanceReaction('R4', 'F-08');
    assert.ok(reaction, 'R4 对 F-08 应有立场修饰语');
    assert.ok(reaction.includes('110万') || reaction.includes('品牌'), 'R4 对 F-08 应展开隐性成本');
  });

  test('不存在的角色返回 null', () => {
    const reaction = relEngine.getStanceReaction('R99', 'F-04');
    assert.strictEqual(reaction, null);
  });

  test('角色对未配置的事实返回 null', () => {
    // F-01 是 ALL 持有，不在任何角色的 stance_reactions 中
    const reaction = relEngine.getStanceReaction('R1', 'F-01');
    assert.strictEqual(reaction, null);
  });
});

// ============================================================
// 2. detectStanceConflict 冲突检测测试
// ============================================================

describe('━━━ 2. detectStanceConflict 冲突检测 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('学生持有 F-04(R2) → 与 R1 立场冲突', () => {
    const conflicts = relEngine.detectStanceConflict('R1', ['F-04']);
    assert.strictEqual(conflicts.length, 1, '应有1个冲突');
    assert.strictEqual(conflicts[0].factId, 'F-04');
    assert.ok(conflicts[0].acknowledgment.includes('阈值') || conflicts[0].acknowledgment.includes('灰度'),
      'R1 承认语应提到阈值或灰度');
  });

  test('学生持有 F-04(R2) → 与 R3 立场冲突', () => {
    const conflicts = relEngine.detectStanceConflict('R3', ['F-04']);
    assert.strictEqual(conflicts.length, 1, '应有1个冲突');
    assert.ok(conflicts[0].acknowledgment.includes('活动') || conflicts[0].acknowledgment.includes('灰度'),
      'R3 承认语应提到活动或灰度');
  });

  test('学生持有 F-04(R2) → 与 R4 立场冲突', () => {
    const conflicts = relEngine.detectStanceConflict('R4', ['F-04']);
    assert.strictEqual(conflicts.length, 1, '应有1个冲突');
    assert.ok(conflicts[0].acknowledgment.includes('灰度') || conflicts[0].acknowledgment.includes('推进'),
      'R4 承认语应提到灰度或推进');
  });

  test('学生不持有冲突事实 → 无冲突', () => {
    const conflicts = relEngine.detectStanceConflict('R1', ['F-01', 'F-02', 'F-03']);
    assert.strictEqual(conflicts.length, 0, '不应有冲突');
  });

  test('学生持有自己角色的事实 → 不触发冲突', () => {
    // R2 持有 F-04, 但 F-04 不在 R2 的 conflict_acknowledgments 中
    const conflicts = relEngine.detectStanceConflict('R2', ['F-04']);
    assert.strictEqual(conflicts.length, 0, '自己的事实不应触发冲突');
  });

  test('ALL 持有的事实不触发冲突', () => {
    // F-01 是 ALL 持有
    const conflicts = relEngine.detectStanceConflict('R1', ['F-01']);
    assert.strictEqual(conflicts.length, 0, 'ALL 事实不应触发冲突');
  });

  test('多个冲突事实同时检测', () => {
    // R1 对 F-04 有 conflict_acknowledgment
    // R1 对 F-07 有 conflict_acknowledgment
    const conflicts = relEngine.detectStanceConflict('R1', ['F-04', 'F-07']);
    assert.strictEqual(conflicts.length, 2, '应有2个冲突');
  });

  test('不存在的角色返回空数组', () => {
    const conflicts = relEngine.detectStanceConflict('R99', ['F-04']);
    assert.strictEqual(conflicts.length, 0);
  });
});

// ============================================================
// 3. getConflictAcknowledgment 冲突承认语测试
// ============================================================

describe('━━━ 3. getConflictAcknowledgment 冲突承认语 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('R1 对 F-04 有承认语', () => {
    const ack = relEngine.getConflictAcknowledgment('R1', 'F-04');
    assert.ok(ack, 'R1 对 F-04 应有承认语');
    assert.ok(ack.length > 10, '承认语不应为空');
  });

  test('R2 对 F-12 有承认语', () => {
    const ack = relEngine.getConflictAcknowledgment('R2', 'F-12');
    assert.ok(ack, 'R2 对 F-12 应有承认语');
  });

  test('R1 对 F-99(不存在) 返回 null', () => {
    const ack = relEngine.getConflictAcknowledgment('R1', 'F-99');
    assert.strictEqual(ack, null);
  });

  test('R2 对 F-04(自己持有) 无承认语', () => {
    // R2 持有 F-04, 不需要承认自己的事实
    const ack = relEngine.getConflictAcknowledgment('R2', 'F-04');
    assert.strictEqual(ack, null, 'R2 对自己持有的 F-04 不应有承认语');
  });
});

// ============================================================
// 4. getRoleStance 角色立场信息测试
// ============================================================

describe('━━━ 4. getRoleStance 角色完整立场信息 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('R1 立场信息完整', () => {
    const stance = relEngine.getRoleStance('R1');
    assert.ok(stance, '应返回 R1 立场信息');
    assert.ok(stance.agenda, '应有 agenda');
    assert.ok(stance.bias, '应有 bias');
    assert.ok(stance.stance, '应有 stance');
    assert.ok(stance.surface_stance, '应有 surface_stance');
    assert.ok(stance.deep_interest, '应有 deep_interest');
    assert.ok(stance.bottom_line, '应有 bottom_line');
    assert.ok(stance.moveable_zone, '应有 moveable_zone');
  });

  test('R2 立场信息包含 agenda', () => {
    const stance = relEngine.getRoleStance('R2');
    assert.ok(stance.agenda, 'R2 应有 agenda');
    assert.ok(stance.agenda.includes('追责') || stance.agenda.includes('QA'), 'R2 agenda 应提到追责');
  });

  test('R3 立场信息包含 agenda', () => {
    const stance = relEngine.getRoleStance('R3');
    assert.ok(stance.agenda, 'R3 应有 agenda');
    assert.ok(stance.agenda.includes('活动') || stance.agenda.includes('隐瞒'), 'R3 agenda 应提到活动或隐瞒');
  });

  test('R4 立场信息包含 agenda', () => {
    const stance = relEngine.getRoleStance('R4');
    assert.ok(stance.agenda, 'R4 应有 agenda');
    assert.ok(stance.agenda.includes('竞品') || stance.agenda.includes('窗口'), 'R4 agenda 应提到竞品或窗口');
  });

  test('不存在的角色返回 null', () => {
    const stance = relEngine.getRoleStance('R99');
    assert.strictEqual(stance, null);
  });
});

// ============================================================
// 5. processMessage 立场化集成测试
// ============================================================

describe('━━━ 5. processMessage 立场化集成测试 ━━━', () => {

  test('R2 披露 F-04 时回复包含立场修饰语', () => {
    const engine = createEngine();
    engine.startSession();
    const result = engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    assert.ok(result.disclosedFacts.includes('F-04'), '应披露 F-04');
    assert.ok(result.response.includes('严重') || result.response.includes('回滚'),
      '回复应包含 R2 的立场修饰（放大风险）');
  });

  test('R1 披露 F-12 时回复包含立场修饰语', () => {
    const engine = createEngine();
    engine.startSession();
    // 使用风险求证类问题触发 F-12 披露
    const result = engine.processMessage('R1', '万一出问题，回滚方案是什么？需要多久止血？');

    if (result.disclosedFacts.includes('F-12')) {
      assert.ok(result.response.includes('5分钟') || result.response.includes('放心'),
        '回复应包含 R1 对 F-12 的自信表态');
    }
  });

  test('学生持有 F-04 后访问 R1 → 触发冲突承认', () => {
    const engine = createEngine();
    engine.startSession();

    // 先从 R2 获取 F-04（需包含用途说明触发 R-FA2 正式质询）
    engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    // 再访问 R1，应触发冲突承认
    const result = engine.processMessage('R1', '你觉得全量上线安全吗？');

    assert.ok(result.stanceConflicts.length > 0 || result.conflictAcknowledged,
      '应检测到立场冲突或已承认冲突');
    assert.ok(result.response.includes('阈值') || result.response.includes('灰度') || result.response.includes('风险'),
      'R1 回复应包含冲突承认语');
  });

  test('学生持有 F-04 后访问 R3 → R3 承认冲突但坚持活动不可取消', () => {
    const engine = createEngine();
    engine.startSession();

    // 先从 R2 获取 F-04（需包含用途说明触发 R-FA2 正式质询）
    engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    // 再访问 R3
    const result = engine.processMessage('R3', '你觉得应该上线吗？');

    if (result.conflictAcknowledged) {
      assert.ok(result.response.includes('活动'), 'R3 冲突承认后应仍提到活动');
    }
  });

  test('无冲突时回复不包含冲突承认', () => {
    const engine = createEngine();
    engine.startSession();

    // 只问 R1，不从其他角色获取冲突事实
    const result = engine.processMessage('R1', '修复需要多久？');

    assert.strictEqual(result.stanceConflicts.length, 0, '不应有立场冲突');
    assert.strictEqual(result.conflictAcknowledged, false, '不应触发冲突承认');
  });
});

// ============================================================
// 6. 冲突去重测试
// ============================================================

describe('━━━ 6. 冲突去重测试 ━━━', () => {

  test('同一冲突只承认一次', () => {
    const engine = createEngine();
    engine.startSession();

    // 从 R2 获取 F-04（需包含用途说明触发 R-FA2 正式质询）
    engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    // 第一次访问 R1 → 触发冲突
    const r1 = engine.processMessage('R1', '你怎么看全量上线？');
    assert.ok(r1.conflictAcknowledged, '第一次应触发冲突承认');

    // 第二次访问 R1 → 不再触发
    const r2 = engine.processMessage('R1', '再说说你的看法');
    assert.strictEqual(r2.stanceConflicts.length, 0, '第二次不应有新冲突');
    assert.strictEqual(r2.conflictAcknowledged, false, '第二次不应再触发承认');
  });

  test('不同角色的同一冲突事实分别承认', () => {
    const engine = createEngine();
    engine.startSession();

    // 从 R2 获取 F-04（需包含用途说明触发 R-FA2 正式质询）
    engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    // 访问 R1 → 冲突
    const r1 = engine.processMessage('R1', '你怎么看？');
    assert.ok(r1.conflictAcknowledged, 'R1 应触发冲突');

    // 访问 R3 → 也应冲突（不同角色，不共享去重）
    const r3 = engine.processMessage('R3', '你觉得呢？');
    assert.ok(r3.conflictAcknowledged, 'R3 也应触发冲突');
  });

  test('多个冲突事实各自独立去重', () => {
    const engine = createEngine();
    engine.startSession();

    // 获取 F-04 和 F-07（两个都在 R1 的 conflict_acknowledgments 中）
    engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');  // F-04 via R-FA2
    // 需要提升信任度才能获取 F-07，先做几轮沟通
    engine.processMessage('R2', '我们商量一下灰度方案');  // plan_negotiation
    engine.processMessage('R2', '如果灰度比例控制好呢？');  // 继续追问

    // 访问 R1 → 应有冲突
    const r1 = engine.processMessage('R1', '你怎么看全量上线？');
    const firstConflictCount = r1.stanceConflicts.length;
    assert.ok(firstConflictCount >= 1, '至少应有1个冲突');

    // 再访问 R1 → 不应有新冲突
    const r2 = engine.processMessage('R1', '还有别的想法吗？');
    assert.strictEqual(r2.stanceConflicts.length, 0, '不应有重复冲突');
  });
});

// ============================================================
// 7. 边界情况测试
// ============================================================

describe('━━━ 7. 边界情况 ━━━', () => {

  test('空获取事实列表 → 无冲突', () => {
    const relEngine = createRelationshipEngine();
    const conflicts = relEngine.detectStanceConflict('R1', []);
    assert.strictEqual(conflicts.length, 0);
  });

  test('未启动会话直接调用 processMessage → 抛出错误', () => {
    const engine = createEngine();
    assert.throws(
      () => engine.processMessage('R1', 'test'),
      /会话未初始化/
    );
  });

  test('getStanceReaction 对 null factId 返回 null', () => {
    const relEngine = createRelationshipEngine();
    const reaction = relEngine.getStanceReaction('R1', null);
    assert.strictEqual(reaction, null);
  });

  test('detectStanceConflict 对空角色返回空数组', () => {
    const relEngine = createRelationshipEngine();
    const conflicts = relEngine.detectStanceConflict(null, ['F-04']);
    assert.strictEqual(conflicts.length, 0);
  });

  test('D1 自动披露后访问其他角色也能触发冲突', () => {
    const engine = createEngine();
    engine.startSession();

    // 选 D1-B 会自动披露 F-04 和 F-12
    engine.submitD1('B_灰度准备');

    // 此时学生已持有 F-04，访问 R3 应触发冲突
    const result = engine.processMessage('R3', '你觉得应该怎么上线？');
    assert.ok(result.conflictAcknowledged || result.stanceConflicts.length > 0,
      'D1 自动披露的 F-04 也应触发 R3 冲突');
  });

  test('立场修饰语不影响事实内容本身', () => {
    const engine = createEngine();
    engine.startSession();
    const result = engine.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    if (result.disclosedFacts.includes('F-04')) {
      // 事实内容应完整存在
      assert.ok(result.response.includes('QPS>2500'), '事实内容 QPS>2500 应在回复中');
      assert.ok(result.response.includes('F-04'), '事实编号 F-04 应在回复中');
    }
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
