# GIF CRAFT 模块索引

本文件是新 Agent 理解项目的最小上下文入口。它只描述当前有效的模块职责、边界、入口和依赖；历史设计与每日修改分别保存在 `AIwork/` 的大模块文档和 Code Review 文档中。

## 阅读规则

1. 从下表定位目标模块。
2. 阅读该模块的“长期文档”和“有效设计”。
3. 只打开模块入口、直接依赖和测试入口。
4. 索引不足或失实时才扩大代码搜索，并在当前任务中修正索引。

模块状态：`Planned`、`Active`、`Deprecated`。大模块实施期间可以附加 `Planning` 标记，但关闭后必须回到稳定状态。

## 快速索引

| ID | 模块 | 状态 | 主要职责 | 入口 | 直接依赖 |
|---|---|---|---|---|---|
| `GOVERNANCE` | 项目治理 | Active | 变更分级、文档生命周期、模块导航和审查归档 | [`AGENTS.md`](AGENTS.md) | None |
| `APP` | 应用外壳 | Active | H5 启动、左侧页签、路由、全局生命周期和依赖装配 | [`src/app/App.tsx`](src/app/App.tsx) | `SOURCE_IMAGE`, `SETTINGS` |
| `SETTINGS` | 设置 | Active / Planning | API 配置状态和提示词模板覆盖；规划 MCP 连接状态 | [`src/features/settings/SettingsPage.tsx`](src/features/settings/SettingsPage.tsx) | `AI_GATEWAY`, `STORAGE`, `CORE` |
| `PROJECT` | 项目管理 | Planned | 项目元数据、草稿和项目级配置 | [`src/features`](src/features/README.md) | `CORE`, `STORAGE` |
| `SOURCE_IMAGE` | 源图准备 | Active / Planning | 文生图、图生图、本地上传、结果历史与源图确认；规划 MCP 默认提供方 | [`src/features/source-image/SourceImageContext.tsx`](src/features/source-image/SourceImageContext.tsx) | `CORE`, `AI_GATEWAY`, `STORAGE`, `SETTINGS` |
| `GENERATION` | 图生序列帧编排 | Planned | 通过角色/场景预设和已确认源图创建游戏序列帧任务 | [`src/features`](src/features/README.md) | `CORE`, `AI_GATEWAY`, `STORAGE` |
| `FRAME_WORKSPACE` | 帧工作区 | Planned | 帧预览、筛选、删除、排序和局部重试 | [`src/features`](src/features/README.md) | `CORE`, `GENERATION`, `SHARED` |
| `EXPORT` | 导出 | Planned | 图片包及后续 GIF、WebP、视频导出 | [`src/infrastructure`](src/infrastructure/README.md) | `CORE`, `FRAME_WORKSPACE` |
| `AI_GATEWAY` | AI Gateway | Active / Planning | 已实现统一文生图、图生图与双服务商差异；规划 MCP 图片提供方 | [`server/providers`](server/providers) | `CORE` |
| `STORAGE` | 存储 | Active | 已实现源图历史与模板覆盖的浏览器本地存储；云端适配仍为规划 | [`src/infrastructure/storage`](src/infrastructure/storage) | `CORE` |
| `CORE` | 核心领域 | Active | 已实现源图任务、资产、提示词与能力契约；其余领域对象按模块扩展 | [`src/core/sourceImage.ts`](src/core/sourceImage.ts) | None |
| `SHARED` | 共享基础 | Planned | 跨模块 UI 基础、类型、错误和小型工具 | [`src/shared`](src/shared/README.md) | None |

## 模块详情

### GOVERNANCE — 项目治理

