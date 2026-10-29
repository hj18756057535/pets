# PetDesk 的 AI 协作开发

创建日期：2026-10-27；更新日期：2026-10-27。

本项目从 `D:\ai-develop\ai-dev-kit` 选择接入适合本地小工具的能力。项目规则入口是 [AGENTS.md](../AGENTS.md)，技能保存在 `.agents/skills/`，随项目提交。接入针对开发协作，不改变应用技术栈和运行方式。

## 接入的能力

| 能力 | Skill | 在 PetDesk 中的用途 |
|---|---|---|
| 开发协作主流程 | [aidev-manage-development](../.agents/skills/aidev-manage-development/SKILL.md) | 判断小改或新功能，维护必要计划，衔接实现和验证 |
| 复用与简化 | [aidev-keep-changes-simple](../.agents/skills/aidev-keep-changes-simple/SKILL.md) | 控制依赖、分层、配置与文档数量，复用现有模块 |
| 需求澄清 | [aidev-define-product-requirements](../.agents/skills/aidev-define-product-requirements/SKILL.md) | 需要时明确入口、规则、范围和可观察验收条件 |
| 交互设计 | [aidev-design-interaction](../.agents/skills/aidev-design-interaction/SKILL.md) | 梳理桌面窗口、提醒和脱敏操作的状态与反馈 |
| 变更审查 | [aidev-review-changes](../.agents/skills/aidev-review-changes/SKILL.md) | 按实际 diff 检查行为、数据边界、回归和测试证据 |

技能按需选用。普通开发不用显式写 Skill 名称，也不用依次执行全部能力。较大任务可以用 `$aidev-manage-development` 指定入口；只要求审查时直接用 `$aidev-review-changes`。

## 本次未引入的部分

| Kit 能力或配套 | 当前不引入的原因 |
|---|---|
| Java 后端、Vue 前端 | 当前运行栈是 Rust/Tauri 和原生界面 |
| 服务端 API 契约、OpenAPI 消费 | 当前使用进程内 Tauri IPC；相关约束由现有桥接、Rust 分派与测试承载 |
| 数据库结构演进、数据访问优化 | 当前使用本地 JSON 和文件，不需要数据库与迁移流程 |
| Figma 还原、前端国际化 | 尚无本次必须解决的设计稿接入或多语言需求 |
| 全量初始化脚本、Kit 自身测试、Claude 适配 | 本项目只选择技能和规则；已有构建、测试及启动入口，当前使用 Codex |
| 默认每周反馈整理 | 保留轻量日志，有重复问题或明确需要时再汇总 |

后续有具体需求时再评估相应能力，不提前增加依赖、占位文档或集成配置。来源 Kit 当前同样支持小改直接处理；本次沿用这一点，没有增加任务生成器、审批台账或后台任务。

## 对通用技能做的适配

- 主流程的能力路由只列已安装的五个 Skill；工程实现转到项目规则及真实 Rust/Tauri、原生界面代码。
- 需求、交互、审查中的工程指引使用项目规则，移除对未安装 Java、Vue、API 和 Figma Skill 的依赖。
- 保留三份按需文档模板及反馈格式；短任务不生成模板。协作日志只记实质结论，有重复问题或用户要求时再整理，不默认写周报或安装定时任务。
- 项目事实与数据边界放在 `AGENTS.md` 和现有功能文档，方便后续比较通用 Skill 的更新。没有修改来源 Kit。

## 当前产品架构与修改入口

