'use strict';

/**
 * 沟通意图分类器 - 系统提示词构建器
 * 场景：上线前夜 · 星盘结算 (LN2-v01)
 *
 * 将学生的对话消息分类为以下5类沟通动作之一：
 *   A. structured_questioning  - 结构化提问（询问量化指标）
 *   B. risk_verification       - 风险求证（追问影响范围/后果）
 *   C. plan_negotiation        - 方案协商（提出/询问方案）
 *   D. resource_inquiry        - 资源问询（询问资源/约束）
 *   E. executive_alignment     - 高层对齐（战略/风险容忍度）
 *
 * 角色对照：
 *   R1 沈屹 - 技术负责人
 *   R2 闻笛 - QA负责人
 *   R3 江照 - 运营负责人
 *   R4 许可 - CEO
 */

// ========== 沟通动作定义 ==========
var intentCategories = [
  {
    code: 'A',
    name: 'structured_questioning',
    label: '结构化提问',
    description: '询问量化指标、具体数据、概率、阈值、覆盖率、排期明细等可量化的信息',
    triggers: [
      '询问具体百分比、概率、数值、阈值',
      '询问QPS、峰值、产能等量化指标',
      '询问修复工时、排期明细、时间窗口',
      '要求对方给出数据支撑或具体参数',
    ],
    trust_change: 5,
    unlocked_facts: ['F-04', 'F-06'],
  },
  {
    code: 'B',
    name: 'risk_verification',
    label: '风险求证',
    description: '追问风险的影响范围、后果严重程度、故障触发的业务影响、回滚能力、用户流失等',
    triggers: [
      '追问故障影响范围、后果',
      '询问回滚能力、应急响应时间、止血速度',
      '追问"如果出问题会怎样"',
      '询问用户流失、业务中断后果',
      '追问历史事故数据',
    ],
    trust_change: 8,
    unlocked_facts: ['F-11', 'F-12', 'F-16', 'F-17'],
  },
  {
    code: 'C',
    name: 'plan_negotiation',
    label: '方案协商',
    description: '提出或询问解决方案、替代方案，讨论灰度发布、降级方案、折中方案等',
    triggers: [
      '提出具体方案（灰度、降级、延期、折中）',
      '询问是否有替代方案或折中方案',
      '讨论方案的可行性和权衡',
      '询问"能不能先灰度再全量"',
      '询问P1降级方案、活动页切老引擎等方案',
    ],
    trust_change: 6,
    unlocked_facts: ['F-07', 'F-10', 'F-13', 'F-16'],
  },
  {
    code: 'D',
    name: 'resource_inquiry',
    label: '资源问询',
    description: '询问资源约束、人力、时间成本、修复周期、产能、预算损失等资源和约束条件',
    triggers: [
      '询问可用资源（人力、时间、产能）',
      '询问修复需要多少时间/排期明细',
      '询问延期损失、成本',
      '询问QA实际产能、有效工时',
      '询问资源是否充足、约束条件',
    ],
    trust_change: 5,
    unlocked_facts: ['F-06', 'F-10', 'F-13', 'F-15'],
  },
  {
    code: 'E',
    name: 'executive_alignment',
    label: '高层对齐',
    description: '讨论战略层面的问题、风险容忍度、市场态势、竞争格局、竞品动态、长期影响等',
    triggers: [
      '询问风险容忍度/上限',
      '讨论战略方向、市场态势',
      '询问竞争格局、竞品动态',
      '讨论长期影响和战略弹性',
      '与CEO对齐整体目标',
      '询问总损失、隐性成本等战略层面商业评估',
    ],
    trust_change: 7,
    unlocked_facts: ['F-08', 'F-14'],
  },
];