- **职责**：强制变更分级；管理大模块批准和状态；归档跨日工作与小修改 Review；维护模块导航。
- **非职责**：不决定产品功能，不替代业务测试，不把纯配置差异写入逻辑变更清单。
- **数据所有权**：模块 ID、文档状态、批准信息、Review 基线和历史链接。
- **输入/输出**：输入用户需求和 Git 差异；输出判级、模块文档、工作记录、Review 文档和索引更新。
- **上游/下游**：上游是用户需求；下游是所有项目模块。业务模块不得反向定义治理规则。
- **核心不变量**：大模块未批准不实施；关闭档案不重写；模块索引只表示当前事实。
- **主要失败模式**：误判小修改、跳过批准、多个主文档、Review 基线推进错误、索引失真。
- **测试入口**：文档命名、字段、链接、ID 和流程场景检查。
- **长期文档**：[`AIwork/README.md`](AIwork/README.md)。
- **有效设计**：[`MOD-20260710-001`](AIwork/2026-07-10/MOD-20260710-001-document-governance.md)。

### APP — 应用外壳

- **职责**：应用启动、路由、全局错误边界、依赖装配和页面生命周期。
- **非职责**：不保存业务规则，不直接拼接 AI 服务商请求。
- **数据所有权**：仅拥有应用级临时状态和依赖注册，不拥有项目或生成领域数据。
- **输入/输出**：输入用户导航和运行环境；输出页面装配及全局生命周期事件。
- **依赖边界**：可依赖 `SHARED` 和功能模块公开入口；禁止依赖服务商内部实现。
- **核心不变量**：业务能力通过功能或核心用例访问。
- **主要失败模式**：全局错误未隔离、路由状态丢失、基础设施泄漏到页面装配。
- **测试入口**：[`src/app/App.test.tsx`](src/app/App.test.tsx)。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)、[`MOD-20260711-001`](AIwork/2026-07-11/MOD-20260711-001-basic-h5-ui-shell.md) 和 [`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md)。

### SETTINGS — 设置

- **职责**：管理 API 连接的非敏感配置、凭据引用、能力校验结果和提示词模板覆盖。
- **非职责**：不持久化明文服务端密钥，不提交生成任务，不拥有项目或图片结果。
- **数据所有权**：`ProviderProfile`、`PromptTemplateOverride`、连接验证时间和能力快照。
- **输入/输出**：输入用户配置和模板覆盖；输出经过校验的连接引用和版本化提示词设置。
- **依赖边界**：通过 `AI_GATEWAY` 校验连接，通过 `STORAGE` 保存非敏感配置；业务页面不能读取完整凭据。
- **核心不变量**：内置模板不可变；用户修改形成覆盖版本；明文 API Key 默认只存在内存会话。
- **主要失败模式**：密钥泄漏、连接测试隐式计费、过期能力快照、模板覆盖无法复现。
- **测试入口**：设置页通过 [`src/app/App.test.tsx`](src/app/App.test.tsx) 的路由装配测试覆盖；模板编译见 [`src/core/promptTemplates.test.ts`](src/core/promptTemplates.test.ts)。
- **长期文档**：[`AI API 接入约定`](docs/AI_API.md)、[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md) 和 [`MOD-20260711-003`](AIwork/2026-07-11/MOD-20260711-003-mcp-image-provider.md)（待 MCP 契约）。

### PROJECT — 项目管理

- **职责**：管理项目元数据、提示词、画面规格、非敏感配置和草稿生命周期。
- **非职责**：不执行 AI 请求，不生成或导出帧。
- **数据所有权**：`Project` 聚合及其配置引用。
- **输入/输出**：输入用户项目操作；输出可供生成、帧工作区和导出使用的项目上下文。
- **依赖边界**：依赖 `CORE` 契约和 `STORAGE`；禁止持有明文服务商凭据。
- **核心不变量**：项目 ID 稳定，敏感凭据与项目数据分离。
- **主要失败模式**：草稿恢复失败、版本不兼容、敏感数据被持久化。
- **测试入口**：尚未建立。
- **长期文档**：[`项目定义`](docs/PROJECT.md)、[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md) 和 [`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md)。

### SOURCE_IMAGE — 源图准备

