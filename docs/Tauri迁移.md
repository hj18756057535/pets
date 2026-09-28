# Tauri 迁移说明

当前默认启动和打包方式已切换至 Tauri 2 + Rust。原有 HTML/CSS/JavaScript 页面由 `tools/prepare-tauri.cjs` 复制到 `dist-tauri/`，只注入 `ui/tauri-bridge.js`。Rust 后端负责窗口、托盘、快捷键、数据存储、会议和护眼提醒、宠物 ZIP 与分享链接导入。Electron 运行入口、打包脚本和开发依赖已移除。`src/` 中保留的纯 JavaScript 工具模块用于命令行宠物导入和迁移兼容回归，不是应用运行后端。

## 构建

需要 Rust/Cargo、Microsoft C++ Build Tools 和 Windows SDK、Node.js 22。安装后在项目根目录执行：

```powershell
npm.cmd ci --cache .npm-cache
npm.cmd start
npm.cmd run package
```

`package`（同 `tauri:package`）同时生成 NSIS 安装包、便携 ZIP 和各自的 SHA-256；`tauri:build` 只生成 NSIS 安装包。Tauri 使用系统 WebView2；Windows 11 通常已提供，缺失时安装包会下载引导程序。便携 ZIP 本身不会安装 WebView2。Tauri 官方通知插件在 Windows 上要求已安装的应用，因此需要系统通知时应使用安装包；便携版的应用内提醒仍由 Rust 后端运行。

## 数据与升级

开发版仍使用仓库的 `.data/`。Tauri 便携版优先使用 EXE 同目录的 `.data/`，因此从 Electron 便携版升级时，先完全退出旧版，再将原 `.data/` 复制到新版 EXE 同目录。安装在不可写目录时使用 Windows 用户应用数据目录；安装版迁移旧便携数据需手动复制。数据格式保持 `state.json`、`state.json.bak`、`selected-pet.json` 和 `pet-import-*` 目录兼容。

## 验证与待验收

2026-09-24 已在 Windows MSVC 环境完成 Rust release 编译、NSIS 和便携 ZIP 打包，36 项 JavaScript 测试、5 项 Rust 测试及真实 Tauri 页面操作回归通过。启动/设置/展开时的数据锁与窗口同步查询死锁已修复；`npm run smoke -- --launcher` 可验证实际启动入口。便携 ZIP 约 2.20 MiB；先前 Electron ZIP 约 151.01 MiB。仍需在日常使用场景验证：

1. 透明区域点击穿透、宠物有效像素拖动、顶部气泡和边缘自由悬浮；覆盖混合 DPI、多屏和显示器拔插。
2. 关闭陪伴空间后后台提醒继续运行；休眠唤醒、免打扰、护眼计时、系统通知及托盘恢复。
3. 旧版 `.data/` 的提醒、设置和宠物选择可读取；ZIP、文件夹、分享链接导入及取消。
4. 便携 ZIP 和 NSIS 安装包能在干净 Windows 环境启动，并记录实际压缩体积。

当前 Rust 版本尚未实现 Windows 系统通知点击后的页面跳转，以及联网导入取消时立即终止请求；取消会使预览失效，但后台请求最多等待网络超时。通知声音开关已接入通知构建逻辑，仍需手工试听确认。启动日志位于数据目录的 `app.log`，其中 `frontend ready: panel` 和 `frontend ready: pet` 表示两个页面已完成初始化。仅有进程存活不能作为启动成功的判断依据。

桌面互动包括逗猫棒、放球取回和跟随鼠标。玩具使用独立透明窗口，只有放球选点时接收点击；其余时间点击穿透。Esc、结束互动、隐藏或换宠会退出互动，位置不会在每个动画帧写盘。拖动时保持 WebView 表面大小与画布偏移不变，结束后再调整提醒布局。

源码双击入口由 Start-PetDesk.vbs 无窗口启动 PowerShell；构建后启动 GUI 子系统的调试程序并立即退出，不再等待应用关闭。真实启动回归同时检查 launcher.pid 对应进程已退出。

系统内存面板读取 Windows 物理内存信息，进程统计与工作集整理限于 PetDesk 和其 WebView 子进程。源码启动器比较构建输入与 EXE 时间，未变化时跳过 Node/Cargo；需要强制重建时可向 Start-PetDesk.ps1 传入 -Rebuild。
