---
id: MOD-20260710-002
title: 源图准备与图生序列帧流程
type: major
status: Approved
created: 2026-07-10
updated: 2026-07-11
timezone: Asia/Hong_Kong
affected_modules:
  - SOURCE_IMAGE
  - GENERATION
  - AI_GATEWAY
  - PROJECT
  - STORAGE
  - APP
  - CORE
  - FRAME_WORKSPACE
approval:
  state: approved
  approved_by: user
  approved_at: 2026-07-11
related_commits: []
supersedes: []
---

# 源图准备与图生序列帧流程

## 目标

- 在图生序列帧之前增加可选的“源图准备”阶段。
- 支持通过文生图生成源图。
- 支持通过图生图加工用户上传的参考图并生成源图。
- 支持用户跳过源图生成，直接上传本地图片进入图生序列帧。
- 让序列帧生成只依赖统一的源图资产，不感知源图产生方式。
- 为图生序列帧提供游戏工程化预设，区分角色序列帧和场景序列帧。
- 将预设底词、用户描述和结构化动画参数组合为可追溯的生成请求。

## 非目标

- 不在本模块中实现专业图片编辑器、图层、蒙版或局部重绘。
- 不在首期支持多张源图同时驱动一组序列帧。
- 不把文生图、图生图或序列帧生成绑定到单一 AI 服务商。
- 不改变帧工作区的删除、排序、局部重试和导出职责。
- 不在用户确认前自动把新生成图片覆盖为当前序列帧源图。

## 判级理由

本变更新增顶层用户能力、可跳过的流程分支、统一源图领域对象和 AI Gateway 能力，并改变生成任务的必需输入与核心用户路径，属于大模块。

## 影响模块

- `SOURCE_IMAGE`：新增，负责文生图、图生图、本地上传和源图确认。
- `GENERATION`：从泛化的序列帧生成明确为“使用已确认源图生成序列帧”。
- `AI_GATEWAY`：需要区分源图生成能力和序列帧生成能力。
- `PROJECT`：保存当前源图引用和来源信息。
- `STORAGE`：持久化源图元数据、本地引用和恢复信息。
- `APP`：增加可选源图步骤和跳过路径的页面编排。
- `CORE`：新增统一 `SourceImageAsset` 概念及生成任务输入约束。
- `FRAME_WORKSPACE`：使用任务保存的帧率、循环方式和锚点信息进行预览与后续导出。

## 当前行为

- 当前 MVP 文档从“填写提示词、参考素材和序列参数”直接进入序列帧生成。
- `AI_GATEWAY` 只笼统描述单帧或序列帧生成，没有明确区分源图生成与序列帧生成。
- `GENERATION` 没有规定序列任务必须消费一个已确认的统一源图资产。
- 项目模型没有明确记录源图来自文生图、图生图还是本地上传。

## 目标行为

MVP 使用两阶段主流程：

```text
第一阶段：源图准备（可跳过 AI 生成）

  文生图：文字提示词 ───────────┐
                               ├→ 预览并确认 SourceImageAsset
  图生图：本地参考图 + 修改描述 ─┤
                               │
  直接上传：本地图片 ───────────┘（跳过源图生成 API）

第二阶段：图生序列帧

  已确认 SourceImageAsset + 序列帧预设 + 用户描述 + 序列参数
    → 提交序列帧任务
    → 查询进度
    → 获得有序帧集合
    → 帧工作区
    → 导出
```

### 文生图路径

1. 用户选择“文生图”。
2. 输入画面提示词及源图规格。
3. 系统通过 `AI_GATEWAY` 提交源图生成任务。
4. 用户预览结果，可以重新生成或确认当前结果。
5. 只有确认后的结果才能进入图生序列帧。

### 图生图路径

1. 用户选择“图生图”。
2. 上传一张本地参考图，并输入希望生成或调整的描述。
3. 系统校验图片后，通过 `AI_GATEWAY` 提交图生图任务。
4. 用户预览结果，可以重新生成或确认当前结果。
5. 原始上传图保留为来源引用，确认结果成为序列帧源图。

### 直接上传路径

1. 用户选择“上传本地图片直接生成序列帧”。
2. 系统只执行本地图片格式、尺寸、容量和可读取性校验，不调用源图生成 API。
3. 校验通过后，将上传图片规范化为 `SourceImageAsset`。
4. 用户确认后直接进入图生序列帧参数配置。

### 返回和替换

- 用户在提交序列帧任务前可以返回并替换源图。
- 序列帧任务提交后，更换源图必须创建新的序列帧任务，不能修改已提交任务的输入。
- 替换源图不得覆盖历史任务使用的源图引用。

## 接口与数据流

### 统一源图对象

`SourceImageAsset` 至少表达：