- **职责**：通过文生图、图生图或本地直接上传获得、追踪并确认统一源图资产。
- **非职责**：不生成序列帧，不管理帧编辑或导出，不提供专业图片编辑器。
- **数据所有权**：源图任务、来源类型、候选结果、生成历史和当前确认状态。
- **输入/输出**：输入文字提示词或本地参考图；输出一个已确认的 `SourceImageAsset`。
- **依赖边界**：通过 `AI_GATEWAY` 使用源图生成能力，通过 `STORAGE` 保存可恢复引用；禁止直接依赖服务商实现。
- **核心不变量**：只有用户确认且可读取的源图才能进入序列生成；本地直接上传不调用源图生成 API。
- **主要失败模式**：上传图片无效、生成失败、资源过期、能力不支持、未确认结果被继续使用。
- **测试入口**：[`src/app/App.test.tsx`](src/app/App.test.tsx)、[`src/features/source-image/imageFile.test.ts`](src/features/source-image/imageFile.test.ts)、[`src/core/promptTemplates.test.ts`](src/core/promptTemplates.test.ts)、[`server/providers/imageParsing.test.ts`](server/providers/imageParsing.test.ts)；真实 API 凭据契约测试待执行。
- **长期文档**：[`项目定义`](docs/PROJECT.md)、[`系统架构`](docs/ARCHITECTURE.md) 和 [`AI API 接入约定`](docs/AI_API.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)、[`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md) 和 [`MOD-20260711-003`](AIwork/2026-07-11/MOD-20260711-003-mcp-image-provider.md)（待 MCP 契约）。

### GENERATION — 图生序列帧编排

- **职责**：使用已确认源图、角色/场景预设和用户描述创建游戏序列帧任务，并推进状态、报告进度、处理取消和安全重试。
- **非职责**：不包含具体厂商字段，不负责帧编辑或导出编码。
- **数据所有权**：`SequencePreset`、`GenerationJob`、任务进度、统一错误和重试记录。
- **输入/输出**：输入已确认源图资产、角色/场景预设、用户描述和结构化序列参数；输出带帧率、循环方式和对齐信息的有序帧结果或统一失败信息。
- **依赖边界**：通过 `AI_GATEWAY` 调用服务商，通过 `STORAGE` 保存可恢复状态。
- **核心不变量**：任务保存不可变源图、预设版本、编译提示词和有效参数快照；工程参数优先于用户描述；状态转换合法；重试具备幂等策略。
- **主要失败模式**：对齐漂移、帧率映射不透明、预设版本不可复现、循环首尾跳变、重复计费、状态回退、结果帧索引混乱。
- **测试入口**：尚未建立。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)、[`AI API 接入约定`](docs/AI_API.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)。

### FRAME_WORKSPACE — 帧工作区

- **职责**：连续帧预览、筛选、删除、稳定排序和指定帧重试入口。
- **非职责**：不直接访问 AI 服务商，不实现最终导出编码。
- **数据所有权**：工作区选择、展示顺序和帧审核状态；原始生成任务仍由 `GENERATION` 管理。
- **输入/输出**：输入生成帧集合和用户编辑动作；输出经过整理的稳定帧序列。
- **依赖边界**：依赖 `CORE`、`GENERATION` 和 `SHARED`；禁止绕过任务用例提交 AI 请求。
- **核心不变量**：帧拥有稳定索引，删除和重试不破坏原始序列关系。
- **主要失败模式**：排序漂移、资源失效、局部重试覆盖错误帧。
- **测试入口**：尚未建立。
- **长期文档**：[`项目定义`](docs/PROJECT.md)、[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)。

### EXPORT — 导出

- **职责**：将已整理帧转换为图片包，并扩展 GIF、WebP 或视频输出。
- **非职责**：不生成新帧，不修改项目原始生成结果。
- **数据所有权**：`ExportJob`、导出参数、输出状态和结果引用。
- **输入/输出**：输入稳定帧序列、帧率、尺寸和质量；输出文件或可下载资源。
- **依赖边界**：依赖 `CORE` 和 `FRAME_WORKSPACE` 的公开结果；禁止反向修改生成任务。
- **核心不变量**：导出顺序与工作区顺序一致，失败不破坏源帧。
- **主要失败模式**：浏览器内存不足、资源过期、编码失败、文件不完整。
- **测试入口**：尚未建立。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)、[`路线图`](docs/ROADMAP.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)。

### AI_GATEWAY — AI Gateway

- **职责**：定义统一文生图、图生图、图生序列帧能力，适配服务商鉴权和任务协议，映射统一错误。
- **非职责**：不管理页面状态，不拥有业务工作流或用户项目。
- **数据所有权**：服务商非敏感配置、能力描述和外部任务 ID 映射。
- **输入/输出**：输入统一源图或序列生成请求；输出统一源图任务、序列任务、结果或错误。
- **依赖边界**：实现 `CORE` 中的网关契约；任何业务模块不得直接依赖服务商实现。
- **核心不变量**：服务商专有字段不向核心和页面泄漏；凭据不进入仓库或普通日志。
- **主要失败模式**：鉴权失败、限流、超时、回调丢失、错误映射不完整。
- **测试入口**：[`server/providers/imageParsing.test.ts`](server/providers/imageParsing.test.ts)；真实服务商成功响应契约测试待配置凭据后执行。
- **长期文档**：[`AI API 接入约定`](docs/AI_API.md)、[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md)、[`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md) 和 [`MOD-20260711-003`](AIwork/2026-07-11/MOD-20260711-003-mcp-image-provider.md)（待 MCP 契约）。

