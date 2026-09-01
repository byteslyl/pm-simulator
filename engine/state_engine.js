/**
 * state_engine.js - 状态机引擎（v0.1）
 *
 * 职责：管理 S1(项目整体进度)、S2(线上质量风险)、S3(干系人组织支持度)
 * 三个状态变量，按 D1 选择与 D2 决策计算最终状态。
 *
 * S1: 连续 0-100，表示项目整体进度
 * S2: 离散 低/中/高，表示线上质量风险，有 tier_boundaries 定义
 * S3: 连续 0-100，表示干系人组织支持度
 */

'use strict';

const scenarioData = require('./scenario_data.json');

// 从 scenario_data.json 提取状态变量定义
const STATE_VARS = scenarioData.state_variables || [];
const S1_DEF = STATE_VARS.find((s) => s.id === 'S1') || {};
const S2_DEF = STATE_VARS.find((s) => s.id === 'S2') || {};
const S3_DEF = STATE_VARS.find((s) => s.id === 'S3') || {};

// S2 档位边界（低 0-30 / 中 31-70 / 高 71-100），用于离散↔连续转换
const S2_TIER_BOUNDARIES = S2_DEF.tier_boundaries || {
  低: '0-30',
  中: '31-70',
  高: '71-100',
};

// S2 档位的中值，用于连续值映射
const S2_TIER_MID = {
  低: 15,
  中: 50,
  高: 85,
};

/**
 * 将离散档位转为连续值（中值）
 * @param {string} tier - 低/中/高
 * @returns {number}
 */
function tierToValue(tier) {
  return S2_TIER_MID[tier] !== undefined ? S2_TIER_MID[tier] : 50;
}

/**
 * 将连续值（0-100）映射为 S2 离散档位
 * @param {number} value
 * @returns {string} 低/中/高
 */
function valueToTier(value) {
  if (value <= 30) return '低';
  if (value <= 70) return '中';
  return '高';
}

/**
 * 解析档位边界字符串如 "0-30" → [0, 30]
 * @param {string} boundary
 * @returns {[number, number]}
 */
function parseBoundary(boundary) {
  if (typeof boundary !== 'string') return [0, 100];
  const parts = boundary.split('-');
  if (parts.length === 2) {
    return [parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 100];
  }
  return [0, 100];
}

/**
 * 构造状态机引擎实例
 * 每个会话应创建一个独立实例，避免状态串扰
 */
