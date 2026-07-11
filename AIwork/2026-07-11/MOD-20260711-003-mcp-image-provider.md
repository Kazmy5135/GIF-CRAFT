---
id: MOD-20260711-003
title: MCP 图片能力接入与官方 API 替换
type: major
status: Closed
created: 2026-07-11
updated: 2026-07-11
timezone: Asia/Hong_Kong
affected_modules:
  - AI_GATEWAY
  - SOURCE_IMAGE
  - SETTINGS
  - CORE
approval:
  state: approved
  approved_by: user
  approved_at: 2026-07-11
related_commits:
  - 2c50477
  - 0a95b74
  - ed7a39b
supersedes: []
---

# MCP 图片能力接入与官方 API 替换

## 目标

- 在服务端代理中增加 MCP Client，将指定 MCP Server 的图片工具适配为 GIF CRAFT 的统一文生图和图生图能力。
- 生图页面继续使用既有统一请求、任务状态、结果历史和源图确认流程，不感知 MCP 专有协议。
- 在 MCP 能力通过契约与真实调用验证后，将其设为生图模块的默认提供方。
- 将 MCP 集合中的 Banana 与 OpenAI Image2 作为两个独立提供方，同时支持文生图和图生图。
- 所有 MCP 访问凭据只存在于服务端环境变量或部署密钥管理中。

## 非目标

- 不把 MCP 访问令牌写入 H5、IndexedDB、文档、日志或 Git。
- 不在 MCP 工具契约未知时猜测工具名、参数或图片返回格式。
- 不在首轮接入中删除现有 Gemini/OpenAI 适配器代码；先保留为关闭状态的回退路径，稳定后是否移除另行判级。
- 不在本模块实现图生序列帧；除非 MCP 同时提供该能力并另行补充、批准范围。
- 不使用已经在聊天中公开的令牌进行开发或测试。

## 判级理由

本变更新增 MCP 传输与鉴权依赖，改变 AI Gateway 的默认调用方向、服务商能力发现、错误映射和部署配置，并涉及敏感凭据与潜在计费，属于大模块。

## 影响模块

- `AI_GATEWAY`：增加 MCP Client、工具发现、工具调用、响应解析和统一错误映射。
- `SOURCE_IMAGE`：使用 MCP 能力快照显示有效参数，但不直接依赖 MCP 工具。
- `SETTINGS`：显示 MCP Server、配置状态、目标工具和能力检查结果，不接收或回显完整令牌。
- `CORE`：仅在现有统一契约无法表达 MCP 能力时扩展；禁止泄漏 MCP 专有字段。
- 服务端代理：读取 MCP 环境变量，管理连接、超时、幂等和脱敏日志。

## 当前行为

- H5 调用同源 `/api/source-images/generate`。
- 代理当前直接适配 Google Gemini 官方 API 与 OpenAI Image API。
- MCP Server 地址、传输方式、鉴权头、工具列表和输入输出 Schema 尚未提供。
- 用户曾在聊天中发送一个 JWT；该令牌视为已暴露，禁止使用，必须在提供方后台撤销或轮换。

## 目标行为

### 调用链

```text
H5 生图页
  → POST /api/source-images/generate
  → 统一 SourceImageGenerateRequest
  → MCP Provider Adapter
  → MCP Client（服务端）
  → tools/list / tools/call
  → MCP 图片工具
  → 图片结果解析与本地历史
```

### 接入前置契约

实施前必须取得以下不含秘密的信息：

- MCP Server 地址与传输方式：Streamable HTTP、SSE 或其他明确协议。
- 鉴权方式：Header 名称、Bearer 或自定义格式；只描述格式，不在文档中记录真实值。
- `tools/list` 输出，至少包含目标文生图、图生图工具的名称和完整 `inputSchema`。
- 每个目标工具的一份脱敏成功响应和失败响应。
- 图片返回形式：MCP image content、Base64、资源 URI 或短期 URL。
- 是否支持候选数量、宽高比、质量、参考图、超时查询和取消。
- 计费、并发、限流、图片保留时间和生产使用授权。

### 默认提供方切换

- MCP 契约测试和真实文生图/图生图均成功后，`/api/providers` 将 MCP 标记为默认且可用。
- 现有 Gemini/OpenAI 适配器首轮只从 UI 默认列表隐藏或标记禁用，不直接删除，以便 MCP 故障时安全回退。
- MCP 能力不足时，页面必须禁用不支持参数，不得伪装成已支持。
- MCP 调用仍使用 `clientRequestId` 幂等保护；如果 MCP 没有服务端幂等能力，网络超时进入 `status_unknown`，不自动重新生成。