- 稳定的内部资产 ID。
- 来源类型：`text_to_image`、`image_to_image`、`local_upload`。
- 当前可读取的图片资源引用。
- MIME 类型、宽度、高度和文件大小。
- 创建时间和用户确认时间。
- 文生图提示词或图生图修改描述（适用时）。
- 原始参考图引用（图生图适用时）。
- 服务商及外部任务引用（AI 生成适用时）。
- 本地持久化状态和资源是否仍然可用。

禁止把 API 密钥、完整鉴权信息或服务商私有请求对象写入 `SourceImageAsset`。

### AI Gateway 能力

统一网关需要表达三个互相独立的能力：

```text
generateImageFromText(request) → SourceImageJob
generateImageFromImage(request) → SourceImageJob
generateSequenceFromImage(request) → SequenceGenerationJob
```

- 服务商适配器必须声明实际支持的能力。
- 页面和功能模块不能根据服务商名称拼接专有请求。
- 如果选定服务商缺少当前路径所需能力，界面应在提交前阻止操作并解释原因。
- 本地直接上传不调用前两个网关能力，只在序列生成时调用第三个能力。

### 序列生成输入

图生序列帧任务至少接收：

- 一个已经确认且仍可读取的 `SourceImageAsset`。
- 一个带版本的 `SequencePreset`。
- 用户的动作或场景运动描述。
- 帧数、帧率、循环方式、画面尺寸或宽高比。
- 锚点、对齐、连续性、风格和随机种子等统一参数。
- 与核心字段隔离的服务商扩展参数。

`GENERATION` 保存提交时使用的源图资产 ID、预设 ID、预设版本、最终有效参数和编译后的提示词快照，确保之后替换源图或升级预设不会改变历史任务。

### 序列帧类型

MVP 提供两种一级类型：

#### 角色序列帧 `character`

用于单个游戏角色的动作动画。MVP 提供三种动作预设：

- `idle`：待机循环，强调轻微呼吸或重心变化、固定站位以及首尾连续。
- `attack`：单次攻击，强调准备、出招、命中表现和收招阶段，默认不循环。
- `other`：其他动作，由用户描述具体动作，并明确选择循环或单次播放。

角色序列帧默认使用底部中心锚点，角色脚底保持在同一基线，身体比例、画布位置、镜头、朝向和缩放保持稳定。预设必须避免角色被裁切、重复角色、肢体数量漂移和背景干扰动作识别。

#### 场景序列帧 `scene`

用于水面、火焰、云层、光照、植被等环境动画。场景预设强调固定镜头、固定构图、固定画布和局部元素运动，默认生成无镜头抖动的循环动画。用户可以将循环方式改为单次播放。

场景预设不使用角色脚底锚点，而使用完整画布对齐；除用户描述的动态元素外，其他构图元素应保持稳定。

### 初始预设参数

以下值作为服务商选型前的 MVP 产品默认值。适配器遇到服务商不支持的帧数或帧率时，必须映射到最接近的支持值，并在提交前向用户展示最终有效参数。

| 预设 ID | 类型 | 动作 | 默认帧数 | 默认帧率 | 默认循环 | 对齐方式 |
|---|---|---|---:|---:|---|---|
| `character.idle.v1` | 角色 | 待机 | 8 | 8 FPS | 是 | 底部中心、脚底基线固定 |
| `character.attack.v1` | 角色 | 攻击 | 8 | 12 FPS | 否 | 底部中心、脚底基线固定 |
| `character.other.v1` | 角色 | 其他 | 12 | 12 FPS | 用户选择 | 底部中心、脚底基线固定 |
| `scene.default.v1` | 场景 | 通用场景动态 | 12 | 8 FPS | 是 | 完整画布、镜头固定 |

帧率是播放和导出元数据，不能只依赖提示词表达。帧数、帧率、循环方式、锚点、画布和顺序必须作为结构化字段保存。

### 预设提示词合成

最终提示词按固定层级构建：

```text
公共游戏工程底词
  + 类型底词（角色 / 场景）
  + 动作底词（待机 / 攻击 / 其他；场景无动作子类）
  + 用户描述提示词
  + 公共负向约束
```

优先级规则：

- 结构化工程参数高于提示词文本，是任务和导出的事实源。
- 公共底词保证游戏资产可用性，用户描述不能覆盖固定画布、稳定对齐、单一主体等硬约束。
- 用户描述只补充角色动作、场景运动、情绪、节奏和视觉意图。
- 服务商适配器可以转换语法，但不能改变预设语义或丢失结构化参数。
- MVP 可以向用户展示选中的预设和有效参数，但不直接开放公共底词编辑。

#### 公共游戏工程底词 `game.sequence.common.v1`

