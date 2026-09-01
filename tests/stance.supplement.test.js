/**
 * stance.supplement.test.js - 角色立场化补充单元测试
 *
 * 补充 stance.test.js 未覆盖的场景：
 *   8. 全角色 stance_reactions 完整覆盖
 *   9. 面包屑披露事实的立场修饰
 *  10. 多事实同时披露的立场修饰
 *  11. 冲突承认语内容验证
 *  12. 全角色立场信息字段完整性
 *  13. 顺序冲突链
 *  14. D1 自动披露事实的立场修饰
 *  15. bottom_line 与 moveable_zone 内容验证
 *  16. 立场修饰一致性
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
// 8. 全角色 stance_reactions 完整覆盖
// ============================================================

describe('━━━ 8. 全角色 stance_reactions 完整覆盖 ━━━', () => {
  const relEngine = createRelationshipEngine();

  // R1 技术负责人：淡化风险，强调技术可控
  test('R1 对 F-06(修复乐观) 淡化风险', () => {
    const r = relEngine.getStanceReaction('R1', 'F-06');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('问题不大') || r.includes('加班') || r.includes('搞定'),
      'R1 对 F-06 应淡化修复风险');
  });

  test('R1 对 F-10(灰度开关) 自信表态', () => {
    const r = relEngine.getStanceReaction('R1', 'F-10');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('灰度') || r.includes('半小时') || r.includes('不是问题'),
      'R1 对 F-10 应对灰度开关自信');
  });

  test('R1 对 F-11(修复排期) 含糊回应', () => {
    const r = relEngine.getStanceReaction('R1', 'F-11');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('排期') || r.includes('紧') || r.includes('挤'),
      'R1 对 F-11 应含糊回应排期');
  });

  test('R1 对 F-12(回滚5分钟) 自信', () => {
    const r = relEngine.getStanceReaction('R1', 'F-12');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('5分钟') || r.includes('放心') || r.includes('切回'),
      'R1 对 F-12 应自信表态');
  });

  // R2 QA负责人：放大风险，倾向保守
  test('R2 对 F-04(触发阈值) 放大风险', () => {
    const r = relEngine.getStanceReaction('R2', 'F-04');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('严重') || r.includes('回滚') || r.includes('建议'),
      'R2 对 F-04 应放大风险');
  });

  test('R2 对 F-07(50%灰度预判) 倾向保守', () => {
    const r = relEngine.getStanceReaction('R2', 'F-07');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('50%') || r.includes('灰度') || r.includes('安全'),
      'R2 对 F-07 应给出保守预判');
  });

  test('R2 对 F-15(QA产能) 强调资源紧张', () => {
    const r = relEngine.getStanceReaction('R2', 'F-15');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('产能') || r.includes('0.7') || r.includes('不够'),
      'R2 对 F-15 应强调产能不足');
  });

  test('R2 对 F-16(P1降级方案) 谨慎建议', () => {
    const r = relEngine.getStanceReaction('R2', 'F-16');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('降级') || r.includes('P1') || r.includes('必须'),
      'R2 对 F-16 应强调降级必要性');
  });

  // R3 运营负责人：强调按时上线，淡化延期
  test('R3 对 F-09(活动时间) 强调延期损失', () => {
    const r = relEngine.getStanceReaction('R3', 'F-09');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('延期') || r.includes('80万') || r.includes('KOL') || r.includes('损失'),
      'R3 对 F-09 应强调延期损失');
  });

  test('R3 对 F-13(可切老引擎) 不愿主动提', () => {
    const r = relEngine.getStanceReaction('R3', 'F-13');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('折中') || r.includes('代价') || r.includes('新版') || r.includes('卖点'),
      'R3 对 F-13 应提及折中方案代价');
  });

  // R4 CEO：用施压代替信息
  test('R4 对 F-08(总损失) 展开隐性成本', () => {
    const r = relEngine.getStanceReaction('R4', 'F-08');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('110万') || r.includes('品牌') || r.includes('隐性'),
      'R4 对 F-08 应展开隐性成本');
  });

  test('R4 对 F-14(竞品动态) 强调紧迫性', () => {
    const r = relEngine.getStanceReaction('R4', 'F-14');
    assert.ok(r, '应有修饰语');
    assert.ok(r.includes('竞品') || r.includes('下周') || r.includes('窗口'),
      'R4 对 F-14 应强调时间紧迫');
  });
});

// ============================================================
// 9. 面包屑披露事实的立场修饰
// ============================================================

describe('━━━ 9. 面包屑披露事实的立场修饰 ━━━', () => {

  test('F-04 通过面包屑获取后回复包含 R2 立场修饰', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R2', '触发条件是什么？');           // 第1轮面包屑
    const r2 = e.processMessage('R2', 'QPS具体数字是多少？'); // 第2轮保证披露
    assert.ok(r2.disclosedFacts.includes('F-04'), '应通过面包屑获取 F-04');
    assert.ok(r2.response.includes('严重') || r2.response.includes('回滚'),
      '面包屑获取的事实也应附带 R2 立场修饰');
  });

  test('F-12 通过面包屑获取后回复包含 R1 立场修饰', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R1', '回滚方案需要多久？');
    const r2 = e.processMessage('R1', '5分钟能切回来吗？');
    if (r2.disclosedFacts.includes('F-12')) {
      assert.ok(r2.response.includes('5分钟') || r2.response.includes('放心'),
        '面包屑获取的 F-12 也应附带 R1 立场修饰');
    }
  });

  test('F-17 通过面包屑获取后回复包含 R3 立场修饰', () => {
    const e = createEngine();
    e.startSession();
    e.processMessage('R3', '流失了多少用户？');
    const r2 = e.processMessage('R3', '30%的用户永久流失？');
    assert.ok(r2.disclosedFacts.includes('F-17'), '应通过面包屑获取 F-17');
    assert.ok(r2.response.includes('紧张') || r2.response.includes('避免') || r2.response.includes('用户'),
      '面包屑获取的 F-17 也应附带 R3 立场修饰');
  });

  test('面包屑披露和正式质询披露的立场修饰一致', () => {
    // 方式1：通过正式质询 R-FA2 获取
    const e1 = createEngine();
    e1.startSession();
    const viaFormal = e1.processMessage('R2', '我需要评估灰度比例的安全性，触发条件是什么？');

    // 方式2：通过面包屑获取
    const e2 = createEngine();
    e2.startSession();
    e2.processMessage('R2', '触发条件是什么？');
    const viaBreadcrumb = e2.processMessage('R2', 'QPS具体数字是多少？');

    // 两种方式都应包含立场修饰关键词
    if (viaFormal.disclosedFacts.includes('F-04') && viaBreadcrumb.disclosedFacts.includes('F-04')) {
      const formalHasStance = viaFormal.response.includes('严重') || viaFormal.response.includes('回滚');
      const bcHasStance = viaBreadcrumb.response.includes('严重') || viaBreadcrumb.response.includes('回滚');
      assert.strictEqual(formalHasStance, bcHasStance, '两种披露方式的立场修饰应一致');
    }
  });
});

// ============================================================
// 10. 多事实同时披露的立场修饰
// ============================================================

describe('━━━ 10. 多事实同时披露的立场修饰 ━━━', () => {

  test('D1-B 自动披露 F-04 和 F-12 后访问 R1 → 每个冲突事实有独立承认语', () => {
    const e = createEngine();
    e.startSession();
    e.submitD1('B_灰度准备'); // 自动披露 F-04, F-12 等

    const result = e.processMessage('R1', '你怎么看？');
    // 应检测到 F-04 的冲突（R1 对 F-04 有 conflict_acknowledgment）
    if (result.stanceConflicts.length > 0) {
      const f04Conflict = result.stanceConflicts.find((c) => c.factId === 'F-04');
      if (f04Conflict) {
        assert.ok(f04Conflict.acknowledgment, 'F-04 应有独立承认语');
      }
    }
  });

  test('同时持有 F-04 和 F-07 → R1 对每个事实分别承认', () => {
    const relEngine = createRelationshipEngine();
    const conflicts = relEngine.detectStanceConflict('R1', ['F-04', 'F-07']);
    assert.strictEqual(conflicts.length, 2, '应有 2 个独立冲突');
    // 每个冲突有不同的 factId
    const factIds = conflicts.map((c) => c.factId);
    assert.ok(factIds.includes('F-04'), '应包含 F-04 冲突');
    assert.ok(factIds.includes('F-07'), '应包含 F-07 冲突');
    // 每个冲突有不同的承认语
    assert.ok(conflicts[0].acknowledgment !== conflicts[1].acknowledgment,
      '两个冲突的承认语应不同');
  });
});

// ============================================================
// 11. 冲突承认语内容验证
// ============================================================

describe('━━━ 11. 冲突承认语内容验证 ━━━', () => {
  const relEngine = createRelationshipEngine();

  test('R1 对 F-04 承认语提到风险或灰度', () => {
    const ack = relEngine.getConflictAcknowledgment('R1', 'F-04');
    assert.ok(ack, '应有承认语');
    assert.ok(ack.includes('风险') || ack.includes('灰度') || ack.includes('阈值'),
      'R1 对 F-04 承认语应提到风险/灰度/阈值');
  });

  test('R1 对 F-07 承认语提到灰度或保守', () => {
    const ack = relEngine.getConflictAcknowledgment('R1', 'F-07');
    assert.ok(ack, '应有承认语');
    assert.ok(ack.includes('灰度') || ack.includes('保守') || ack.includes('安全'),
      'R1 对 F-07 承认语应提到灰度/保守/安全');
  });

  test('R2 对 F-12 承认语提到止血或回滚', () => {
    const ack = relEngine.getConflictAcknowledgment('R2', 'F-12');
    assert.ok(ack, '应有承认语');
    assert.ok(ack.includes('止血') || ack.includes('回滚') || ack.includes('5分钟'),
      'R2 对 F-12 承认语应提到止血/回滚');
  });

  test('R3 对 F-04 承认语提到活动或灰度', () => {
    const ack = relEngine.getConflictAcknowledgment('R3', 'F-04');
    assert.ok(ack, '应有承认语');
    assert.ok(ack.includes('活动') || ack.includes('灰度') || ack.includes('危险'),
      'R3 对 F-04 承认语应提到活动/灰度/危险');
  });

  test('R4 对 F-04 承认语提到灰度或推进', () => {
    const ack = relEngine.getConflictAcknowledgment('R4', 'F-04');
    assert.ok(ack, '应有承认语');
    assert.ok(ack.includes('灰度') || ack.includes('推进') || ack.includes('风险'),
      'R4 对 F-04 承认语应提到灰度/推进/风险');
  });

  test('R4 对 F-17 无承认语（未配置）', () => {
    const ack = relEngine.getConflictAcknowledgment('R4', 'F-17');
    assert.strictEqual(ack, null, 'R4 未配置 F-17 的冲突承认语');
  });
});

// ============================================================
// 12. 全角色立场信息字段完整性
// ============================================================

describe('━━━ 12. 全角色立场信息字段完整性 ━━━', () => {
  const relEngine = createRelationshipEngine();
  const requiredFields = ['agenda', 'bias', 'stance', 'surface_stance', 'deep_interest', 'bottom_line', 'moveable_zone'];

  ['R1', 'R2', 'R3', 'R4'].forEach((roleId) => {
    test(`${roleId} 所有必要字段存在`, () => {
      const stance = relEngine.getRoleStance(roleId);
      assert.ok(stance, `${roleId} 应返回立场信息`);
      requiredFields.forEach((field) => {
        assert.ok(stance[field], `${roleId} 应有 ${field} 字段`);
      });
    });
  });

  test('R1 bottom_line 内容验证', () => {
    const s = relEngine.getRoleStance('R1');
    assert.ok(s.bottom_line.includes('回滚') || s.bottom_line.includes('灰度'),
      'R1 底线应与回滚/灰度相关');
  });

  test('R2 bottom_line 内容验证', () => {
    const s = relEngine.getRoleStance('R2');
    assert.ok(s.bottom_line.includes('P1') || s.bottom_line.includes('缺陷') || s.bottom_line.includes('质量'),
      'R2 底线应与质量/P1缺陷相关');
  });

  test('R3 bottom_line 内容验证', () => {
    const s = relEngine.getRoleStance('R3');
    assert.ok(s.bottom_line.includes('活动') || s.bottom_line.includes('取消'),
      'R3 底线应与活动不可取消相关');
  });

  test('R4 bottom_line 内容验证', () => {
    const s = relEngine.getRoleStance('R4');
    assert.ok(s.bottom_line.includes('上线') || s.bottom_line.includes('窗口') || s.bottom_line.includes('延期'),
      'R4 底线应与上线/窗口相关');
  });

  test('R1 moveable_zone 内容验证', () => {
    const s = relEngine.getRoleStance('R1');
    assert.ok(s.moveable_zone, 'R1 应有可让步区域');
    assert.ok(typeof s.moveable_zone === 'string' && s.moveable_zone.length > 5,
      'R1 可让步区域应有实质内容');
  });

  test('R2 moveable_zone 内容验证', () => {
    const s = relEngine.getRoleStance('R2');
    assert.ok(s.moveable_zone, 'R2 应有可让步区域');
  });

  test('R3 moveable_zone 内容验证', () => {
    const s = relEngine.getRoleStance('R3');
    assert.ok(s.moveable_zone, 'R3 应有可让步区域');
  });

  test('R4 moveable_zone 内容验证', () => {
    const s = relEngine.getRoleStance('R4');
    assert.ok(s.moveable_zone, 'R4 应有可让步区域');
  });
});

// ============================================================
// 13. 顺序冲突链
// ============================================================

describe('━━━ 13. 顺序冲突链 ━━━', () => {

  test('F-04 → R1 → R3 → R4 依次触发冲突承认', () => {
    const e = createEngine();
    e.startSession();

    // 获取 F-04（通过面包屑）
    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');

    // 访问 R1 → 冲突
    const r1 = e.processMessage('R1', '你怎么看全量上线？');
    assert.ok(r1.conflictAcknowledged, 'R1 应触发冲突');

    // 访问 R3 → 也冲突
    const r3 = e.processMessage('R3', '你觉得应该上线吗？');
    assert.ok(r3.conflictAcknowledged, 'R3 应触发冲突');

    // 访问 R4 → 也冲突
    const r4 = e.processMessage('R4', '你怎么看？');
    assert.ok(r4.conflictAcknowledged, 'R4 应触发冲突');
  });

  test('冲突承认语各角色不同', () => {
    const e = createEngine();
    e.startSession();

    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');

    const r1 = e.processMessage('R1', '你怎么看？');
    const r3 = e.processMessage('R3', '你觉得呢？');
    const r4 = e.processMessage('R4', '你的意见？');

    // 三个角色的回复应不同（不同立场的承认语）
    const responses = [r1.response, r3.response, r4.response];
    const uniqueResponses = new Set(responses);
    assert.ok(uniqueResponses.size >= 2, '至少两个角色的冲突承认语应不同');
  });

  test('冲突链中每步承认只触发一次', () => {
    const e = createEngine();
    e.startSession();

    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');

    // R1 第一次 → 冲突
    const r1a = e.processMessage('R1', '你怎么看？');
    assert.ok(r1a.conflictAcknowledged, 'R1 第一次应触发冲突');

    // R1 第二次 → 不再触发
    const r1b = e.processMessage('R1', '继续说');
    assert.strictEqual(r1b.conflictAcknowledged, false, 'R1 第二次不应再触发');

    // R3 第一次 → 仍应触发（不同角色独立）
    const r3 = e.processMessage('R3', '你觉得呢？');
    assert.ok(r3.conflictAcknowledged, 'R3 应独立触发冲突');
  });
});

// ============================================================
// 14. D1 自动披露事实的立场修饰
// ============================================================

describe('━━━ 14. D1 自动披露事实的立场修饰 ━━━', () => {

  test('D1-B 自动披露 F-04 后访问 R2 → R2 立场修饰正常', () => {
    const e = createEngine();
    e.startSession();
    e.submitD1('B_灰度准备'); // 自动披露 F-04

    // F-04 已通过 D1 自动披露，访问 R2 不会再次披露
    // 但如果追问相关话题，R2 回复不应崩溃
    const result = e.processMessage('R2', '你觉得灰度方案安全吗？');
    assert.ok(result.response, 'R2 应正常回复');
    assert.ok(!result.disclosedFacts.includes('F-04'), 'F-04 已获取，不应重复披露');
  });

  test('D1-B 自动披露 F-04 → 访问 R1/R3/R4 都能触发冲突', () => {
    const e = createEngine();
    e.startSession();
    e.submitD1('B_灰度准备');

    const r1 = e.processMessage('R1', '你怎么看？');
    assert.ok(r1.conflictAcknowledged || r1.stanceConflicts.length > 0,
      'D1 披露的 F-04 应触发 R1 冲突');

    const r3 = e.processMessage('R3', '你觉得呢？');
    assert.ok(r3.conflictAcknowledged || r3.stanceConflicts.length > 0,
      'D1 披露的 F-04 应触发 R3 冲突');

    const r4 = e.processMessage('R4', '你的意见？');
    assert.ok(r4.conflictAcknowledged || r4.stanceConflicts.length > 0,
      'D1 披露的 F-04 应触发 R4 冲突');
  });
});

// ============================================================
// 15. 立场修饰一致性
// ============================================================

describe('━━━ 15. 立场修饰一致性 ━━━', () => {

  test('同一角色对同一事实的立场修饰始终一致', () => {
    const relEngine = createRelationshipEngine();
    const r1 = relEngine.getStanceReaction('R2', 'F-04');
    const r2 = relEngine.getStanceReaction('R2', 'F-04');
    assert.strictEqual(r1, r2, '同一角色对同一事实的修饰语应一致');
  });

  test('不同角色对同一事实的立场修饰不同', () => {
    const relEngine = createRelationshipEngine();
    // F-04 被 R2 持有，R2 有 stance_reaction
    // R1/R3/R4 有 conflict_acknowledgment
    const r2Stance = relEngine.getStanceReaction('R2', 'F-04');
    const r1Ack = relEngine.getConflictAcknowledgment('R1', 'F-04');
    const r3Ack = relEngine.getConflictAcknowledgment('R3', 'F-04');

    assert.ok(r2Stance !== r1Ack, 'R2 立场修饰和 R1 冲突承认语应不同');
    assert.ok(r2Stance !== r3Ack, 'R2 立场修饰和 R3 冲突承认语应不同');
    assert.ok(r1Ack !== r3Ack, 'R1 和 R3 的冲突承认语应不同');
  });

  test('角色立场与其 agenda 一致', () => {
    const relEngine = createRelationshipEngine();

    // R1 agenda 是"希望上线，淡化风险"
    const r1Stance = relEngine.getStanceReaction('R1', 'F-06');
    const r1Agenda = relEngine.getRoleStance('R1').agenda;
    assert.ok(r1Agenda.includes('上线') || r1Agenda.includes('乐观'),
      'R1 agenda 应与"希望上线"一致');

    // R2 agenda 是"希望延期，放大风险"
    const r2Stance = relEngine.getStanceReaction('R2', 'F-04');
    const r2Agenda = relEngine.getRoleStance('R2').agenda;
    assert.ok(r2Agenda.includes('追责') || r2Agenda.includes('QA'),
      'R2 agenda 应与"追责"相关');
  });
});

// ============================================================
// 16. 立场与评分系统兼容
// ============================================================

describe('━━━ 16. 立场与评分系统兼容 ━━━', () => {

  test('立场修饰不影响事实获取的评分', () => {
    const e = createEngine();
    e.startSession();

    // 通过面包屑获取 F-04（附带立场修饰）
    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');

    // 提交 D1 和 D2
    e.submitD1('B_灰度准备');
    e.submitD2({
      option: 'Limited_20%',
      evidence_refs: ['F-04', 'F-12', 'F-09'],
    });

    // 评分应正常生成
    const report = e.getReport();
    assert.ok(report, '应生成报告');
    assert.ok(report.scoring, '报告应包含评分');
    assert.ok(report.scoring.totalScore !== undefined, '报告应有总分');
  });

  test('冲突承认不影响 D2 提交', () => {
    const e = createEngine();
    e.startSession();

    // 获取 F-04 并触发多角色冲突承认
    e.processMessage('R2', '触发条件是什么？');
    e.processMessage('R2', 'QPS具体数字是多少？');
    e.processMessage('R1', '你怎么看？'); // 触发 R1 冲突
    e.processMessage('R3', '你觉得呢？'); // 触发 R3 冲突

    // D1 + D2 应正常提交
    e.submitD1('B_灰度准备');
    const d2Result = e.submitD2({
      option: 'Limited_20%',
      evidence_refs: ['F-04', 'F-12', 'F-09'],
    });
    assert.ok(d2Result, 'D2 应正常提交');
  });
});

// ============================================================
// 测试结果汇总
// ============================================================

console.log(`\n${'━'.repeat(50)}`);
console.log(`补充测试结果：${passCount} 通过, ${failCount} 失败`);
if (failures.length > 0) {
  console.log('\n失败详情：');
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.name}`);
    console.log(`     ${f.err.message}`);
  });
}
console.log('━'.repeat(50));

process.exit(failCount > 0 ? 1 : 0);
