# LLM 集成配置指南

## 概述

CareerCraft 后端 API 层已集成 LLM 适配器模块（`backend/llm-adapter.js`），支持通过环境变量配置接入任意 OpenAI 兼容 API。当 LLM 未配置或调用失败时，系统自动降级到关键词分类器，保证服务不中断。

## 支持的 LLM 服务

| 服务商 | BASE_URL | 推荐模型 | 备注 |
|--------|----------|---------|------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 国际通用 |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 免费额度充足 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 性价比高 |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 中文理解强 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-turbo` | 阿里云生态 |
| Ollama 本地 | `http://localhost:11434/v1` | `qwen2.5:7b` | 本地部署，无需 API Key |

## 快速配置

### 1. 创建 `.env` 文件

在项目根目录创建 `.env` 文件（已加入 `.gitignore`，不会提交到仓库）：

```bash
# 必填
LLM_ENABLED=true
LLM_API_KEY=sk-your-api-key-here

# 可选（不填使用默认值）
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_TIMEOUT=10000
```

### 2. 推荐配置（DeepSeek 示例）

```bash
LLM_ENABLED=true
LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxx
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_TIMEOUT=15000
```

### 3. 本地 Ollama 配置（无需 API Key）

```bash
LLM_ENABLED=true
LLM_API_KEY=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:7b
LLM_TIMEOUT=30000
```

## LLM 功能清单

### 意图分类（实时）

**触发时机**：学生发送访谈消息时（`POST /api/sessions/:sessionId/messages`）

**处理流程**：
1. 如果请求体包含 `preclassifiedIntent`，直接使用（`intentSource: "preclassified"`）
2. 如果 LLM 已启用，调用 LLM 分类（`intentSource: "llm"`）
3. LLM 失败或未启用，降级到关键词分类（`intentSource: "keyword"`）

**响应新增字段**：
```json
{
  "actionType": "structured_questioning",
  "intentSource": "llm",
  "trustChange": { ... },
  ...
}
```

### 意图分类预览（不修改状态）

```
POST /api/sessions/:sessionId/classify-intent
Body: { "message": "风险有多大" }

Response:
{
  "status": "success",
  "data": {
    "intent": "risk_verification",
    "source": "llm"
  }
}
```

### LLM 决策质量评分

在复盘阶段自动评估学生决策质量（0-100 分），评分维度：
- 证据充分性
- 方案合理性
- 风险意识
- 利益平衡
- 约束遵守

### LLM 成长反思评分

评估学生复盘反思文字质量（0-100 分），评分维度：
- 具体性（是否针对具体决策节点）
- 自我归因（是否分析自身认知偏差）
- 改进可操作性（改进计划是否具体可执行）
- 元认知（是否反思信息获取策略）

反模式扣分：万能模板式回答、只描述不反思、归咎外部因素。

### 评分注入方式

**模式 1 — 手动注入**（不依赖 LLM 服务）：
```bash
POST /api/sessions/:sessionId/llm-scores
Body: {
  "llmDecisionScore": 75,
  "llmReflectionScore": 80,
  "reflectionText": "我学到了很多..."
}
```

**模式 2 — LLM 自动评分**（需 LLM_ENABLED=true）：
```bash
POST /api/sessions/:sessionId/llm-scores
Body: {
  "reflectionText": "我在这次决策中遗漏了QA的关键信息...",
  "autoScore": true
}

Response:
{
  "status": "success",
  "data": {
    "llmDecisionScore": 78,
    "llmReflectionScore": 82,
    "decisionFeedback": {
      "evidenceSufficiency": "获取了3条红线事实，证据基本充分",
      "planRationality": "灰度20%在阈值以下，方案合理",
      "riskAwareness": "有回滚方案但不够具体",
      "balance": "平衡了技术和质量",
      "overallFeedback": "决策整体合理，但回滚方案需要更具体。"
    },
    "reflectionFeedback": {
      "specificity": "针对F-04遗漏做了具体分析",
      "selfAttribution": "承认自己没有追问QA",
      "actionability": "改进计划明确：下次用结构化提问清单",
      "metacognition": "反思了信息获取策略的不足",
      "overallFeedback": "反思质量较高，有具体的改进计划。"
    },
    "source": "auto"
  }
}
```

## 降级机制

| 场景 | 行为 |
|------|------|
| `LLM_ENABLED` 未设置或为 `false` | 全部使用关键词分类，评分使用手动注入或规则兜底 |
| `LLM_API_KEY` 未设置但 `LLM_ENABLED=true` | 打印警告日志，使用关键词兜底 |
| LLM API 调用超时 | 返回 null，降级到关键词分类 |
| LLM 返回无效意图 | 返回 null，降级到关键词分类 |
| LLM 评分调用失败 | 评分字段为 null，使用规则兜底评分 |
| LLM 返回非 JSON 格式 | 尝试提取 JSON 片段，失败则降级 |

## 健康检查

```bash
GET /api/health

Response:
{
  "status": "success",
  "data": {
    "status": "running",
    "llmEnabled": true,
    "llmModel": "deepseek-chat",
    ...
  }
}
```

## 测试

```bash
# 运行 LLM 适配器单元测试（29 个，使用 Mock，不需要真实 API Key）
node backend/tests/llm-adapter.test.js

# 运行 API 端到端测试（22 个，不依赖 LLM）
node backend/tests/api.test.js

# 运行全部测试
npm test
```

## 文件结构

```
backend/
├── server.js              # Express 服务器（集成 LLM 适配器）
├── llm-adapter.js         # LLM 适配器模块
├── tests/
│   ├── api.test.js        # API 端到端测试（22 个）
│   └── llm-adapter.test.js # LLM 适配器单元测试（29 个）
├── CareerCraft API 接口文档.md
└── LLM 集成配置指南.md     # 本文档
```

## 注意事项

1. **API Key 安全**：`.env` 文件已加入 `.gitignore`，切勿将 API Key 硬编码到代码中
2. **延迟影响**：LLM 意图分类会增加约 0.5-2 秒延迟，建议设置 `LLM_TIMEOUT=10000`
3. **成本控制**：意图分类每条学生消息调用一次 LLM；评分仅在复盘阶段调用一次
4. **稳定性**：即使 LLM 服务完全不可用，系统仍可正常运行（关键词兜底 + 规则评分）
5. **模型选择**：意图分类任务简单，推荐使用轻量模型（如 `deepseek-chat`、`glm-4-flash`）以降低成本和延迟