### 建议环境变量

```text
MCP_SERVER_URL=<server-side URL>
MCP_AUTH_TOKEN=<rotated secret>
MCP_ASSET_HOSTS=<optional comma-separated allowlist>
```

变量名可在确认 MCP 的官方接入方式后调整。`.env.example` 只能保留空值和说明。

## 接口与数据流

- H5 与现有同源代理接口保持不变，避免页面与 MCP 耦合。
- MCP Adapter 将统一请求映射到目标工具 `inputSchema`，并保存最终有效参数。
- MCP 响应必须转换为受控 `data:` 图片或代理可读取资源；无有效图片时返回 `no_valid_image`。
- MCP 的文字说明只能作为脱敏 `providerNote`，不能把原始错误体或内部凭据返回 H5。
- 设置页通过 `/api/providers` 读取配置与能力状态，不读取 `MCP_AUTH_TOKEN`。

## 失败场景

- 令牌已撤销、过期或权限不足。
- MCP Server 只供交互式 Agent 使用，不允许作为产品后端服务。
- MCP 仅支持 stdio 且无法部署到当前服务器环境。
- 工具列表或 Schema 在运行中变化，导致请求映射失效。
- 工具返回远程短期 URL，保存到历史后过期。
- MCP 聚合层吞掉服务商任务 ID，超时后无法查询是否已计费。
- 文生图存在但图生图缺失，无法完全替换现有 API。
- 图片内容返回在非标准文本字段中，解析器误判成功。
- MCP 故障时直接重试产生重复计费。

## 安全和性能影响

- **凭据**：聊天中公开的旧令牌不得使用；新令牌只能由服务端环境注入，日志必须过滤 Authorization、自定义鉴权头和 URL 查询秘密。
- **权限**：新令牌应使用最小工具权限、可撤销、可轮换的独立凭据，不复用个人全权限会话令牌。
- **网络**：服务端必须限制 MCP Server 地址来源，避免用户输入任意 URL 形成 SSRF。
- **素材**：参考图只在用户提交图生图时发送，并在 UI 显示实际 MCP 提供方。
- **性能**：MCP 增加一层协议与聚合延迟；设置连接超时、最大响应尺寸和图片数量限制。
- **稳定性**：首轮保留现有适配器作为关闭状态回退，避免 MCP 单点故障导致生图功能完全不可用。

## 实施步骤

1. 用户撤销已公开令牌，并提供脱敏 MCP 连接信息、tools 列表和响应样例。
2. 用户批准本文档及最终确认的工具映射。
3. 独立提交批准后的设计文档。
4. 增加 MCP 配置 Schema、服务端 Client 和 Provider Adapter。
5. 增加工具发现、能力映射、超时和错误脱敏。
6. 将 MCP 输出映射为统一图片结果并补充契约测试。
7. 更新设置页和生图页的提供方状态，不向浏览器下发令牌。
8. 使用轮换后的本地秘密执行一次文生图和一次图生图真实验证。
9. 验证通过后切换默认提供方；保留禁用的官方适配器回退路径。
10. 更新长期文档、模块索引、提交记录和验收状态。

## 验收标准

- [x] 仓库、浏览器、IndexedDB、URL 和普通日志中不存在 MCP 真实令牌。
- [x] H5 不直接连接 MCP，且现有统一生图接口保持稳定。
- [x] 设置页能够显示 MCP 已配置/未配置、工具名称和能力矩阵。
- [x] MCP 文生图成功返回可预览、下载和确认的 `SourceImageAsset`。
- [x] MCP 图生图能够传递参考图并返回可用结果。
- [x] 不支持的参数在计费请求前被禁用或映射，并显示最终有效值。
- [x] 无图片、鉴权失败、限流、超时和异常 Schema 均返回脱敏统一错误。
- [x] 重复点击和网络超时不会自动产生第二个计费请求。
- [x] MCP 验证成功后成为默认提供方，现有适配器仍可作为显式回退。
- [x] MCP 不具备完整替换能力时，模块不得标记 `Verified` 或删除现有适配器。

## 测试方案