### STORAGE — 存储

- **职责**：实现浏览器本地存储，并为未来云端项目存储提供适配边界。
- **非职责**：不决定项目业务规则，不持久化未经允许的明文凭据。
- **数据所有权**：持久化版本、序列化格式和存储迁移实现。
- **输入/输出**：输入核心持久化契约和领域快照；输出恢复后的项目与任务状态。
- **依赖边界**：实现 `CORE` 契约；功能模块不得直接绑定具体浏览器存储 API。
- **核心不变量**：版本可识别，失败可恢复，敏感数据遵循最小保存原则。
- **主要失败模式**：容量耗尽、序列化损坏、版本不兼容、清理误删。
- **测试入口**：当前由源图页面恢复测试间接覆盖；容量、迁移和失败恢复测试待补充。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md) 和 [`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md)。

### CORE — 核心领域

- **职责**：定义领域对象、业务规则、任务状态、统一错误和用例契约。
- **非职责**：不依赖 UI 框架、浏览器 API 或服务商 SDK。
- **数据所有权**：`Project`、`SourceImageAsset`、`SequencePreset`、`GenerationJob`、`Frame`、`ExportJob` 的领域定义。
- **输入/输出**：输入领域命令和网关结果；输出合法状态、领域事件和用例结果。
- **依赖边界**：不得依赖 `APP`、功能模块或基础设施实现。
- **核心不变量**：领域规则可脱离浏览器测试，外部差异通过契约隔离。
- **主要失败模式**：非法状态转换、基础设施字段泄漏、领域对象职责重叠。
- **测试入口**：[`src/core/promptTemplates.test.ts`](src/core/promptTemplates.test.ts)、[`server/providers/imageParsing.test.ts`](server/providers/imageParsing.test.ts)。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260710-002`](AIwork/2026-07-10/MOD-20260710-002-source-image-sequence-flow.md) 和 [`MOD-20260711-002`](AIwork/2026-07-11/MOD-20260711-002-source-image-ui-api.md)。

### SHARED — 共享基础

- **职责**：提供真正跨模块复用的 UI 基础、通用类型、错误表示和小型工具。
- **非职责**：不保存领域规则，不成为无法归类代码的收容区。
- **数据所有权**：不拥有业务数据。
- **输入/输出**：向模块提供稳定、无业务偏向的基础能力。
- **依赖边界**：不得依赖具体业务功能；业务模块可以单向依赖它。
- **核心不变量**：共享内容至少被多个模块合理复用，且不改变业务语义。
- **主要失败模式**：业务逻辑下沉、循环依赖、抽象过早。
- **测试入口**：尚未建立。
- **长期文档**：[`系统架构`](docs/ARCHITECTURE.md)。
- **有效设计**：已批准 [`MOD-20260711-001`](AIwork/2026-07-11/MOD-20260711-001-basic-h5-ui-shell.md)。