| 范围 | 真实入口 | 修改时需要守住的边界 |
|---|---|---|
| 桌宠、托盘、窗口与调度 | `src-tauri/src/main.rs` | Rust 主进程负责后台行为；界面关闭不等于退出应用 |
| 状态、会议和陪伴规则 | `model.rs`、`companion.rs` | 兼容旧本地状态、原子保存、损坏备份恢复；提醒不能依赖面板是否打开 |
| 多宠、互动与资源 | `multi_pet.rs`、`interaction.rs`、`pets.rs`、`memory.rs` | 最多三只宠物，各自拖动与保存位置；共享资源，按需创建窗口，显隐同步内存策略 |
| 原生界面与 IPC | `ui/`、`ui/tauri-bridge.js`、`src-tauri/capabilities/` | Rust 检查命令来源和参数；玩具、伙伴与主面板的操作权限有区别 |
| 本地脱敏独立模式 | `maskdesk.rs`、`masking.rs`、`pii.rs`、`recovery.rs`、`mask_documents.rs`、`keyword_library.rs` | `PetDesk.exe --maskdesk` 独立进程和会话；本地处理、预览快照、新文件导出、显式保存规则/加密映射 |
| 开发工具与兼容回归 | `tools/`、`src/`、`test/` | `src/` 的 JS 模块不是当前应用后端，修改行为时同时确认相关兼容测试 |
| 界面准备与打包 | `tools/prepare-tauri.cjs`、`tools/package-tauri.cjs` | `ui/`、`assets/` 生成 `dist-tauri/`，后者不手改；打包不携带个人数据和宠物 |

桌宠模式与脱敏模式复用同一份可执行文件。脱敏入口在主程序初始化桌宠前分流，由另一个进程运行，不启动桌宠提醒循环或常驻窗口。保留这种隔离即可满足当前小工具场景，无需为接入开发框架重新拆分应用。

详细行为继续以现有文档及实现为依据：

- [README](../README.md)：当前使用方式、数据文件和功能边界。
- [Tauri 迁移](Tauri迁移.md)：运行栈、构建和数据兼容。
- [脱敏工具实施计划](脱敏工具实施计划.md)：文件限制、预览与导出、映射及规则持久化。
- [内存优化记录](内存优化记录.md)：多宠共享、窗口生命周期和资源测量口径。
- [发布指南](发布指南.md)：便携包、安装包、校验与发布步骤。

历史文档中的验证结果只说明对应轮次，不代表当前代码已经重新验证。

## 日常怎么使用

小改和 Bug 直接说明现象、期望和限制。AI 查原文档及代码，修改相关实现，运行相称检查；结果写入回复或已有计划，不创建整套流程文件。

新功能或较大行为变化先展示范围、最小方案和可验证切片。需要持续跟踪时，在对应功能目录维护一份计划；需求和设计有实际内容再写，并互相引用。已有文档保持原位置。已实现行为发生新变化时记录前后差异，Bug 修复继续遵循原需求。

例如：

```text
使用 $aidev-manage-development，先查现有实现，按这个需求给出适合本地小工具的最小方案并完成开发。
复用现有 Rust/Tauri 和界面，只做代码检查与相关单元测试，列出待人工验证项。
```

有实质结论时记入 `docs/feedback/YYYY-MM-DD.md`，类型与格式见 [反馈规则](../.agents/skills/aidev-manage-development/references/feedback-review.md)。日志不替代功能文档，也不保存原始客户资料、凭证或恢复映射。

## 验证按影响选择

| 改动 | 验证入口与证据 |
|---|---|
| 项目规则、Skill、文档 | UTF-8、Skill 结构和元数据、已安装能力引用、本地链接、`git diff --check` |
| 纯 JavaScript 工具或协议 | `node --test test/*.test.cjs`，或选择相关测试文件 |
| Rust 业务或本地数据逻辑 | 先 `npm.cmd run tauri:prepare`，再 `cargo test --manifest-path src-tauri/Cargo.toml --locked`；按需过滤具体测试 |
| 跨界面和后端行为 | `npm.cmd test` 执行准备、JS 与 Rust 测试；真实窗口结果仍需另行验证 |
| 用户明确要求真实窗口验证 | `npm.cmd run smoke` 或 `npm.cmd run smoke:maskdesk`，使用隔离数据 |
| 用户要求分发包 | `npm.cmd run package`，按发布指南检查产物与 SHA-256 |

默认不自动操作页面、截图或启动真实窗口验收。单元测试、真实集成、打包和人工使用分别记录；只有实际执行且得到证据的项目才写通过。本轮接入没有修改业务代码，不要求重跑应用构建或真实窗口回归。

以后吸收 Kit 更新时，比较选定技能、项目适配和根规则，只更新实际需要的部分。`.agents/skills/` 是本项目的规范源；本机环境可按需写入被 Git 忽略的 `AGENTS.local.md`，不固定个人工具路径到通用技能中。
