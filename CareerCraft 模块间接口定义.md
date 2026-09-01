# CareerCraft 模块间接口定义文档

> **版本**: v0.1 | **冻结日期**: 2025-09-05 | **场景**: launch-eve-v1
>
> 本文档定义 Agent 系统、规则引擎、前端三层之间的数据接口契约。9/5 冻结后，接口变更需经吕彦蕾审批并通知所有消费方。

---

## 接口总览

| 接口 | 产出方 | 消费方 | 交互方向 | 传输方式 |
|------|--------|--------|---------|---------|
| INT-01 意图分类结果 | 刘俊辰 · Agent | 路毅 · 关系引擎 | Agent → 规则引擎 | 函数调用 / 消息队列 |
| INT-02 信任档位 | 路毅 · 关系引擎 | 刘俊辰 · Agent | 规则引擎 → Agent | 函数返回 / 状态查询 |
| INT-03 事实披露记录 | 刘俊辰 · Agent | 路毅 · 评分引擎 | Agent → 规则引擎 | 事件日志 |
| INT-04 约束检查结果 | 路毅 · 约束引擎 | 路毅 · 结果引擎 | 引擎内部 | 内部调用 |
| INT-05 状态变量 | 路毅 · 状态机 | 路毅 · 结果引擎 | 引擎内部 | 内部调用 |
| INT-06 决策提交 | 前端 · 徐楷博 | 路毅 · 约束引擎 | 前端 → 后端 | REST API |
| INT-07 复盘报告数据 | 路毅 · 评分引擎 | 前端 · 徐楷博 | 后端 → 前端 | REST API |

> 路毅的 6 个引擎模块中 INT-04/05 为内部消费（约束→状态→评分→结果→日志），只有 INT-02 需要和 Agent 交互。线上开发独立性高。

---

## INT-01 意图分类结果

**用途**：Agent 对话系统将学生提问的意图分类结果传给关系引擎，用于判断披露层级和信任度变化。

### 请求格式（Agent → 关系引擎）

```json
{
  "session_id": "sess_001",
  "role_id": "R2",
  "student_input": "我需要评估灰度比例的安全性，缺陷的触发条件是什么？",
  "context": {
    "current_topic": "defect_reproduction",
    "previous_facts_disclosed": ["F-03", "F-16"],
    "d1_choice": null
  }
}
```

### 响应格式（关系引擎 ← Agent）

```json
{
  "session_id": "sess_001",
  "role_id": "R2",
  "intent": "risk_inquiry",
  "confidence": 0.92,
  "extracted_keywords": ["灰度比例", "安全性", "触发条件"],
  "matched_fa": "R-FA2",
  "fa_detail": {
    "rule": "R-FA2 用途说明法",
    "trigger_text": "我需要评估灰度比例的安全性",
    "target_fact": "F-04"
  },
  "timestamp": "2025-09-06T14:32:00Z"
}
```

### 意图枚举值

| intent 值 | 含义 | 触发示例 |
|-----------|------|---------|
| `structured_query` | 结构化提问（量化数据、时间、百分比） | "故障率是多少？""修复需要几小时？" |
| `risk_inquiry` | 风险求证（追问风险、概率、影响） | "这个缺陷在什么条件下触发？""风险有多大？" |
| `plan_negotiation` | 方案协商（讨论具体方案、假设句式） | "如果灰度 20% 会怎样？""切老引擎代价是什么？" |
| `resource_inquiry` | 资源问询（人力、时间、预算） | "QA 今晚能投入多少人？""修复需要几个人天？" |
| `strategic_alignment` | 高层对齐（战略层面、对 CEO 提问） | "这次上线对公司战略意味着什么？" |

### 正式询问判定（R-FA 规则）

| 规则 | 判定条件 | 适用层级 | 匹配字段 |
|------|---------|---------|---------|
| R-FA1 前置证据法 | 学生已获取关联事实并追问 | L2 / L3 | `context.previous_facts_disclosed` 非空且与目标事实关联 |
| R-FA2 用途说明法 | 提问中明确说明决策用途 | L2 | `student_input` 包含用途关键词（评估/分析/需要了解/预案要用） |
| R-FA3 角色身份法 | 以项目负责人身份询问核心职责 | L2 / L3 | `student_input` 包含身份声明（作为负责人/我需要/项目负责人） |

> 规则引擎在 LLM 意图分类后追加判定：若 `intent` 不满足披露条件，再检查 R-FA1/FA2/FA3；任一命中则 `matched_fa` 非 null，触发披露。