```text
Game-ready ordered animation frames. Preserve the source image identity, art style,
proportions, colors and lighting. Keep a fixed camera, fixed canvas size, consistent
scale and stable alignment across every frame. Produce clear temporal progression
with no composition drift. Keep every frame suitable for deterministic playback in
a game animation timeline.
```

#### 角色类型底词 `game.sequence.character.v1`

```text
A single full-body game character. Keep the character centered on a stable
bottom-center anchor with both feet aligned to the same baseline whenever the pose
allows. Preserve facing direction, silhouette, anatomy, costume and equipment.
Keep the entire character inside the canvas in every frame.
```

#### 待机动作底词 `game.sequence.character.idle.v1`

```text
Create a seamless idle animation cycle with subtle breathing, weight shift or small
secondary motion. Keep root displacement minimal. The final frame must transition
naturally back to the first frame without a visible jump.
```

#### 攻击动作底词 `game.sequence.character.attack.v1`

```text
Create one readable attack action with clear anticipation, strike and recovery
phases. Preserve a strong silhouette and stable root alignment. Finish in a usable
recovery pose. Do not turn the action into a looping idle animation.
```

#### 其他动作底词 `game.sequence.character.other.v1`

```text
Perform the user-described action with a readable motion arc, stable identity and
consistent alignment. Respect the selected loop mode. If looping is enabled, connect
the final frame naturally to the first frame.
```

#### 场景类型底词 `game.sequence.scene.v1`

```text
Create a game-ready environmental animation with a completely fixed camera and
stable full-frame composition. Animate only the elements described by the user;
keep all other scene geometry, perspective and lighting placement consistent. When
looping is enabled, make the final frame transition seamlessly to the first frame.
```

#### 公共负向约束 `game.sequence.negative.v1`

```text
No camera shake, zoom, pan, crop, composition drift, scale drift, alignment drift,
identity change, style change, duplicated subject, extra character, missing limb,
extra limb, random background change, inconsistent frame size, text, watermark or
unordered motion.
```

底词 ID 与版本必须保存在生成任务中。修改底词内容时创建新版本，不能静默改写历史版本。

## 失败场景

- 文生图或图生图鉴权失败、限流、超时或被内容安全策略拒绝。
- 用户上传的图片无法读取、格式不支持、尺寸或容量超过限制。
- AI 返回的源图地址已过期，确认或序列提交时无法读取。
- 用户选择的服务商支持文生图但不支持图生序列帧，或反之。
- 用户尚未确认源图就尝试提交序列任务。
- 序列任务提交后用户更换当前源图，导致历史任务与项目当前状态不一致。
- 页面刷新后只能恢复元数据，无法恢复浏览器临时图片资源。
- 图生图失败时错误地覆盖用户原始上传图片。
- 用户描述与工程底词冲突，导致对齐、构图或单一主体约束被覆盖。
- 服务商不支持预设帧数或帧率，却没有展示实际采用的有效参数。
- 预设内容升级后无法复现历史任务使用的提示词和参数。
- 待机循环首尾跳变、攻击动作被错误循环、场景出现镜头漂移。

处理原则：源图生成失败不创建序列任务；源图校验失败不进入第二阶段；历史任务始终保留提交时源图快照；所有可恢复错误提供明确的重试入口。

## 安全和性能影响

- **安全**：本地图片只在用户明确提交时发送给所选 AI 服务；界面必须说明上传目标。图片元数据和日志不得包含密钥或完整签名 URL。
- **隐私**：项目需要区分仅存在浏览器内的图片、发送到外部服务的图片和已缓存资源。
- **性能**：上传前应执行尺寸与容量校验；大图规范化策略在技术栈和服务商选型时确定，不能静默降低质量。帧数和帧率调整需要在提交前显示对生成耗时和输出体积的影响。
- **成本**：文生图、图生图和图生序列帧是独立计费动作，重新生成前应明确提示会产生新的请求。

## 实施步骤

1. 批准本文档并独立提交设计基线。
2. 更新 `docs/PROJECT.md`、`README.md` 和 `docs/ROADMAP.md`，统一 MVP 两阶段流程。
3. 更新 `docs/ARCHITECTURE.md` 和 `docs/AI_API.md`，加入 `SourceImageAsset` 与三类网关能力。
4. 更新 `MODULE_INDEX.md`，正式登记 `SOURCE_IMAGE` 并收敛受影响模块边界。
5. 定义 `SequencePreset`、提示词分层、预设版本和结构化动画参数契约。
6. 在技术栈确定后实现源图准备界面、统一领域对象、存储契约和 AI Gateway 契约。
7. 实现文生图、图生图和本地直接上传三条路径。
8. 实现角色/场景类型、角色动作预设和图生序列帧输入约束。
9. 执行验收测试并关闭模块文档。

## 验收标准

