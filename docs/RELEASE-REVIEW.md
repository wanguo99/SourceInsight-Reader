# 1.1.5 发布检查

检查日期：2026-10-29。本次从1.1.4升级至1.1.5，发布Context直接索引操作和工程导入子项排除优化；第三方依赖不变，保留历史标签与安装包。

## 发布范围

- Context底部提供开始索引和刷新索引，均使用已保存的模式、目录 / 文件范围、编译数据库及路径映射，不打开配置页。刷新重新读取编译清单并复用有效缓存；处理中禁用按钮，失败后允许重试。
- 保留原有任意目录及文件的添加方式，已选目录中的子目录和文件可单独取消、恢复，父目录显示部分选中。右侧显示排除项；保存、关闭和重开后保持一致，放弃草稿不修改已保存配置。
- 更具体的导入选择覆盖父级选择，允许恢复排除目录中的特定文件；独立屏蔽设置始终优先。文件查询、本地索引、语义结果过滤、受管clangd及缓存身份同步使用这些范围。
- 按不可变选择快照组织单文件规则，避免大量单独文件与目录混合导入时逐次扫描全部文件规则。目录仍按需展开，取消子项不枚举未展开的兄弟目录。

## 兼容与失败语义

`projectSources`在原有mode、directories、files之外支持可选的excludedDirectories和excludedFiles；旧配置无需迁移。保存同时提交导入项和排除项；配置冲突时拒绝覆盖外部修改。清空或取消父目录会清理其下例外；操作不删除源码、书签或阅读任务。无效路径和格式失败关闭，不回退全工程扫描。重开工作区仍需显式开始索引。

## 本次检查与证据

本机环境为Linux、Node.js22.23.3、npm10.9.9、VS Code1.142.0；真实宿主使用临时工作区、独立用户配置与Xvfb。Windows、macOS、远端及最低支持版本的实际结果需要分别取得，不能用本机通过替代。

| 检查 | 要求与证据 |
| --- | --- |
| `npm run check` | 通过；语法、类型、版本、清单及生成文档一致；71个命令、336项人工用例索引；`/tmp/reader-release-1.1.5-check.log` |
| `npm run test:unit` | 576通过、0失败、0跳过，覆盖子项排除 / 恢复、Shift操作、草稿、持久化、路径身份及既有功能；`/tmp/reader-release-1.1.5-unit.log` |
| `npm run test:clangd` | 真实clangd集成5通过、0失败、0跳过；`/tmp/reader-release-1.1.5-clangd.log` |
| `npm run benchmark` | 本机合成负载及预算检查通过；`dist/benchmark-results.json`，不外推为所有真实工程的性能保证 |
| `npm run package` 与 `npm run verify:package` | 核对版本、关键清单、运行源码与资源、vendor摘要和许可证；`dist/package-validation.json` |
| `npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.1.5.vsix` | 安装新包后验证真实索引、保存 / 重开、排除及恢复；`dist/host-results.json`，须为installation=vsix且completed=true |
| Git与归档 | main与标签1.1.5解析到同一发布提交；旧包和附属文件逐项核对；`dist/release-1.1.5-validation.json` |

此前同轮1.1.4候选包已通过576项单元测试和27项Linux实际安装宿主检查，SHA-256为 `f38c265f1f2d6798d75cf956f16df5a2cd4ed47b5e8bb5ca01b58800c8156a14`；该包及配套记录由本次流程归档。它不能替代本次1.1.5安装包的独立验证。

## 制品保护与交付

按[默认发布流程](QUALITY-GATES.md)，完成源码检查后合并提交、创建annotated tag并推送main和新标签，再由 `npm run package` 自动归档旧包并生成 `dist/wanguo-sourceinsight-reader-1.1.5.vsix`。不覆盖历史标签、旧包字节或旧校验记录。

新包的 `.vsix.sha256`、`package-validation.json` 和 `sbom.cdx.json` 提供摘要、源码一致性与供应链证据；实际安装检查和发布回执绑定最终制品及提交。验证旧摘要或源码不匹配时必须失败，不得改写预期摘要绕过。仅源码宿主通过不代表安装包通过。

本次交付Git分支、标签和VSIX；Marketplace上传不在默认流程中。当前支持边界和排障见[支持矩阵](SUPPORT-MATRIX.md)与[反馈说明](../SUPPORT.md)。
