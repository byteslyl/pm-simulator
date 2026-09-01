# CareerCraft 后端 API 接口文档

> **版本**: v0.1 | **更新日期**: 2026-09-01 | **Base URL**: `http://localhost:3000/api`

---

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务器
npm start
# 或指定端口
PORT=8080 npm start

# 运行 API 测试
npm test
```

服务器启动后访问 `http://localhost:3000/api/health` 验证。

---

## API 端点总览

| 方法 | 路径 | 说明 | 需要会话 |
|------|------|------|---------|
| GET | `/api/health` | 健康检查 | 否 |
| GET | `/api/scenario` | 场景元数据 | 否 |
| POST | `/api/sessions` | 创建新会话 | 否 |
| GET | `/api/sessions/:sessionId` | 获取当前状态 | 是 |
| DELETE | `/api/sessions/:sessionId` | 销毁会话 | 是 |
| POST | `/api/sessions/:sessionId/messages` | 处理学生提问 | 是 |
| POST | `/api/sessions/:sessionId/decisions/d1` | 提交 D1 决策 | 是 |
| POST | `/api/sessions/:sessionId/decisions/d2` | 提交 D2 决策 | 是 |
| GET | `/api/sessions/:sessionId/report` | 获取复盘报告 | 是 |
| POST | `/api/sessions/:sessionId/llm-scores` | 注入 LLM 评分 | 是 |
| GET | `/api/sessions/:sessionId/roles` | 角色列表（含立场） | 是 |
| GET | `/api/sessions/:sessionId/facts` | 事实详情 | 是 |
| GET | `/api/sessions/:sessionId/interview-log` | 访谈日志摘要 | 是 |

---

## 统一响应格式

### 成功响应

```json
{
  "status": "success",
  "message": "描述信息",
  "data": { ... }
}
```

### 错误响应

```json
{
  "status": "error",
  "message": "错误描述",
  "details": "详细信息（可选）"
}
```

---

## 接口详情

### 1. GET /api/health

健康检查，返回服务器运行状态。

**响应示例**:

```json
{
  "status": "success",
  "message": "服务正常运行",
  "data": {
    "status": "running",
    "uptime": 120.5,
    "sessionCount": 3,
    "timestamp": "2026-09-01T11:00:00.000Z"
  }
}
```

---

### 2. GET /api/scenario

获取场景元数据（角色、时间线、决策节点），无需创建会话。

**响应示例**:

```json
{
  "status": "success",
  "message": "场景元数据",
  "data": {
    "scenarioId": "LN2-v01",
    "scenarioName": "上线前夜 · 星盘结算",
    "version": "0.1",
    "description": "支付链路 SaaS 产品...",
    "timeline": {
      "start": "今日 17:00",
      "d1_deadline": "今晚 21:30",
      "d2_deadline": "明早 09:00 前",
      "simulated_window_hours": 16,
      "real_time_budget_minutes": 40
    },
    "decisionNodes": {
      "D1": { "name": "中间决策：资源投向", "options": ["A_连夜修复", "B_灰度准备", "C_继续回归"] },
      "D2": { "name": "最终决策：上线方案", "options": ["Go", "Delay", "Limited_5%", "Limited_20%", "Limited_50%"] }
    },
    "roles": [
      { "id": "R1", "name": "沈屹", "title": "技术负责人", "coreConcern": "..." },
      { "id": "R2", "name": "闻笛", "title": "QA负责人", "coreConcern": "..." },
      { "id": "R3", "name": "江照", "title": "运营负责人", "coreConcern": "..." },
      { "id": "R4", "name": "许可", "title": "CEO", "coreConcern": "..." }
    ]
  }
}
```

---

### 3. POST /api/sessions

创建新会话，初始化引擎实例。

**请求体** (可选):

```json
{
  "studentId": "stu_001"
}
```

**响应示例**:

```json
{
  "status": "success",
  "message": "会话已创建",
  "data": {
    "sessionId": "sess_mtik4wr28v5o3w",
    "studentId": "stu_001",
    "scenarioId": "LN2-v01",
    "scenarioName": "上线前夜 · 星盘结算",
    "version": "0.1",
    "timeline": { ... },
    "roles": [
      { "id": "R1", "name": "沈屹", "title": "技术负责人" },
      ...
    ],
    "initialFacts": ["F-01", "F-02", "F-03"],
    "intentClassifierMode": "keyword_fallback"
  }
}
```

> `intentClassifierMode` 为 `keyword_fallback` 表示使用内置关键词分类器；接入 LLM 后为 `llm`。

---

### 4. GET /api/sessions/:sessionId