function createStateEngine() {
  // 状态初值，取自 scenario_data.json 的 initial_value
  const state = {
    S1: S1_DEF.initial_value !== undefined ? S1_DEF.initial_value : 90,
    S2: S2_DEF.initial_value !== undefined ? S2_DEF.initial_value : '中',
    S2_continuous: tierToValue(S2_DEF.initial_value || '中'), // 内部连续值，用于计算
    S3: S3_DEF.initial_value !== undefined ? S3_DEF.initial_value : 70,
    // 状态写入历史，便于复盘追溯
    history: [],
  };

  /**
   * 记录状态变更历史
   * @param {string} source - 来源（D1/D2/手动）
   * @param {string} variable - S1/S2/S3
   * @param {*} oldValue
   * @param {*} newValue
   * @param {string} reason
   */
  function recordHistory(source, variable, oldValue, newValue, reason) {
    state.history.push({
      timestamp: new Date().toISOString(),
      source,
      variable,
      oldValue,
      newValue,
      reason,
    });
  }

  /**
   * 根据 D1 选择写入状态初值
   * 依据 scenario_data.json decision_nodes.D1.impact_on_D2[].state_writes
   * @param {string} d1Choice - A_连夜修复 / B_灰度准备 / C_继续回归
   */
  function applyD1Impact(d1Choice) {
    const d1 = scenarioData.decision_nodes && scenarioData.decision_nodes.D1;
    if (!d1 || !d1.impact_on_D2) return;

    // 查找匹配的 D1 选项
    const key = Object.keys(d1.impact_on_D2).find(
      (k) => k === d1Choice || k.indexOf(d1Choice) >= 0
    );
    if (!key) return;
    const impact = d1.impact_on_D2[key];
    const writes = impact.state_writes || {};

    // 按规则映射 D1 选择到 S1 值
    const d1Rules = S1_DEF.rules || {};
    let newS1 = state.S1;
    let s1Reason = '';

    if (key.indexOf('A') >= 0) {
      // A_连夜修复：修复路径锁定，S1 = d1_A_locked = 70
      newS1 = d1Rules.d1_A_locked !== undefined ? d1Rules.d1_A_locked : 70;
      s1Reason = 'D1 选择 A_连夜修复，修复路径锁定，进度降至 70';
    } else if (key.indexOf('B') >= 0) {
      // B_灰度准备：S1 = d1_B_prepared = 88
      newS1 = d1Rules.d1_B_prepared !== undefined ? d1Rules.d1_B_prepared : 88;
      s1Reason = 'D1 选择 B_灰度准备，灰度准备完成，进度 88';
    } else if (key.indexOf('C') >= 0) {
      // C_继续回归：S1 = d1_C_wasted = 82
      newS1 = d1Rules.d1_C_wasted !== undefined ? d1Rules.d1_C_wasted : 82;
      s1Reason = 'D1 选择 C_继续回归，资源消耗但无信息增量，进度 82';
    }

    if (newS1 !== state.S1) {
      recordHistory('D1', 'S1', state.S1, newS1, s1Reason);
      state.S1 = newS1;
    }

    // S2 状态写入
    if (writes.S2 === '可被更准确评估') {
      // B_灰度准备使 S2 可被更准确评估，此处不改档位，但在 D2 时可用更精细规则
      recordHistory('D1', 'S2', state.S2, state.S2, 'D1 选择 B_灰度准备，S2 可被更准确评估（档位暂不变）');
    }

    // S3 可根据 D1 选择微调，此处沿用初值
    recordHistory('D1', 'S3', state.S3, state.S3, `D1 选择 ${key}，S3 暂不变更`);
  }

  /**
   * 根据 D2 决策 + 已获取事实计算最终状态
   * @param {object|string} d2Decision - D2 决策对象或选项字符串
   * @param {string[]} acquiredFacts - 已获取事实 id 数组
   */
  function applyD2Decision(d2Decision, acquiredFacts) {
    acquiredFacts = Array.isArray(acquiredFacts) ? acquiredFacts : [];
    const option = typeof d2Decision === 'string'
      ? d2Decision
      : (d2Decision && (d2Decision.option || d2Decision.d2_option)) || '';

    const s1Rules = S1_DEF.rules || {};
    const s2Rules = S2_DEF.rules || {};
    const s3Rules = S3_DEF.rules || {};

    // ---- S1 最终值 ----
    let newS1 = state.S1;
    let s1Reason = '';

    if (option === 'Go全量' || option === 'Go') {
      newS1 = s1Rules.go !== undefined ? s1Rules.go : 90;
      s1Reason = `D2 选择 Go全量，进度 ${newS1}`;
    } else if (option.indexOf('Delay') >= 0) {
      newS1 = s1Rules.delay !== undefined ? s1Rules.delay : 75;
      s1Reason = `D2 选择 Delay，进度 ${newS1}`;
    } else if (option.indexOf('Limited') >= 0 || option.indexOf('灰度') >= 0) {
      newS1 = s1Rules.limited !== undefined ? s1Rules.limited : 85;
      s1Reason = `D2 选择 ${option}，进度 ${newS1}`;
    }

    if (newS1 !== state.S1) {
      recordHistory('D2', 'S1', state.S1, newS1, s1Reason);
      state.S1 = newS1;
    }

    // ---- S2 最终值 ----
    let newS2 = state.S2;
    let s2Reason = '';
    const isGoFull = option === 'Go全量' || option === 'Go';
    const f04Acquired = acquiredFacts.indexOf('F-04') >= 0;
    const f16Acquired = acquiredFacts.indexOf('F-16') >= 0;

    if (isGoFull) {
      // Go 全量：检查 P1 是否已处理
      const resolved = d2Decision && (d2Decision.p1_resolved || d2Decision.p1_fixed);
      const downgraded = f16Acquired && d2Decision && d2Decision.p1_downgraded;

      if (resolved || downgraded) {
        newS2 = s2Rules.go_with_p1_fixed || '低';
        s2Reason = 'Go全量但 P1 已修复/降级，S2 = 低';
      } else {
        newS2 = s2Rules.go_with_p1_unfixed || '高';
        s2Reason = 'Go全量且 P1 未修复，带病上线，S2 = 高';
      }
    } else if (option.indexOf('Delay') >= 0) {
      newS2 = s2Rules.delay || '低';
      s2Reason = 'Delay 延期上线，S2 = 低';
    } else if (option.indexOf('5%') >= 0) {
      newS2 = s2Rules.limited_5pct || '低';
      s2Reason = 'Limited_5% 灰度，S2 = 低';
    } else if (option.indexOf('20%') >= 0) {
      newS2 = s2Rules.limited_20pct || '中';
      s2Reason = 'Limited_20% 灰度，S2 = 中';
    } else if (option.indexOf('50%') >= 0) {
      newS2 = s2Rules.limited_50pct || '高';
      s2Reason = 'Limited_50% 灰度，S2 = 高';
    }

    if (newS2 !== state.S2) {
      recordHistory('D2', 'S2', state.S2, newS2, s2Reason);
      state.S2 = newS2;
      state.S2_continuous = tierToValue(newS2);
    }

    // ---- S3 最终值 ----
    let newS3 = state.S3;
    let s3Reason = '';

    if (isGoFull) {
      newS3 = s3Rules.go !== undefined ? s3Rules.go : 50;
      s3Reason = `D2 选择 Go全量，支持度 ${newS3}（运营支持但技术/QA 抵触）`;
    } else if (option.indexOf('Delay') >= 0) {
      // Delay 分有协商和无协商
      const hasNegotiation = d2Decision && (d2Decision.negotiated || d2Decision.stakeholder_communication);
      if (hasNegotiation) {
        newS3 = s3Rules.delay_with_negotiation !== undefined ? s3Rules.delay_with_negotiation : 75;
        s3Reason = `D2 选择 Delay 且有干系人协商，支持度 ${newS3}`;
      } else {
        newS3 = s3Rules.delay_without_negotiation !== undefined ? s3Rules.delay_without_negotiation : 55;
        s3Reason = `D2 选择 Delay 但无干系人协商，支持度 ${newS3}`;
      }
    } else if (option.indexOf('5%') >= 0) {
      newS3 = s3Rules.limited_5pct !== undefined ? s3Rules.limited_5pct : 78;
      s3Reason = `D2 选择 Limited_5%，支持度 ${newS3}`;
    } else if (option.indexOf('20%') >= 0) {
      newS3 = s3Rules.limited_20pct !== undefined ? s3Rules.limited_20pct : 76;
      s3Reason = `D2 选择 Limited_20%，支持度 ${newS3}`;
    } else if (option.indexOf('50%') >= 0) {
      newS3 = s3Rules.limited_50pct !== undefined ? s3Rules.limited_50pct : 72;
      s3Reason = `D2 选择 Limited_50%，支持度 ${newS3}`;
    }

    // F-08/F-14 获取对 S3 的支持度加成
    if (acquiredFacts.indexOf('F-08') >= 0) {
      newS3 = Math.min(100, newS3 + 3);
      s3Reason += '；获取 F-08 总损失数据，支持度 +3';
    }
    if (acquiredFacts.indexOf('F-14') >= 0) {
      newS3 = Math.min(100, newS3 + 2);
      s3Reason += '；获取 F-14 竞品情报，支持度 +2';
    }

    if (newS3 !== state.S3) {
      recordHistory('D2', 'S3', state.S3, newS3, s3Reason);
      state.S3 = newS3;
    }
  }

  /**
   * 获取当前状态快照
   * @returns {object}
   */
  function getState() {
    return {
      S1: state.S1,
      S2: state.S2,
      S2_continuous: state.S2_continuous,
      S3: state.S3,
      history: state.history.slice(), // 返回副本
    };
  }

  /**
   * 返回状态摘要用于复盘报告
   * @returns {object}
   */
  function getSSummary() {
    // 根据 S1/S2/S3 给出整体评价
    let overall = '';
    const s1 = state.S1;
    const s2 = state.S2;
    const s3 = state.S3;

    if (s2 === '高' && s3 < 50) {
      overall = '高风险低支持：决策质量差，需大幅改进';
    } else if (s2 === '高') {
      overall = '高风险：质量风险未得到控制';
    } else if (s2 === '低' && s3 >= 70 && s1 >= 80) {
      overall = '低风险高支持：决策质量优秀';
    } else if (s2 === '低') {
      overall = '低风险：质量风险可控';
    } else if (s2 === '中' && s3 >= 70) {
      overall = '中等风险有支持：方案可接受但有改进空间';
    } else {
      overall = '中等风险：方案基本可接受';
    }

    return {
      S1: {
        name: S1_DEF.name || '项目整体进度',
        value: s1,
        range: S1_DEF.range || [0, 100],
        interpretation: s1 >= 85 ? '进度良好' : s1 >= 70 ? '进度有延迟' : '进度严重滞后',
        crossSceneRule: S1_DEF.cross_scene_rule || '',
      },
      S2: {
        name: S2_DEF.name || '线上质量风险',
        value: s2,
        tier_boundaries: S2_TIER_BOUNDARIES,
        interpretation:
          s2 === '低' ? '质量风险可控' : s2 === '中' ? '存在中等质量风险' : '存在严重质量风险',
        crossSceneRule: S2_DEF.cross_scene_rule || '',
      },
      S3: {
        name: S3_DEF.name || '干系人组织支持度',
        value: s3,
        range: S3_DEF.range || [0, 100],
        interpretation: s3 >= 70 ? '干系人支持度良好' : s3 >= 50 ? '干系人支持度一般' : '干系人支持度不足',
        crossSceneRule: S3_DEF.cross_scene_rule || '',
      },
      overall,
      history: state.history.slice(),
    };
  }

  return {
    applyD1Impact,
    applyD2Decision,
    getState,
    getSSummary,
    // 工具方法
    _tierToValue: tierToValue,
    _valueToTier: valueToTier,
  };
}

module.exports = {
  createStateEngine,
  // 导出工具函数
  tierToValue,
  valueToTier,
  parseBoundary,
};
