# SourceInsight-Reader 入门 / Getting started

## 1. 打开并诊断 / Open and diagnose

打开源码文件夹，运行 **SourceInsight-Reader: 打开阅读工作台 / Open Reading Workbench**。需要检查环境时运行 **能力与工程诊断 / Diagnose Workspace Capabilities**。

C 可使用内置离线索引；C++、Java 和 Python 的完整语义能力依赖相应语言服务。安装了语言扩展不代表工程已经加载完成。

Open a source folder and the reading workbench. Use diagnostics to inspect provider readiness; an installed language extension alone does not guarantee that its project is ready.

## 2. 明确开始索引 / Start indexing explicitly

点击 Context 的 **开始索引**，或运行 **Start Indexing (Choose Mode)**。选择编译数据库、已导入文件或整个工程，配置范围后点击管理页底部 **开始索引**。

**保存配置只保存范围，打开或重新打开工程也不会自动启动工程索引。** 编译数据库中的命令不会被执行；本地 C 索引不执行完整预处理或条件编译求值。

Choose a compilation database, imported files or the entire project, then start indexing. Saving the configuration is a separate action. Reopening a workspace requires another explicit start; normal edits update incrementally after startup.

## 3. 在原位置阅读 / Read without losing your place

用 Context 预览定义，用 Relation 浏览调用者、被调用者和具体调用现场；需要固定目标时分别锁定两个面板。Lookup References 查询符号引用，Lookup Text 查询普通文本、正则或多行内容。

Preview definitions in Context and explore calls in Relation. Reference lookup and text search are separate operations. Check result sources and partial-index notices when results are missing.

## 4. 按需调整并保存进度 / Customize and resume

布局与 Source Insight 导航键位默认不自动应用。通过 **设置 / Settings**、**选择键位预设 / Choose Keyboard Preset** 主动调整；主编辑器 F8 默认用于固定同名文本高亮，启用 Source Insight 键位后，结果列表中的 F8 用于浏览结果。

使用书签、笔记、阅读任务和保存检索记录进度。缓存可通过 **管理本地缓存 / Manage Local Cache** 管理；切换缓存目录不会自动搬移旧文件。

Choose layout and navigation-key presets explicitly. Save bookmarks, notes, reading tasks or searches to resume later. Reading records, caches and logs can contain private data; review diagnostics before sharing.

[中文使用说明](../README.md) · [English guide](../README.en.md) · [配置 / Configuration](CONFIGURATION.md) · [反馈 / Support](../SUPPORT.md) · [隐私 / Privacy](../PRIVACY.md)