---

## INT-02 信任档位

**用途**：关系引擎将当前角色的信任档位传给 Agent，Agent 根据档位调整回复深度和弱信号数量。

### 请求格式（Agent → 关系引擎）

```json
{
  "session_id": "sess_001",
  "role_id": "R2"
}
```

### 响应格式（关系引擎 → Agent）

```json
{
  "session_id": "sess_001",
  "role_id": "R2",
  "level": "cooperative",
  "score": 68,
  "disclosure_speed": {
    "L2": "immediate",
    "L3": "requires_followup"
  },
  "behavioral_signals": [
    "answer_detailed",
    "proactive_supplement",
    "increased_weak_signals"
  ],
  "timestamp": "2025-09-06T14:32:05Z"
}
```

### 档位定义

| level 值 | score 区间 | 前台行为信号 | L2 披露速度 | L3 披露速度 |
|----------|-----------|-------------|------------|------------|
| `resistant` | 0–29 | 回答简短，弱信号减少，明确表达不满 | 需 2 次以上追问 | 拒绝披露，给弱信号 |
| `neutral` | 30–59 | 正常回答但不展开，弱信号可见 | 需 1 次追问 | 需 2 次以上追问 |
| `cooperative` | 60–79 | 回答详细，主动补充，弱信号增加 | 第一问即给 | 需 1 次追问 |
| `trusting` | 80–100 | 主动给未问到的信息，语气放松 | 第一问即给 | 第一问即给 |

> 档位不跨角色共享：学生对 R1 的关系状态不影响 R2 的态度。档位迁移由学生沟通行为累积触发，不因单次提问突变。

---

## INT-03 事实披露记录

**用途**：Agent 将每次事实披露事件记录传给评分引擎，作为证据化复盘和评分的数据来源。

### 事件格式（Agent → 评分引擎）

```json
{
  "session_id": "sess_001",
  "event_type": "fact_disclosed",
  "data": {
    "fact_id": "F-04",
    "source_role": "R2",
    "method": "formal_inquiry",
    "method_detail": "R-FA2 用途说明法",
    "student_input": "我需要评估灰度比例的安全性，缺陷的触发条件是什么？",
    "disclosed_content": "触发条件 2,500 笔/秒；3,000 笔/秒复现率 100%",
    "trust_level_at_disclosure": "neutral",
    "is_red_line": true,
    "timestamp": "2025-09-06T14:32:10Z"
  }
}
```

### method 枚举值

| method 值 | 含义 | 说明 |
|-----------|------|------|
| `keyword` | 关键词触发 | 学生问到相关主题，L1 层自动披露 |
| `formal_inquiry` | 正式询问触发 | R-FA1/FA2/FA3 任一命中 |
| `trust_unlock` | 信任档位解锁 | 关系状态达到配合/信任档位后自动披露 |
| `auto_disclose` | 剧情性自动披露 | D1 选择触发的自动披露（如 D1-B 触发 F-04） |
| `missed` | 未获取 | 场景结束时仍未获取，计入遗漏分析 |

### 事件类型枚举

| event_type 值 | 含义 |
|---------------|------|
| `fact_disclosed` | 事实已披露 |
| `fact_missed` | 事实未获取（复盘阶段生成） |
| `weak_signal_shown` | 弱信号已展示 |
| `weak_signal_followed` | 弱信号被学生追问 |
| `weak_signal_ignored` | 弱信号被学生忽略 |
| `conflict_identified` | 学生识别了冲突 |
| `conflict_missed` | 学生未识别冲突 |

---

## INT-04 约束检查结果（引擎内部）

**用途**：约束引擎检查学生提交的决策是否违反硬约束，结果传给结果引擎计算后果。

### 输入格式（决策提交 → 约束引擎）

```json
{
  "session_id": "sess_001",
  "d1_choice": "B",
  "d2_choice": "limited_release",
  "d2_params": {
    "limited_pct": 20,
    "evidence_refs": ["F-04", "F-05", "F-12"],
    "rationale": "灰度20%在阈值以下，回滚5分钟满足C-04",
    "contingency_plan": "5分钟内切回老引擎"
  },
  "facts_obtained": ["F-01", "F-02", "F-03", "F-04", "F-05", "F-09", "F-12", "F-16"]
}
```

### 输出格式（约束引擎 → 结果引擎）

