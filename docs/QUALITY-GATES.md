# 质量门槛与复现流程

本文件描述可执行流程。本轮工作树检查和实际安装包的区别见 [当前分发前检查](RELEASE-REVIEW.md)。CI 配置存在不代表远端运行已通过；各环境证据记录在 OPTIMIZATION-LOG 和最终交付报告。

## 默认新版本发布流程

用户说“发布新版本”时，默认授权下面完整流程，无需再次逐步确认。用户指定版本时使用指定值；未指定时从当前版本递增补丁号，遇到已存在的版本或标签继续选择未使用的补丁号。用户明确指定已发布版本重新发布时，包版本保持指定值，创建首个未使用的 `<版本>-rebuild.N` annotated tag。现有标签不得移动或覆盖。

1. 核对工作区、远端分支与标签；更新 `package.json` 和锁文件根版本、中英文安装说明、当前支持文档、CI 中的包路径及更新记录，保持第三方依赖不变。
2. 完成受影响的静态检查、单元测试及集成检查，核对待提交文件。
3. 合并提交当前待发布修改，创建与版本号同名的 annotated tag（例如 `1.1.5`）；明确要求重新发布既有版本时使用上述 rebuild 标签。推送分支与新标签，核对远端分支和标签所指向的提交。
4. 执行 `npm run package` 自动归档旧包并生成标准命名的新 VSIX，执行 `npm run verify:package`，对实际安装包运行无头宿主测试；提供 VSIX 和 SHA-256 校验文件。

仅“重新生成 VSIX”保持当前版本且不隐式提交。上述默认流程不包含上传 Marketplace。远端 CI 和 Windows/macOS 等目标系统的结果必须单独确认，不能以本机 Linux 通过代替。

## 自动检查

Node 22，扩展目录执行：

```sh
npm ci
npm run check
npm run test:unit
npm run test:clangd
npm run benchmark
npm run package
npm run verify:package
npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.1.6.vsix
```

最后一项安装实际 VSIX 到临时 Profile，从安装内容加载扩展。测试代码仍位于仓库；控制器、Worker、资源和 manifest 来自安装包。Linux 使用独立 Xvfb；不修改个人扩展目录。整体宿主任务默认十分钟预算，`SOURCEINSIGHT_READER_HOST_TIMEOUT_MS` 可设置 1000～3600000ms；到期终止自身进程树并失败，保留临时日志目录。

`SOURCEINSIGHT_READER_VSCODE_VERSION=1.106.0` 或 `stable` 强制下载指定宿主；CI 对 Linux/Windows/macOS 及最低版/当前稳定版运行必选矩阵。已按用户要求删除依赖 clangd 20+ 的原生 outgoing 调用测试及对应版本门槛；本地 outgoing、incoming、方向切换与其他 clangd 测试继续保留，不再宣称已验证 clangd 原生 outgoing。Linux CI 使用 [LLVM 官方软件源](https://apt.llvm.org/) 的 clangd 22。工作流尚未推送执行时，外部平台仍待验收。

## 真实多语言服务

```sh
SOURCEINSIGHT_READER_LANGUAGE=java npm run test:host -- --headless
SOURCEINSIGHT_READER_LANGUAGE=python npm run test:host -- --headless
```

脚本在临时扩展目录安装 Red Hat Java 或 Python/Pylance，需要网络；Java 使用 JDK 21 标准模式，Python 可用 `SOURCEINSIGHT_READER_PYTHON` 指定解释器。检查真实符号、定义、预览、引用、全局符号和双向调用；提供者不就绪/缺能力会失败，不静默跳过。独立 workflow 支持手动执行，相关语言路由 PR 触发。Pylance 的分发和使用受其许可约束，测试在官方 VS Code 宿主运行；下载失败不等于产品逻辑通过。

## 准确性语料

`test/fixtures/accuracy/cases.json` 明确源码、查询偏移、期望声明位置及 known/unknown；`npm run test:accuracy` 使用真实 C WASM。设 `SOURCEINSIGHT_READER_ACCURACY_REPORT=1` 输出 `dist/accuracy-results.json`。新增 bug 必须先加独立标注场景。未知/多候选不算正确的确定跳转，统计已知位置命中与错误确定目标。

目前语料覆盖 39 个针对性场景，并分别验证内存索引与 SQLite 重开后的结果，是回归集，不足以声称真实项目准确率 99%。下一步实机应增加 Linux、嵌入式、宏密集、多根同名和跨语言项目的人工标签，记录每个查询的预期位置与当前后端。

## 故障与长期稳定性

```sh
npm run test:soak -- --seconds=4 --restart-every=50
npm run test:soak -- --seconds=28800
```

自动工具只在临时源码操作真实索引 Worker：未保存覆盖、定义、绑定引用、持久化、重启和故意损坏缓存。默认每 1000 轮重启，每 50 轮记录堆/RSS/闭包成员；`dist/soak-results.json` 记录请求时长、完成标记和失败。短跑用于验证工具，不算八小时验证。此工具不替代 UI/语言服务长时验收。

人工八小时用例 PERF-02：固定工程、版本、编译配置和机器；记录冷启动及每 15 分钟 RSS/CPU、查询 P50/P95、索引队列和错误；轮流阅读、编辑、切分支、改配置、关闭/重开窗口。出现持续增长，保留堆快照与当时操作，不能仅凭最终内存降低判通过。故障注入使用工程副本：只读缓存目录、坏缓存、Worker 崩溃、语言服务挂起、远端断连、文件删除/编码变化和数千文件变更；恢复后复核目标准确性。

## 制品与供应链

`npm run package` 构建后检查 ZIP 路径、重复/异常文件、开发目录泄漏、入口/Worker/主题/资源与相对 require、vendor SHA，生成：

- `*.vsix` 与 `*.vsix.sha256`。
- `package-validation.json`：制品身份、SHA、文件数量及许可证位置。
- `sbom.cdx.json`：CycloneDX 资产清单，vendor 文件版本/来源/哈希；运行时不安装 npm 依赖，开发依赖锁在 package-lock.json。

`npm run verify:package` 先比较已有 SHA，并核对当前工作树的关键清单、运行源码及资源；任一不符立即失败，不刷新校验回执。版本相同但源码已经变化的旧包也会被拒绝，这是分发门禁的预期行为，应重新构建候选而非改写预期摘要。当前版本为 1.1.6，可使用归档的 1.1.0 安装包执行跨版本升级及回滚验收；该流程仍需实际执行。正式发布时保存旧 VSIX 与校验值，使用干净 Profile 安装新包、恢复书签/任务、检查缓存失效，再卸载并安装旧包。删除用户存储必须另行选择，回滚不能默默清除笔记。

## 无障碍与环境

自动验证 roving focus、查询状态、协议、过期坐标和强制颜色样式；真实读屏（NVDA/VoiceOver）、高对比、200% 缩放、触控与不同字体仍执行 A11Y-01/02。远端使用 workspace 扩展宿主；虚拟文件系统不启用磁盘 C Worker，其余能力取决于文件提供者/语言服务。不信任工作区允许阅读，禁止托管项目配置；浏览器版未提供 browser 入口，不宣称支持。

相关声明依据 [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)、[虚拟工作区](https://code.visualstudio.com/api/extension-guides/virtual-workspaces) 和 [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)。
