# EvoKBase

一份交给 AI 执行的个人自进化知识库搭建与使用手册。

从零建立 Markdown 知识库，通过 GBrain MCP 检索，用查询和评审两个子 Agent 复用知识、推荐有价值的经验，再根据真实反馈改进方法。Horizon 是可选的外部资料发现工具。

## 怎么用

下载本仓库，在 Codex 中打开，然后发送：

```text
请按 docs/从零搭建操作手册.md，帮我从零搭建个人自进化知识库。
先检查环境和缺失参数，说明需要的软件、安装位置和本次改动。
在已授权范围内直接按官方文档安装、配置并验证；不要另写安装器。
不使用 AGENTS.md 调度知识流程，不接管已有知识库。
Horizon 按需启用。安装和配置的实际值写入我的实例记录。
```

如果还没选知识库目录或是否启用 Horizon，AI 会在相关步骤询问。已有授权不逐步重复确认；需要你操作的登录和原生信任审核，会给出具体说明。

## 阅读顺序

1. [从零搭建操作手册](docs/从零搭建操作手册.md)：环境、知识结构、GBrain、两个子 Agent、首次入库和反馈进化。
2. [Horizon 外部知识模块](docs/Horizon外部知识模块.md)：让 AI 按上游文档安装 Horizon，并完成资料筛选与入库评审。
3. [知识录入说明](templates/knowledge-base/04_系统维护/知识录入说明.md)：日常如何保存、更新和验证知识。
4. [验收说明](docs/开发验收.md)：判断搭建是否真的完成。

## 仓库提供什么

| 材料 | 用途 |
|---|---|
| `docs/` | 操作步骤、可复制提示词、验证和维护说明 |
| `templates/knowledge-base/` | 五层知识库入口和八类空白模板 |
| `templates/codex/knowledge_retriever.md` | 查询子 Agent 的角色提示词 |
| `templates/codex/knowledge_reviewer.md` | 评审子 Agent 的角色提示词 |
| `templates/codex/knowledge-flow.mjs` | 日常运行的 Hook 处理器：注入调度要求，由主 Agent 启动子 Agent |
| `tests/hook.test.mjs` | 配套 Hook 的行为检查，运行 `node --test tests/hook.test.mjs` |

EvoKBase 本身无需安装，没有 `evokbase` 命令或 npm 安装包。Git、Codex、GBrain、Horizon 及其依赖由执行 AI 根据当前官方说明直接安装。Hook 是日常运行材料，不承担软件下载、安装或升级。

当前为早期手册草案，许可证待确定。用户知识、凭据、实例配置和运行报告保存在用户自己的目录，不属于本仓库。旧安装器试验已退出交付范围；其测试通过不代表本手册已完成新用户全流程验收。
