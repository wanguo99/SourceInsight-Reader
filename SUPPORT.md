# 支持与问题反馈

本文对应当前 1.1.4 功能。先查看[使用说明](README.md)和[支持矩阵](docs/SUPPORT-MATRIX.md)，再运行 **SourceInsight-Reader: 能力与工程诊断**。

## 按现象排查

| 问题 | 建议步骤 |
| --- | --- |
| 没有索引或索引为 0 | 打开工程文件夹，运行“开始索引（选择模式）”，确认模式和范围并点击“开始索引”；仅保存配置或重新打开工作区不会启动。检查 `indexEnabled` 与屏蔽规则。 |
| 文件遗漏 | 查看“查看本地索引问题”和输出日志。核对编译数据库、工作区路径、Buildroot 映射、缺失生成头文件和被跳过的文件；导入不能覆盖屏蔽规则。 |
| 定义或引用不正确 | 记录结果来源、目标位置、是否有未保存修改和当前编译配置。C++ / Java / Python 检查语言服务就绪状态；本地 C 不完整执行预处理或条件编译。 |
| 调用关系为空或超时 | 确认光标位于可解析的函数中，查看 incoming / outgoing 各自状态；刷新 Relation 后重试。C++ 语义 outgoing 需要 clangd 20+。 |
| 内存不足或 Worker 停止 | 缩小索引范围、调整 CPU / 内存预算后重新开始索引。真正 OOM 后不会无限自动重启；预算上限不等于系统硬配额。 |
| 缓存或日志找不到 | 在插件设置中查看实际路径。当前使用 `cacheDirectory` 统一配置缓存根目录，项目下区分 `indexes` / `logs`；远程窗口使用远程扩展宿主路径。 |
| 缓存无法删除 | “管理本地缓存”保护正在使用的缓存；确认其他工程窗口是否仍持有它，不要强制删除使用中的数据库。 |
| 颜色、按键或面板位置异常 | 查看当前主题、已有用户 / 工作区设置和快捷键冲突。Source Insight 导航键位和布局预设需主动选择；F8 在主编辑器中固定高亮；启用 Source Insight 键位后，结果列表中用 F8 浏览结果。 |

本地索引恢复、读取或范围问题可从 **开始 / 更新索引（选择模式）** 重新选择并启动。刷新单次查询、重新索引、删除缓存和清除阅读数据用途不同，不应互相替代。

## 提交反馈

通过[仓库 Issues](https://github.com/wanguo99/sourceinsight-reader/issues)提交最小复现，建议包含：

- 插件版本、VS Code 版本和系统；是否使用 Remote SSH、WSL 或 Dev Container，以及插件安装在哪一侧。
- 语言、语言扩展和服务器版本；`navigationBackend` / `relationBackend` 的设置及结果显示的来源。
- 索引方式、所选范围、相关屏蔽规则；是否配置路径映射、是否出现不完整或跳过提示。
- 最小操作步骤、预期结果与实际结果；错误位置的文件和行号、是否存在未保存修改。
- 使用 **导出脱敏诊断** 生成的 JSON；必要时附经人工检查的截图或相关日志片段。

优先提供可公开的小工程。不要直接上传私有源码、原始编译数据库、凭据、完整日志或未经检查的工作区配置。诊断与存储内容的区别见[隐私说明](PRIVACY.md)。

## 验证与支持边界

错误跳转、源码或配置被覆盖、无法恢复的阅读数据丢失优先排查；随后处理挂起、崩溃和核心阅读失败。界面反馈和功能需求可单独提交，便于复现和验证。

支持矩阵中的“已实现”不代表每个平台、语言服务器或工程都已人工验收。历史自动检查和真机报告见[验证记录](docs/validation/README.md)，应按报告中的版本、环境和包摘要判断；旧报告不会因版本号更新自动成为当前包的验证结果。

当前说明更新不代表重新打包或 Marketplace 发布。维护人未承诺响应时限、付费支持或商业 SLA；MIT 授权不等于服务合同。

## English

Run **Diagnose Workspace Capabilities**, then report a public minimal example through [GitHub Issues](https://github.com/wanguo99/sourceinsight-reader/issues). Include the extension and VS Code versions, OS and remote host, language providers, selected backends, indexing mode and exclusions, reproduction steps, expected and actual locations, and whether files have unsaved changes.

Attach **Export Redacted Diagnostics** after reviewing it. Do not upload private source, raw compilation databases, credentials or unchecked logs. Opening a project or saving source selection does not start indexing: choose a mode and explicitly start it. Current cache settings use `sourceInsightReader.cacheDirectory`; older `indexCacheDirectory` descriptions do not describe the current configuration.

See the [English guide](README.en.md), [capability matrix](docs/SUPPORT-MATRIX.md) and [privacy policy](PRIVACY.md). No response-time or commercial-service commitment is implied.
