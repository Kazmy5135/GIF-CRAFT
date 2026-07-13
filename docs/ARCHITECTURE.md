# 系统架构

## 总体结构

系统按“界面与功能、核心领域、基础设施”分层。页面和组件只发起用例，不直接拼接服务商请求；外部 AI API 通过统一接口适配，任务状态由核心层管理。

```text
H5 界面
  │
  ├─ 新生成 / 图库 / 序列帧库 / 帧工作区 / 导出 / 设置
  │
应用用例
  │
  ├─ 生成或确认源图 / 查询库存 / 创建或重做序列 / 整理帧与播放 FPS / 快照导出
  │
核心领域
  │
  ├─ Project / SourceImageAsset / SequencePreset / GenerationJob / Frame / FrameWorkspace / Snapshot / PNG ZIP Descriptor
  │
基础设施
  ├─ AI Gateway → Provider Adapter → 外部 AI API
  ├─ IndexedDB Repositories → 源图、序列、帧、工作区、候选与快照
  └─ Browser Export → PNG 编码、ZIP 打包与下载
```

MVP 生成链路统一为：

```text
文生图 ─────────┐
图生图 ─────────┼→ 已确认 SourceImageAsset
本地图片直接上传 ┘
                       │
                       ├→ SequencePreset（角色/场景）
                       ├→ 用户描述
                       └→ 结构化动画参数
                                │
                                └→ 图生序列帧任务 → Frame[]
```

源图来源差异只存在于源图准备和基础设施层。序列生成接收统一的已确认源图资产，不根据来源类型分支。同一 `SourceImageAsset` 可以多次创建新的 `GenerationJob.id`；整序列重做通过 `redoOfJobId` 记录来源关系，不复用旧任务 ID。

当前用户工作流为：

```text
新生成 → 确认静态图 → 序列生成 → 工作区 → 抽帧 / 播放 FPS / 预览 → 快照 → PNG ZIP
   ↑            ↑              ↑
图库复用 ───────┘    序列帧库 ──┘
```

## 关键模块

### `src/app`

负责应用启动、路由、全局错误边界、依赖装配和页面级生命周期。该层不承载具体 AI 服务商逻辑。

### `src/features`

按用户可感知能力组织功能，包括源图准备、资产库存、序列帧生成、帧工作区和导出。`asset-library` 只投影既有源图与任务仓储，提供图库、序列帧库和稳定导航，不成为第二数据源；源图准备负责文生图、图生图、本地上传和确认；序列帧生成负责角色/场景预设、提示词合成、有效参数确认、任务生命周期与整序列重做关系；帧工作区负责连续预览、审核、抽帧/排序、指定帧重试、非破坏性播放 FPS 和不可变快照；`export` 只消费已持久化快照及其受校验资源。功能模块通过核心用例协作，避免跨功能直接访问内部状态。

### `src/core`

包含与 UI 框架和服务商无关的领域对象、任务状态、业务规则和用例契约。它是稳定层，应能够脱离浏览器页面进行测试。

当前序列任务状态：

```text
draft → validating → ready → submitting → queued → generating → processing → completed
                         │           │          │           │
                         │           ├──────────┴───────────┴→ failed → retrying
                         │           └────────────────────────→ status_unknown → abandoned
                         └────────────────────────────────────→ cancelled
```

`status_unknown` 表示代理无法确认外部执行结果，不能自动重新提交；用户可在明确知悉远端可能仍在运行后停止本地跟踪。当前 Seedance 工具不提供外部任务 ID、查询、取消或真实百分比，因此页面只展示真实阶段与耗时。

### `src/infrastructure`

实现外部系统接入：AI 服务商适配、受控代理、浏览器存储、文件处理和导出。服务商差异在此收敛，不向上层泄漏专有字段。

### `src/shared`

保存真正跨模块复用的 UI 基础、通用类型、错误表示和小型工具。业务规则不能为了“复用”而下沉到该目录。

## 当前实现边界