- [x] `tools/list` 正常、空列表、目标工具缺失和 Schema 变化。
- [x] 文生图、图生图请求字段映射与隐藏字段隔离。
- [x] MCP image content、Base64、资源 URI、相对 URL 和不支持返回格式。
- [x] 单张、无图片、文字说明和超大响应；MCP 当前声明单候选，因此 UI 固定为 1。
- [x] 401/403、429、5xx、连接失败、超时和状态未知统一走脱敏失败或未知状态路径。
- [x] 客户端幂等 ID、防重复提交和超时后手动恢复。
- [x] 设置状态、页面能力选项和默认提供方切换。
- [x] 服务端日志、响应和持久化内容的凭据扫描。
- [x] 使用轮换后的凭据完成 Banana 与 Image2 的真实文生图和图生图测试。

## 验证结果

- 已确认 Server URL 为 `https://canvas.dxx.cn/api/mcp/sse`，传输为旧式 HTTP+SSE，鉴权格式为 Bearer Token。
- 已实现服务端 SSE Client、工具分页发现、双提供方字段映射、超时保护以及 PNG/JPEG/WebP 结果解析。
- 已实现 `/api/mcp/tools` 脱敏发现接口、设置页工具列表和生图页 Banana/Image2 切换；Banana 为默认提供方。
- `npm test`：6 个测试文件、16 条测试全部通过，包含 Banana/Image2 参数映射、Schema 缺陷兼容、未映射必填字段拒绝、标准 image/resource 解析、相对资源路径和非位图拒绝。
- `npm run build`：客户端与服务端构建通过。
- 真实契约验证：`tools/list` 成功；Banana 文生图返回 JPEG，Banana 图生图返回 JPEG，Image2 文生图返回 PNG，Image2 图生图返回 PNG。
- 图生图只上传程序生成的 256×256 测试 PNG；Image2 文生图使用代理生成的空白占位 PNG，没有读取用户个人文件。
- Gorilla Image2 把 10 个可选图片槽位错误标成必填，并且只接受上传接口返回的原始相对 `assetUrl`；适配器已限定兼容范围并完成真实验证。
- 浏览器验证：设置页显示两个已配置 MCP 提供方；生图页默认 Banana 且可切换 Image2；候选数量固定为 1。
- 生产模式验证：`/api/health`、直接 `/image` 路由和两项 MCP 配置状态通过；设置页控制台无错误。
- 凭据扫描未发现 JWT 被写入仓库。

## 决策记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-11 | MCP 仅由服务端代理调用 | 避免 H5 暴露访问令牌并保持统一网关边界 |
| 2026-07-11 | 已公开 JWT 视为失效且禁止使用 | 聊天记录不属于安全密钥存储 |
| 2026-07-11 | 首轮替换不删除现有官方适配器 | MCP 未验证前需要安全回退和差异对照 |
| 2026-07-11 | 工具契约未知时不编写猜测适配器 | 工具名和 Schema 是实现所需事实 |
| 2026-07-11 | 用户批准 `MOD-20260711-003` | 设计边界获准，但仍需取得 MCP 工具契约才能实施 |
| 2026-07-11 | 使用官方 MCP TypeScript SDK v1 `SSEClientTransport` | Gorilla Canvas 地址是旧式 SSE；官方说明 v1 仍是当前生产推荐版本 |
| 2026-07-11 | 工具发现与生成配置分离 | 允许先安全读取 Schema，再明确选择工具和字段，不靠猜测调用 |
| 2026-07-11 | 用户批准同时接入 Banana 与 Image2，并允许真实 API 测试 | 保留 MCP 集合中两种已拥有的图片能力并完成端到端验证 |
| 2026-07-11 | Image2 使用空白占位和重复资产 URL 兼容 10 个错误必填槽位 | Gorilla 工具说明图片可选，但运行时 Schema 与解析器要求十个可解码图片引用 |
| 2026-07-11 | 工具输入保留相对 assetUrl，结果下载限制为同源 HTTPS | Gorilla Image2 只接受上传接口的原始引用，同时避免任意远程抓取 |

## 待确认项

None。生产部署前仍需由 MCP 服务提供方确认长期调用授权、额度与限流规则；该运营信息不阻塞本模块技术验收。

## 提交记录

| 阶段 | Commit | 状态 |
|---|---|---|
| 设计 | `2c50477` | Approved |
| 连接框架 | `0a95b74` | Implemented |
| 双提供方与真实验证 | `ed7a39b` | Verified |
| 关闭 | 本次独立收尾提交 | Closed |

## 勘误

None