```json
{
  "session_id": "sess_001",
  "constraints_checked": [
    {
      "constraint_id": "C-01",
      "description": "D1决策窗口16h",
      "violated": false,
      "detail": "D1-B 耗时 8 人时，在窗口内"
    },
    {
      "constraint_id": "C-02",
      "description": "研发资源不超过3人天",
      "violated": false,
      "detail": "D1-B 使用 4 人时 + D2 使用 0 = 4 人时 < 3 人天"
    },
    {
      "constraint_id": "C-05",
      "description": "灰度比例需有数据支撑",
      "violated": false,
      "detail": "已获取 F-04 和 F-05"
    },
    {
      "constraint_id": "C-07",
      "description": "P1缺陷须修复或灰度规避",
      "violated": false,
      "detail": "limited_release 方案，灰度规避"
    }
  ],
  "all_passed": true,
  "violated_count": 0
}
```

### 约束清单

| constraint_id | 描述 | 检查逻辑 | 违反后果 |
|---------------|------|---------|---------|
| C-01 | D1 决策窗口 16h | `d1_time_cost <= 16h` | 方案不可执行 |
| C-02 | 研发资源 ≤ 3 人天 | `resource_usage <= 3` | 禁止提交；决策质量 -5 |
| C-03 | 活动不可取消 | `option != 'cancel_activity'` | 方案不可执行 |
| C-04 | 回滚 ≤ 30 分钟 | `rollback_time <= 30min` | 方案不可执行 |
| C-05 | 灰度需数据支撑 | `limited_pct requires F-04 AND F-05` | 决策质量 -3 |
| C-06 | 延期 ≤ 24h | `delay <= 24h` | 方案不可执行 |
| C-07 | P1 须修复或灰度规避 | `go requires F-04_resolved OR limited_release` | 方案不可执行 |

---

## INT-05 状态变量（引擎内部）

**用途**：状态机维护三个状态变量，决策提交后计算状态变化，传给结果引擎。

### 初始状态

```json
{
  "session_id": "sess_001",
  "state": {
    "S1": { "name": "项目进度", "value": 50, "type": "continuous", "range": [0, 100] },
    "S2": { "name": "质量风险", "value": "medium", "type": "discrete", "levels": ["low", "medium", "high"] },
    "S3": { "name": "组织支持度", "value": 70, "type": "continuous", "range": [0, 100] }
  }
}
```

### 决策后状态更新

```json
{
  "session_id": "sess_001",
  "d2_choice": "limited_release",
  "d2_params": { "limited_pct": 20 },
  "state_changes": {
    "S1": { "before": 58, "after": 75, "reason": "灰度准备完成，部分用户上线" },
    "S2": { "before": "high", "after": "medium", "reason": "20% < 阈值，风险可控" },
    "S3": { "before": 70, "after": 72, "reason": "运营愿意在会上替方案说话 +2" }
  }
}
```

### S2 离散档位数值边界

| 档位 | 数值边界（内部使用） | 说明 |
|------|-------------------|------|
| low | 0–30 | 质量风险低，可全量上线 |
| medium | 31–70 | 质量风险中等，需灰度或隔离 |
| high | 71–100 | 质量风险高，禁止全量上线 |

> S2 在评分时按档位映射：low = 满分，medium = -3 分，high = -8 分（决策质量维度）。

---

## INT-06 决策提交（前端 → 后端 REST API）

**用途**：前端将学生的 D1/D2 决策提交给后端。

### 请求

```
POST /api/decision/submit
Content-Type: application/json
```

```json
{
  "session_id": "sess_001",
  "student_id": "stu_001",
  "d1_choice": "B",
  "d2_choice": "limited_release",
  "d2_params": {
    "limited_pct": 20,
    "evidence_refs": ["F-04", "F-05", "F-12"],
    "rationale": "灰度20%在阈值以下，回滚5分钟满足C-04",
    "contingency_plan": "5分钟内切回老引擎"
  },
  "facts_obtained": ["F-01", "F-02", "F-03", "F-04", "F-05", "F-09", "F-12", "F-16"],
  "interview_log": [
    { "role_id": "R2", "turns": 6, "duration_min": 12 },
    { "role_id": "R1", "turns": 4, "duration_min": 8 },
    { "role_id": "R3", "turns": 3, "duration_min": 6 }
  ]
}
```

### 响应

