# 质量门槛与复现流程

本文件描述可执行流程。CI 配置存在不代表远端运行已通过；各环境证据记录在 OPTIMIZATION-LOG 和最终交付报告。

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
npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.0.9.vsix
```

最后一项安装实际 VSIX 到临时 Profile，从安装内容加载扩展。测试代码仍位于仓库；控制器、Worker、资源和 manifest 来自安装包。Linux 使用独立 Xvfb；不修改个人扩展目录。整体宿主任务默认十分钟预算，`SOURCEINSIGHT_READER_HOST_TIMEOUT_MS` 可设置 1000～3600000ms；到期终止自身进程树并失败，保留临时日志目录。

`SOURCEINSIGHT_READER_VSCODE_VERSION=1.106.0` 或 `stable` 强制下载指定宿主；CI 对 Linux/Windows/macOS 及最低版/当前稳定版运行必选矩阵。`SOURCEINSIGHT_READER_REQUIRE_OUTGOING=1` 要求 clangd 20+，旧版导致门槛失败而非跳过后计全功能通过。Linux CI 使用 [LLVM 官方软件源](https://apt.llvm.org/) 的 clangd 22。工作流尚未推送执行时，外部平台仍待验收。

## 真实多语言服务

```sh
SOURCEINSIGHT_READER_LANGUAGE=java npm run test:host -- --headless
SOURCEINSIGHT_READER_LANGUAGE=python npm run test:host -- --headless
```

脚本在临时扩展目录安装 Red Hat Java 或 Python/Pylance，需要网络；Java 使用 JDK 21 标准模式，Python 可用 `SOURCEINSIGHT_READER_PYTHON` 指定解释器。检查真实符号、定义、预览、引用、全局符号和双向调用；提供者不就绪/缺能力会失败，不静默跳过。独立 workflow 支持手动执行，相关语言路由 PR 触发。Pylance 的分发和使用受其许可约束，测试在官方 VS Code 宿主运行；下载失败不等于产品逻辑通过。

## 准确性语料

`test/fixtures/accuracy/cases.json` 明确源码、查询偏移、期望声明位置及 known/unknown；`npm run test:accuracy` 使用真实 C WASM。设 `SOURCEINSIGHT_READER_ACCURACY_REPORT=1` 输出 `dist/accuracy-results.json`。新增 bug 必须先加独立标注场景。未知/多候选不算正确的确定跳转，统计已知位置命中与错误确定目标。

目前语料覆盖 18 个针对性场景，是回归集，不足以声称真实项目准确率 99%。下一步实机应增加 Linux、嵌入式、宏密集、多根同名和跨语言项目的人工标签，记录每个查询的预期位置与当前后端。

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

`npm run verify:package` 先比较已有 SHA；不匹配立即失败，不覆盖预期值。版本仍 1.0.9，因此无法以同版本重装替代跨版本升级验收。正式发布时保存旧 VSIX 与校验值，使用干净 Profile 安装新包、恢复书签/任务、检查缓存失效，再卸载并安装旧包。删除用户存储必须另行选择，回滚不能默默清除笔记。

## 无障碍与环境

自动验证 roving focus、查询状态、协议、过期坐标和强制颜色样式；真实读屏（NVDA/VoiceOver）、高对比、200% 缩放、触控与不同字体仍执行 A11Y-01/02。远端使用 workspace 扩展宿主；虚拟文件系统不启用磁盘 C Worker，其余能力取决于文件提供者/语言服务。不信任工作区允许阅读，禁止托管项目配置；浏览器版未提供 browser 入口，不宣称支持。

相关声明依据 [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)、[虚拟工作区](https://code.visualstudio.com/api/extension-guides/virtual-workspaces) 和 [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)。