- 客户端采用 React、TypeScript、React Router 和 Vite，入口为 `src/main.tsx`，应用装配位于 `src/app/App.tsx`。
- 一级路由以 `/create` 和 `/library` 组织新生成与库存；库存下分 `/library/images`、`/library/sequences`，工作区与导出使用 `/workspace/:jobId`、`/export/:snapshotId`。旧 `/image`、`/sequence` 与 `/frames?jobId=` 保留确定的兼容行为。
- H5 负责源图解码与确认、序列预设和请求预览、任务状态、轮询恢复、结果完整性校验、帧工作区编辑投影和 IndexedDB 历史。
- Express 轻量代理位于 `server/index.ts`，负责请求校验、单活跃序列任务保护、进程级幂等、代理实例边界、密钥隔离和服务商适配器调用。
- Gorilla Canvas MCP、Google Gemini 与 OpenAI 的厂商协议分别收敛在 `server/providers/mcp.ts`、`server/providers/gemini.ts` 和 `server/providers/openai.ts`。序列生成使用 Gorilla MCP Seedance 2.0 fast 图生视频工具；服务端先安全下载和验证 H.264 MP4，再通过 `ffmpeg` 均匀抽取 8/12 个 PNG 帧。
- 浏览器存储统一使用 IndexedDB `gif-craft` v4：保留 `source-images`、`sequence-jobs`、`frame-resources` 和 `storage-meta`，新增 `frame-workspaces`、`workspace-frame-resources` 与 `frame-workspace-snapshots`。v1/v2/v3 数据增量迁移后继续可读；任务结果、工作区修订、候选 Blob 和不可变快照按引用图保护并执行容量清理。
- 播放 FPS 作为 v4 工作区记录的可选覆盖字段持久化；旧记录读取时回退到来源任务 FPS，因此无需提升数据库版本或改写历史记录。PNG ZIP 在浏览器中按快照顺序逐帧校验/转换并使用 `fflate` 打包，不持久化第二份帧 Blob。
- 生产构建生成 `dist/` 客户端资源与 `dist-server/` 服务端资源；直接访问 H5 子路由由代理回退到 `index.html`。
- 当前没有账户、计费、云端项目和服务端长期素材持久化；生图结果、序列任务、帧 Blob、工作区修订、候选与快照以及非敏感模板覆盖保存在浏览器本地。

## 数据边界

- `Project`：项目元数据、提示词、画面规格和帧序列引用。
- `SourceImageAsset`：统一源图资产、来源类型、资源引用、尺寸、生成来源和用户确认状态。
- `SequencePreset`：角色/场景类型、动作子类、底词版本、默认帧数、帧率、循环方式和对齐规则。
- `GenerationJob`：服务商无关的不可变请求快照、状态、阶段、恢复边界、错误、父子重试关系、可选整序列 `redoOfJobId` 和结果完整性；其 ID 同时是用户可见序列 ID。
- `Frame`：稳定帧 ID、来源任务、原始/显示索引、本地 Blob 引用、尺寸、格式、大小和服务商时间点。
- `FrameWorkspace`：来源任务交接、独立显示顺序、帧审核决策、原版/候选修订、来源 FPS、播放 FPS 覆盖、乐观 revision 和重试尝试；不得改写原始 `Frame` 或生成参数。
- `FrameWorkspaceSnapshot`：按工作区 revision 追加保存的不可变导出输入，包含连续输出索引、采用修订、帧率、循环、画布和锚点。
- `ProviderConfig`：服务商类型、非敏感配置及凭据引用；不得将明文密钥写入仓库。
- `PngZipExportDescriptor`：从不可变快照派生的序列 ID、快照/工作区 revision、FPS、循环、画布、锚点、连续文件名和帧来源清单；页面导出状态不持久化。

## 质量要求

- 所有任务状态变化可追踪、可解释。
- 网络超时、限流、鉴权失败和服务商错误需映射为统一错误类型。
- 重试应具备幂等策略，避免产生不可识别的重复外部任务。
- 帧顺序使用稳定索引，删除或重试不得破坏原始序列关系。
- 工作区删除采用可恢复的非破坏性移除；排序只改变独立槽位顺序，原始 `providerIndex` 和 `sequenceIndex` 不变。
- 工作区自动保存单飞串行化，旧 revision 不能覆盖新 revision；当前采用资源必须真实可解码后才可生成快照。
- 工作区播放 FPS 修改只创建新 revision；预览与新快照读取覆盖值，原任务和旧快照保持不变。
- 指定帧重试回执必须在轮询前持久化；`status_unknown` 不自动重提，可查询已有子任务或显式放弃本地跟踪。
- 序列任务保存不可变源图引用、预设 ID/版本、编译提示词和最终有效参数。
- 帧数、帧率、循环方式、画布和锚点由结构化字段表达，不能只依赖提示词。
- 角色预设保持底部中心锚点和脚底基线；场景预设保持固定镜头和完整画布。
- 对 API 密钥、用户提示词和素材地址执行分级日志与脱敏。
- PNG ZIP 导出只读取不可变快照及与之匹配的本地 Blob；文件名按连续输出索引生成，`manifest.json` 冻结 FPS、循环、画布和来源修订，任何资源缺失或不一致都中止导出并提供恢复动作。

## 待决策项

- GIF、WebP、视频等动态格式的优先级、编码线程与内存上限。
- 项目级草稿与库存长期容量策略。
- 生产代理的鉴权、限流、部署平台与素材隐私策略。