// ========== Few-shot 示例 ==========
var fewShotExamples = [
  // A. 结构化提问
  {
    input: '闻笛，缺陷复现的具体阈值是多少？QPS到多少会触发？',
    category: 'A',
    category_name: 'structured_questioning',
    reason: '询问缺陷触发的具体QPS阈值，属于量化指标的结构化提问',
  },
  {
    input: '沈屹，修复工时具体是多少小时？有没有明细排期？',
    category: 'A',
    category_name: 'structured_questioning',
    reason: '询问修复工时的具体数值和排期明细，属于量化指标提问',
  },
  // B. 风险求证
  {
    input: '沈屹，万一上线后出了问题，回滚需要多长时间？能满足事故响应要求吗？',
    category: 'B',
    category_name: 'risk_verification',
    reason: '追问回滚能力和应急响应时间，属于风险求证',
  },
  {
    input: '江照，如果支付故障真的发生了，对用户的长期影响有多大？',
    category: 'B',
    category_name: 'risk_verification',
    reason: '追问故障触发后的长期用户影响，属于风险求证',
  },
  // C. 方案协商
  {
    input: '沈屹，如果我们灰度发布到20%的用户，控制风险暴露面，技术上可行吗？',
    category: 'C',
    category_name: 'plan_negotiation',
    reason: '提出灰度发布方案并询问可行性，属于方案协商',
  },
  {
    input: '闻笛，P1降级方案和修复比，哪个更划算？4小时降级能绕过阈值吗？',
    category: 'C',
    category_name: 'plan_negotiation',
    reason: '比较P1降级方案和修复方案，讨论方案权衡，属于方案协商',
  },
  // D. 资源问询
  {
    input: '沈屹，修复这个缺陷需要多少时间？排期明细能拉一下吗？',
    category: 'D',
    category_name: 'resource_inquiry',
    reason: '询问修复所需的时间和排期明细，属于资源问询',
  },
  {
    input: '闻笛，今天QA能跑完多少用例？实际产能是多少？',
    category: 'D',
    category_name: 'resource_inquiry',
    reason: '询问QA实际产能和可完成的用例数，属于资源约束问询',
  },
  // E. 高层对齐
  {
    input: '许可，从公司战略层面看，我们对这次上线的风险容忍度是什么？',
    category: 'E',
    category_name: 'executive_alignment',
    reason: '询问战略层面的风险容忍度，属于高层对齐',
  },
  {
    input: '许可，竞品下周要上线同类功能，这对我们的上线时间有什么影响？',
    category: 'E',
    category_name: 'executive_alignment',
    reason: '讨论竞品动态对上线时间的战略影响，属于高层对齐',
  },
];

// ========== 正式询问规则说明 ==========
var formalInquiryRules = [
  {
    id: 'R-FA1',
    name: '前置证据法',
    description: '学生在提问中引用了已从其他角色获取的事实作为证据，追问当前角色',
    detection_hint: '提问中包含"你说/他说/XX提到"等引用语，或直接引用具体数据（如"80万""8小时"）',
  },
  {
    id: 'R-FA2',
    name: '用途说明法',
    description: '学生在提问中明确说明决策用途或分析目的',
    detection_hint: '提问中包含"我需要评估""用于决策""为了分析"等用途说明',
  },
  {
    id: 'R-FA3',
    name: '角色身份法',
    description: '学生以项目负责人身份直接询问该角色的核心职责范围',
    detection_hint: '提问中包含"作为项目负责人""我需要了解"等身份声明',
  },
];