```json
{
  "session_id": "sess_001",
  "status": "accepted",
  "constraint_results": { "all_passed": true, "violated_count": 0 },
  "state_snapshot": {
    "S1": 75, "S2": "medium", "S3": 72
  },
  "result_events": [
    { "rr_id": "RR-1", "triggered": false, "detail": "灰度20% × 实际峰值3680 = 736 < 阈值2500，未触发缺陷" },
    { "rr_id": "RR-4", "triggered": false, "detail": "5分钟回滚能力满足C-04，未超时" }
  ]
}
```

---

## INT-07 复盘报告数据（后端 → 前端 REST API）

**用途**：后端将评分结果和证据链返回给前端复盘报告页面。

### 请求

```
GET /api/review/{session_id}
```

### 响应

```json
{
  "session_id": "sess_001",
  "scores": {
    "user_insight": { "score": 16, "max": 20, "level": "良好" },
    "decision_quality": { "score": 21, "max": 25, "level": "良好" },
    "communication": { "score": 16, "max": 20, "level": "良好" },
    "business_balance": { "score": 14, "max": 20, "level": "及格" },
    "growth_reflection": { "score": 12, "max": 15, "level": "良好" },
    "total": 79,
    "grade": "B+"
  },
  "evidence_chain": [
    { "fact_id": "F-04", "status": "obtained", "source": "R2", "method": "formal_inquiry", "is_red_line": true },
    { "fact_id": "F-08", "status": "missed", "source": "R4", "is_red_line": true, "impact": "商业评估不完整" },
    { "fact_id": "F-11", "status": "missed", "source": "R1", "is_red_line": true, "impact": "修复可行性未验证" }
  ],
  "constraint_results": [
    { "constraint_id": "C-05", "violated": false, "detail": "灰度比例有数据支撑" },
    { "constraint_id": "C-07", "violated": false, "detail": "灰度规避 P1 缺陷" }
  ],
  "counterfactual": [
    { "scenario": "如果选 Go", "predicted_S1": 90, "predicted_S2": "high", "predicted_S3": 25, "rr_triggered": ["RR-1", "RR-3"], "summary": "全量触发缺陷，事故赔付+品牌损失" },
    { "scenario": "如果选 Delay 24h", "predicted_S1": 40, "predicted_S2": "low", "predicted_S3": 62, "rr_triggered": [], "summary": "安全但损失80万+续约风险" },
    { "scenario": "如果选 Limited 50%", "predicted_S1": 78, "predicted_S2": "high", "predicted_S3": 50, "rr_triggered": ["RR-1"], "summary": "50% × 3680 = 1840 < 2500，侥幸未触发但QA明确反对" }
  ],
  "improvement_suggestions": [
    "未获取 F-08（CEO 续约信息），商业评估不完整。建议下次访谈 CEO 时使用 R-FA1 前置证据法。",
    "未获取 F-11（修复排期明细），修复路径可行性未验证。建议 D1 选 A 前追问 Tech 修复明细。",
    "QA 明确反对 50% 灰度但方案选择了 20%，决策与证据一致性良好。"
  ],
  "internal_params_revealed": {
    "actual_peak": 3680,
    "deviation": "+15%",
    "note": "学生决策时看到的是预估3200 ±30%，实际偏差+15%"
  }
}
```

---

## 评分映射表

| 评分维度 | 权重 | 计算方 | 数据来源 |
|---------|------|--------|---------|
| 用户洞察 | 20% | 规则引擎 | INT-03 事实披露记录（获取了哪些红线事实、弱信号利用率） |
| 决策质量 | 25% | 规则引擎 70% + LLM 30% | INT-04 约束检查 + INT-03 证据引用一致性 + LLM 评估推理质量 |
| 沟通协作 | 20% | 规则引擎 | INT-02 信任档位变化 + INT-03 沟通行为记录 |
| 商业平衡 | 20% | 规则引擎 | INT-03 是否获取商业类事实（F-08/F-09/F-13/F-14） |
| 成长反思 | 15% | LLM 100% | 学生复盘文字输入（LLM 评估具体性和可操作性） |

---

## 接口变更流程

1. 变更方提交接口修改提案（含字段变更、兼容性说明）
2. 吕彦蕾审批
3. 消费方确认兼容性
4. 更新本文档版本号
5. 同步通知所有相关成员

| 版本 | 日期 | 变更内容 | 变更人 |
|------|------|---------|--------|
| v0.1 | 2025-09-01 | 初始版本 | 吕彦蕾 |