- [ ] 用户可以用文字生成源图，确认后进入序列帧生成。
- [ ] 用户可以上传参考图并通过图生图生成源图，确认后进入序列帧生成。
- [ ] 用户可以跳过源图生成，直接上传本地图片进入序列帧生成。
- [ ] 三条路径输出同一种 `SourceImageAsset`，序列模块不依赖来源类型分支。
- [ ] 未确认或不可读取的源图不能提交序列任务。
- [ ] 序列任务保存不可变源图输入快照，更换当前源图不影响历史任务。
- [ ] 服务商能力不足时在提交前给出明确提示。
- [ ] 本地图片发送给外部 AI 前有明确用户动作。
- [ ] 产品、架构、AI API 和模块索引对 MVP 流程的描述一致。
- [ ] 用户必须在角色序列帧和场景序列帧之间选择一种类型。
- [ ] 角色序列帧支持待机、攻击和其他三种动作预设。
- [ ] 每种预设都有带版本的工程底词、默认参数和负向约束。
- [ ] 帧数、帧率、循环方式、锚点和画布作为结构化字段保存，不只存在于提示词。
- [ ] 用户描述与预设底词分层合成，不能覆盖固定画布和稳定对齐等硬约束。
- [ ] 每个任务保存预设 ID、版本、编译提示词和最终有效参数，能够复现历史请求。

## 测试方案

- [ ] 文生图成功、失败、重试和确认流程。
- [ ] 图生图成功、失败、重试、原图保留和结果确认流程。
- [ ] 本地上传成功以及格式、容量、尺寸、损坏文件校验。
- [ ] 三条路径进入序列任务后的输入结构一致性。
- [ ] 未确认源图、过期资源和服务商能力缺失时的阻止行为。
- [ ] 序列任务提交后替换项目当前源图，历史任务仍引用原输入。
- [ ] 页面刷新后的源图元数据和本地资源恢复行为。
- [ ] API 密钥、签名 URL 和用户图片隐私信息不进入普通日志。
- [ ] 角色待机预设的循环、底部中心锚点和脚底基线约束。
- [ ] 角色攻击预设的准备、出招、收招阶段和非循环默认值。
- [ ] 角色其他动作的用户描述和循环方式选择。
- [ ] 场景预设的固定镜头、完整画布和默认循环约束。
- [ ] 用户描述尝试覆盖硬约束时仍保留工程参数。
- [ ] 服务商参数映射后向用户展示最终帧数和帧率。
- [ ] 升级预设版本后，历史任务仍保留旧版本快照。

## 验证结果

尚未验证。

## 决策记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-10 | 源图准备是可选的第一阶段 | 允许用户直接使用已有本地图片 |
| 2026-07-10 | 三条入口统一输出 `SourceImageAsset` | 隔离来源差异，简化序列生成模块 |
| 2026-07-10 | 图生序列帧只接受已确认源图 | 避免未完成结果或临时资源进入计费任务 |
| 2026-07-10 | 更换源图创建新的序列任务 | 保持历史任务输入可追溯且不可变 |
| 2026-07-10 | 三类 AI 能力分别声明 | 允许不同服务商能力组合，不假设单一厂商全部支持 |
| 2026-07-11 | 序列帧分为角色和场景两种一级类型 | 两类资产的对齐、镜头和运动约束不同 |
| 2026-07-11 | 角色首期提供待机、攻击、其他三种动作预设 | 覆盖明确需求，同时控制 MVP 分类规模 |
| 2026-07-11 | 工程约束同时使用结构化字段和版本化底词 | 提示词不能可靠承担帧率、锚点和导出元数据 |
| 2026-07-11 | 用户描述不能覆盖硬工程约束 | 确保生成结果适合游戏时间线和后续导出 |
| 2026-07-11 | 预设映射后的有效参数必须提交前展示 | 避免服务商限制导致静默改变结果 |
| 2026-07-11 | 用户批准 `MOD-20260710-002` | 源图准备、序列类型、动作预设和初始默认参数成为正式产品设计基线 |

## 待确认项

- 文生图和图生图首期每次只展示一个结果，还是允许服务商返回多个候选供用户选择。
- 图生图的“修改描述”在首期是否必须填写。
- MVP 首期接受的本地图片格式、最大容量和最大尺寸将在技术栈与首个服务商确定后固化。
- 初始帧数和帧率是否采用本文档的 8/8、8/12、12/12、12/8 默认组合。
- 角色背景模式（透明、纯色或保留源图背景）是否进入 MVP 结构化参数。

## 提交记录

| 阶段 | Commit | 状态 |
|---|---|---|
| 设计 | 本次独立设计提交 | Approved |
| 实施 | Pending | Pending |
| 关闭 | Pending | Pending |

## 勘误

None