// ========== 主函数：构建意图分类器系统提示词 ==========
function buildIntentClassifierPrompt(studentMessage) {
  var categoriesDesc = intentCategories.map(function (cat) {
    return [
      '### ' + cat.code + '. ' + cat.name + '（' + cat.label + '）',
      '- 描述：' + cat.description,
      '- 触发特征：',
      cat.triggers.map(function (t) { return '  - ' + t; }).join('\n'),
      '- 信任度变化：' + (cat.trust_change >= 0 ? '+' : '') + cat.trust_change,
      '- 可解锁事实：' + (cat.unlocked_facts.length > 0 ? cat.unlocked_facts.join(', ') : '无'),
    ].join('\n');
  }).join('\n\n');

  var examplesDesc = fewShotExamples.map(function (ex, idx) {
    return [
      '## 示例 ' + (idx + 1),
      '学生消息："' + ex.input + '"',
      '分类结果：' + ex.category + '（' + ex.category_name + '）',
      '理由：' + ex.reason,
    ].join('\n');
  }).join('\n\n');

  var formalInquiryDesc = formalInquiryRules.map(function (rule) {
    return [
      '### ' + rule.id + '（' + rule.name + '）',
      '- 描述：' + rule.description,
      '- 识别提示：' + rule.detection_hint,
    ].join('\n');
  }).join('\n\n');

  var prompt = [
    '# 沟通意图分类器',
    '',
    '你的任务是将学生在"上线前夜 · 星盘结算"模拟场景中发送的对话消息分类为以下5类沟通动作之一。',
    '场景背景：支付链路 SaaS 产品「星盘结算」计划明日 09:00 上线，配合已签约的市场推广活动。',
    '新引擎核心支付接口存在已知缺陷，QA 在 staging 环境复现确认触发阈值为 QPS>2500。',
    '预估活动峰值 3200 笔/秒。学生需要在两个决策节点完成信息收集、方案比较并提交决策。',
    '',
    '角色对照：',
    '  R1 沈屹 - 技术负责人',
    '  R2 闻笛 - QA负责人',
    '  R3 江照 - 运营负责人',
    '  R4 许可 - CEO',
    '',
    '分类结果将用于：',
    '1. 确定学生执行的沟通动作类型',
    '2. 计算对应角色的信任度变化',
    '3. 判断是否解锁该沟通动作对应的隐藏事实',
    '4. 检测是否触发正式询问规则（R-FA1/FA2/FA3）',
    '',
    '',

    '# 分类类别定义',
    '',
    categoriesDesc,
    '',
    '',

    '# 正式询问规则说明',
    '',
    '除上述5类沟通动作外，学生的提问可能同时符合以下正式询问规则之一。',
    '如果检测到正式询问模式，请在输出中标注（formal_inquiry 字段），',
    '这将使对应角色即使关系档位不足也可披露 L2 事实：',
    '',
    formalInquiryDesc,
    '',
    '注意：正式询问规则是沟通动作的修饰符，不是独立分类。',
    '例如"我需要评估灰度安全性，复现阈值是多少？"同时属于 A（结构化提问）和 R-FA2（用途说明法）。',
    '',
    '',

    '# 分类规则',
    '',
    '1. **单分类原则**：每条消息只能归入一个最主要的主类别（A/B/C/D/E）。',
    '   如果消息涉及多个意图，选择最主要或最后表达的意图。',
    '',
    '2. **量化优先原则**：如果学生同时询问量化数据和影响范围，优先判断为结构化提问（A），',
    '   因为获取量化数据是风险求证的前提。',
    '',
    '3. **方案 vs 资源区分**：如果学生提出一个具体方案（如"灰度发布""降级方案"），归为方案协商（C）；',
    '   如果只是询问"修复需要多少资源""产能多少"，归为资源问询（D）。',
    '',
    '4. **战略 vs 执行区分**：如果学生讨论的是风险容忍度、竞争格局、长期战略，归为高层对齐（E）；',
    '   如果讨论的是具体技术风险或测试数据，归为对应的执行层类别（A/B/D）。',
    '',
    '5. **语境判断**：根据消息内容判断，而非仅看关键词。例如"损失多少"在询问量化指标时是A，',
    '   在询问资源约束时是D，在询问战略层面总损失时是E，需要结合上下文判断。',
    '',
    '6. **正式询问检测**：在分类主类别的同时，检查提问是否符合 R-FA1/FA2/FA3 的特征。',
    '   一条消息可以同时属于一个主类别和一个正式询问规则。',
    '',
    '7. **负面行为识别**：如果学生消息表现出以下特征，虽不改变主分类，',
    '   但应在 reason 中标注，以触发信任度扣减：',
    '   - one_sided_questioning（只问一个角色，忽视其他角色）：信任度 -3',
    '   - offensive_expression（攻击性表达）：信任度 -10',
    '   - ignoring_role（忽视某个角色）：信任度 -5',
    '',
    '',

    '# Few-shot 示例',
    '',
    examplesDesc,
    '',
    '',

    '# 待分类消息',
    '',
    '学生消息："' + (studentMessage || '') + '"',
    '',
    '',
    '# 输出格式',
    '',
    '请严格按照以下JSON格式输出分类结果（不要输出其他内容）：',
    '',
    '{',
    '  "category": "分类字母（A/B/C/D/E）",',
    '  "action_name": "动作名称（structured_questioning/risk_verification/plan_negotiation/resource_inquiry/executive_alignment）",',
    '  "confidence": 0.0到1.0之间的置信度,',
    '  "formal_inquiry": "正式询问规则ID（R-FA1/R-FA2/R-FA3），无则为null",',
    '  "negative_behavior": "负面行为类型（one_sided_questioning/offensive_expression/ignoring_role），无则为null",',
    '  "reason": "简要说明分类理由（一句话）"',
    '}',
    '',
    '请只输出上述JSON，不要包含markdown代码块标记或其他说明文字。',
  ].join('\n');

  return prompt;
}

// ========== 辅助函数：获取分类信息 ==========
function getCategoryByName(actionName) {
  return intentCategories.find(function (c) { return c.name === actionName; }) || null;
}

function getCategoryByCode(code) {
  return intentCategories.find(function (c) { return c.code === code; }) || null;
}

// ========== 导出 ==========
module.exports = {
  buildIntentClassifierPrompt: buildIntentClassifierPrompt,
  intentCategories: intentCategories,
  fewShotExamples: fewShotExamples,
  formalInquiryRules: formalInquiryRules,
  getCategoryByName: getCategoryByName,
  getCategoryByCode: getCategoryByCode,
};