获取当前会话状态快照。

**响应示例**:

```json
{
  "status": "success",
  "message": "当前状态",
  "data": {
    "started": true,
    "scenarioId": "LN2-v01",
    "acquiredFacts": ["F-01", "F-02", "F-03", "F-04"],
    "d1Choice": "B_灰度准备",
    "d1SubmittedAt": "2026-09-01T11:00:00.000Z",
    "d2Decision": null,
    "d2SubmittedAt": null,
    "state": { "S1": 58, "S2": "medium", "S3": 70 },
    "relationships": {
      "R1": { "tier": "neutral", "value": 50 },
      "R2": { "tier": "cooperative", "value": 65 },
      ...
    },
    "interviewLogCount": 5,
    "crossValidationCount": 2
  }
}
```

---

### 5. POST /api/sessions/:sessionId/messages

处理学生提问（访谈），执行意图分类→关系更新→信息披露判定。

**请求体**:

```json
{
  "roleId": "R2",
  "message": "闻笛，缺陷复现的具体触发条件是什么？QPS到多少会触发？",
  "preclassifiedIntent": "risk_inquiry"
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `roleId` | string | 是 | 被提问角色 ID（R1/R2/R3/R4） |
| `message` | string | 是 | 学生提问原文 |
| `preclassifiedIntent` | string | 否 | 外部 LLM 预分类意图（跳过内置分类） |

**响应示例**:

```json
{
  "status": "success",
  "message": "消息处理完成",
  "data": {
    "actionType": "structured_questioning",
    "trustChange": {
      "roleId": "R2",
      "before": 50,
      "after": 55,
      "change": 5,
      "beforeTier": "neutral",
      "newTier": "neutral"
    },
    "disclosedFacts": ["F-04"],
    "disclosureDetails": [
      {
        "factId": "F-04",
        "source": "breadcrumb_guaranteed",
        "breadcrumbRound": 2,
        "fact": { "id": "F-04", "content": "触发条件 2,500 笔/秒...", ... }
      }
    ],
    "formalInquiry": { "matchedRules": [], "canDiscloseFacts": [] },
    "response": "闻笛：[F-04] 触发条件 2,500 笔/秒；3,000 笔/秒复现率 100%（这个缺陷很严重...）",
    "acquiredFactsCount": 6,
    "stanceConflicts": [],
    "conflictAcknowledged": false,
    "breadcrumbSignals": [],
    "breadcrumbProgress": { "F-04": 2 }
  }
}
```

---

### 6. POST /api/sessions/:sessionId/decisions/d1

提交 D1 决策（中间决策：资源投向）。

**请求体**:

```json
{
  "choice": "B_灰度准备"
}
```

| choice 值 | 说明 |
|-----------|------|
| `A_连夜修复` | 修复路径，消耗全部 16h 窗口 |
| `B_灰度准备` | 灰度准备，信息增量最大 |
| `C_继续回归` | 继续回归测试，信息机会成本 |

**响应示例**:

```json
{
  "status": "success",
  "message": "D1 决策已提交",
  "data": {
    "d1Choice": "B_灰度准备",
    "autoDisclosedFacts": ["F-04", "F-12"],
    "stateImpact": { "S1": 58, "S2": "medium", "S3": 70 },
    "teachingIntent": "信息增量最大路径；展示准备本身就是信息获取"
  }
}
```

---

### 7. POST /api/sessions/:sessionId/decisions/d2

提交 D2 决策（最终决策：上线方案）。

**请求体**（字符串形式）:

```json
{
  "decision": "Limited_20%"
}
```

**请求体**（对象形式，推荐）:

```json
{
  "decision": {
    "option": "Limited_20%",
    "limited_pct": 20,
    "evidence_refs": ["F-04", "F-05", "F-12"],
    "rationale": "灰度20%在阈值以下，回滚5分钟满足C-04",
    "contingency_plan": "5分钟内切回老引擎"
  }
}
```

| option 值 | 说明 |
|-----------|------|
| `Go` | 全量上线 |
| `Delay` | 延迟上线 |
| `Limited_5%` | 5% 灰度 |
| `Limited_20%` | 20% 灰度 |
| `Limited_50%` | 50% 灰度 |

**响应示例**:

```json
{
  "status": "success",
  "message": "D2 决策已提交",
  "data": {
    "constraintResults": {
      "constraints_checked": [...],
      "all_passed": true,
      "violated_count": 0
    },
    "stateResults": { "S1": 75, "S2": "medium", "S3": 72 },
    "resultResults": { ... }
  }
}
```

---

### 8. GET /api/sessions/:sessionId/report

获取完整复盘报告（评分 + 证据链 + 反事实分析 + 改进建议）。

**响应示例** (简化):

```json
{
  "status": "success",
  "message": "复盘报告已生成",
  "data": {
    "scenarioId": "LN2-v01",
    "scenarioName": "上线前夜 · 星盘结算",
    "studentDecisions": {
      "d1Choice": "B_灰度准备",
      "d2Decision": { "option": "Limited_20%" },
      "acquiredFacts": ["F-01", "F-04", "F-12", ...]
    },
    "scoring": {
      "dimensions": {
        "user_insight": { "score": 16, "max": 20, "percentage": 80 },
        "decision_quality": { "score": 21, "max": 25, "percentage": 84 },
        "communication": { "score": 16, "max": 20, "percentage": 80 },
        "business_balance": { "score": 14, "max": 20, "percentage": 70 },
        "growth_reflection": { "score": 12, "max": 15, "percentage": 80 }
      },
      "totalScore": 79,
      "grade": "B+"
    },
    "evidenceChain": [
      { "factId": "F-04", "content": "...", "source": "访谈 R2（风险求证）", ... }
    ],
    "counterfactual": [
      { "option": "Go", "condition": "...", "result": "...", "isStudentChoice": false }
    ],
    "improvementSuggestions": [
      "【访谈覆盖不足】未访谈角色：许可，建议全面收集干系人信息"
    ],
    "interviewLog": [...],
    "generatedAt": "2026-09-01T11:00:00.000Z"
  }
}
```

---

### 9. POST /api/sessions/:sessionId/llm-scores

在复盘阶段注入 LLM 评分（决策质量 30% + 成长反思 100% 由 LLM 评估）。

**请求体**:

```json
{
  "llmDecisionScore": 75,
  "llmReflectionScore": 80,
  "reflectionText": "我意识到在访谈中应该更主动地追问风险信息..."
}
```

> 注入后需重新调用 `GET /api/sessions/:sessionId/report` 获取包含 LLM 评分的最终报告。

---

### 10. GET /api/sessions/:sessionId/roles

获取角色列表，包含立场信息和当前信任档位。

**响应示例**:

```json
{
  "status": "success",
  "data": [
    {
      "id": "R2",
      "name": "闻笛",
      "title": "QA负责人",
      "coreConcern": "产品质量和上线风险",
      "agenda": "希望延期或全量回滚，天然放大风险",
      "bias": "强调质量风险，倾向建议保守方案",
      "currentTier": "cooperative",
      "currentTrustScore": 65
    }
  ]
}
```

---

### 11. GET /api/sessions/:sessionId/facts

获取已获取和未获取事实详情。

**响应示例**:

```json
{
  "status": "success",
  "data": {
    "acquired": [
      { "id": "F-04", "content": "触发条件 2,500 笔/秒", "isRedLine": true, ... }
    ],
    "acquiredCount": 8,
    "missing": [
      { "id": "F-08", "content": "...", "isRedLine": true, ... }
    ],
    "missingCount": 9,
    "totalCount": 17
  }
}
```

---

## 前端对接指南

### 典型流程

```
1. POST /api/sessions                     → 创建会话，保存 sessionId
2. POST /api/sessions/:sid/messages       → 循环访谈（多轮）
3. POST /api/sessions/:sid/decisions/d1   → 提交 D1
4. POST /api/sessions/:sid/messages       → D1 后继续访谈（可选）
5. POST /api/sessions/:sid/decisions/d2   → 提交 D2
6. POST /api/sessions/:sid/llm-scores     → 注入 LLM 评分
7. GET  /api/sessions/:sid/report         → 获取复盘报告
8. DELETE /api/sessions/:sid              → 清理会话
```

### CORS

服务器已启用 CORS，前端可直接跨域调用。

### 会话管理

- 每个会话独立隔离，互不影响
- 会话超过 2 小时无活动自动清理
- 会话 ID 格式：`sess_` + 时间戳 + 随机串

### 错误码

| HTTP 状态码 | 含义 |
|-------------|------|
| 200 | 请求成功 |
| 400 | 参数错误或引擎执行异常 |
| 404 | 会话不存在或路径不存在 |
| 500 | 服务器内部错误 |

---

## 测试

```bash
# 运行全部 22 个 API 测试
npm test

# 测试覆盖：
#   - 公共接口（health, scenario）
#   - 会话管理（创建、查询、销毁、404）
#   - 核心交互（访谈、D1、D2、参数校验）
#   - 复盘报告
#   - LLM 评分注入
#   - 辅助接口（roles, facts, interview-log）
#   - 完整端到端流程
```
