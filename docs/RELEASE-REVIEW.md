# 1.1.4 发布检查

检查日期：2026-10-29。本次从 1.1.3 升级至 1.1.4，合并阅读数据保护、缓存降级、安装包校验与使用说明修改；第三方依赖不变。Git 标签使用 `1.1.4`，历史标签及归档安装包保留。

## 本次范围与交付

本轮修复了四个已复现的问题。源码自动回归和 Linux 真实 VS Code 宿主检查覆盖当前修改；Windows、macOS、远端和最低支持版的实际结果仍需在对应环境取得。本地通过不能代替这些环境的验收。

按用户约定，新版本先更新版本和文档、完成源码检查、提交并创建标签、推送分支与标签，再生成发布包。最终安装包为 `dist/wanguo-sourceinsight-reader-1.1.4.vsix`；SHA-256、运行文件一致性与供应链清单分别见同目录的 `.vsix.sha256`、`package-validation.json` 和 `sbom.cdx.json`。实际安装验证以 `host-results.json` 中 `installation=vsix`、`completed=true` 及具体结果为准。发布回执 `release-1.1.4-validation.json` 绑定提交、标签、制品摘要、旧包归档及测试结果。

## 已复现并修复的问题

| 优先级 | 问题与影响 | 修复和回归 |
| --- | --- | --- |
| P1 | 书签管理窗口使用打开时的旧列表；其间新增书签后，编辑或删除旧书签会覆盖新增数据。并发保存也可能丢项 | 同一扩展宿主内按数据类别串行更新，提交时重读最新集合；同一书签已变化或删除则明确拒绝旧编辑，避免覆盖更新的笔记。存储失败后允许后续重试；损坏数据保留到用户明确确认清除 |
| P1 | 保存阅读任务时，先等待名称输入，再用旧光标坐标读取已变化的源码，可能保存到错误位置 | 在提示名称前捕获主位置、预览、关系和检索选项；用内容锚点恢复修改后的正确行 |
| P2 | 手动配置无效缓存路径时，可选的语义快照缓存会抛错，干扰原本可用的符号回退 | 缓存路径无效时跳过持久缓存并保留实时查询；相同错误限重复输出，修正配置后无需重载即可恢复缓存描述 |
| P1 | VSIX 只校验版本和已有摘要，无法发现同版本旧包遗漏当前源码修复 | 比较发布者、入口、引擎、命令 / 配置等关键清单，以及 `src/media/shared/themes/vendor` 和本地化运行资源；拒绝内容不符、遗漏文件及残留模块。失败发生在刷新校验回执之前 |

新增回归：`reader-data-safety.test.js`、`semantic-cache-safety.test.js`、`package-runtime.test.js`。已有回归保留；书签并发保证针对同一扩展宿主，不宣称实现跨进程工作区存储事务。

## 验证范围

环境：Linux、Node.js 22.23.3、npm 10.9.9、VS Code 1.142.0；使用独立临时用户配置、临时工程和 Xvfb，不修改个人 VS Code 配置。

| 检查 | 本次要求 / 证据 |
| --- | --- |
| `npm run check` | 通过；71个命令、334项用例索引及语法、类型、清单、生成文档一致；`/tmp/reader-release-1.1.4-check.log` |
| `npm run test:unit` | 564通过、0失败、0跳过，包含新增阅读数据、缓存和安装包一致性回归；`/tmp/reader-release-1.1.4-unit.log` |
| `npm run test:clangd` | 真实clangd集成5通过、0失败、0跳过；`/tmp/reader-release-1.1.4-clangd.log` |
| `npm run package` 与 `npm run verify:package` | 核对版本、关键清单、运行源码、资源、vendor 摘要及许可证；`dist/package-validation.json` |
| `npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.1.4.vsix` | 安装新 VSIX 后执行宿主功能检查；`dist/host-results.json` |
| Git 与旧包保护 | 远端 main 和标签解析到同一发布提交；归档文件逐项校验；`dist/release-1.1.4-validation.json` |

此前同轮 1.1.3 工作树预验收的 564 项单元测试、5 项 clangd 和实际安装包的 25 项 Linux 宿主检查已通过。该记录不能替代本次 1.1.4 包的独立校验。

性能与故障短测沿用本轮相同运行源码的预验收：1千 / 2千 / 1万文件合成包含闭包未超32768项预算，10万行预览末40行472ms、事件循环P95约11ms，3.3MB后台检索119ms；6秒故障短测149轮、15次Worker重启、0失败。证据为 `dist/benchmark-results.json` 和 `dist/soak-results.json`。这些本机合成结果不能外推为真实工程响应时延；短测使用JSON缓存兼容路径，不替代生产SQLite的八小时验证或公开Beta用户任务。

## 安装包保护与验收边界

使用 `npm run package` 先归档 dist 根目录已有 VSIX、校验文件与供应链清单，再生成新包。归档的 `manifest.json` 和实际文件必须与归档前 SHA-256 一致；不覆盖历史字节。版本或运行源码不一致时必须构建新候选，不得改写旧包预期摘要或跳过比较。

同轮供Windows验证的1.1.3包SHA-256为 `ec787985e0f44ee242e03db67952fe97ee2ea7de3045fa9d04c7a4745c46034c`；它由本次流程归档。更早不含本轮修复的1.1.3包 `a56ca4cf…` 已在上一轮归档并被一致性门禁拒绝。版本1.1.4只以新制品及新校验文件识别。

本次提供Git分支、标签和VSIX，不上传Marketplace。当前支持边界与排障见[支持矩阵](SUPPORT-MATRIX.md)和[反馈说明](../SUPPORT.md)；后续默认发布流程见[质量门槛](QUALITY-GATES.md)。
