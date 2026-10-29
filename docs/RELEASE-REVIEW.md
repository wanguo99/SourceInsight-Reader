# 1.1.7 发布检查

检查日期：2026-10-29。本次从 1.1.6 升级到 1.1.7，第三方依赖不变，历史标签和安装包保留。

## 发布行为

- 定义、引用、Relation 和语义缓存统一遵守导入范围，不自动放行宿主机 SDK / 系统头文件。clangd 内部依赖解析与插件提供的工程结果边界分开处理。
- 架构桥接头文件缺失时，工程内唯一宏可在 Relation 中显示明确标注的候选使用；普通定义、References 和颜色绑定仍要求确认，不把候选当成确定目标。
- 函数指针成员调用按函数着色，成员值读取保留成员分类；EXPORT_SYMBOL 参数按符号引用着色。主编辑器与 Context 共用规则，未绑定名称使用默认前景色，索引变化后重新着色。
- Context 只有一个索引按钮：未建立索引显示开始，已有索引显示刷新，处理中禁用，失败可重试。原有两个命令保留兼容，继续使用已保存配置。

## 验证范围

本机 Linux / Node.js 22 / VS Code 1.142.0。发布前执行静态检查、606 项单元测试、5 项 clangd 集成测试及现有合成性能预算检查。最近的同源码功能安装验证通过 32 项真实宿主检查；新版本号的最终 VSIX 必须在提交推送、打包之后再次安装验证。

实际内核源码专项确认 SQLite 重开后 master_xfer_atomic、master_xfer 的调用以及 EXPORT_SYMBOL(__i2c_transfer) 的分类；宏缺失桥接场景单独验证。仅覆盖相应用例，不代表所有内核配置均已验证。Windows、macOS、最低支持版本和远端 CI 需单独确认。

## 发布与证据

按默认流程合并提交待发布修改，创建 annotated tag `1.1.7`，推送 main 和标签并核对远端。随后执行 `npm run package` 和 `npm run verify:package`，对 `dist/wanguo-sourceinsight-reader-1.1.7.vsix` 运行实际安装无头宿主测试。

最终包 SHA-256、提交与标签身份、检查日志和安装结果保存到 `dist/release-1.1.7-validation.json`；历史包与回执保存在 `dist/archive/`。本次交付 Git 分支、标签和 VSIX，不包含 Marketplace 上传。
