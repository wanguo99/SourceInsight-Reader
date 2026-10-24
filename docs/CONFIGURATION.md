# 当前配置参考

由 manifest 生成。工作区设置优先；具体外观字段在插件设置页编辑。默认保留键位、布局与共享配置，升级时已有显式设置仍优先。

| 设置 | 默认值 | 类型 / 范围 | 说明 |
| --- | --- | --- | --- |
| sourceInsightReader.navigationBackend | "auto" | auto / local / languageService | 定义、符号和引用查询策略：auto 优先语言服务，再尝试基础 C 回退；local 仅本地；languageService 仅语言服务。引用的空结果与能力判断见支持矩阵。 |
| sourceInsightReader.queryTimeoutMs | 5000 | integer 100–30000 | 引用等显式查询等待上限（毫秒）；自动定义使用至多 500ms 的语义等待，再尝试有界本地回退。超时后台命令仍占并发额度，避免请求堆积。 |
| sourceInsightReader.workspaceSymbolTimeoutMs | 5000 | number 100–60000 | 全局符号搜索等待语言服务的上限（毫秒）；Java / Python 大项目可适当增加。 |
| sourceInsightReader.autoPreview | true | boolean | 光标停留时自动在 Context 预览定义。 |
| sourceInsightReader.autoRelation | true | boolean | 未锁定时 Relation 跟随当前函数。 |
| sourceInsightReader.debounceMs | 250 | number 100–2000 | 自动查询防抖时间（毫秒）。 |
| sourceInsightReader.contextLines | 20 | integer 5–100 | Context 目标上下显示的行数。 |
| sourceInsightReader.files.exclude | ["**/.git","**/node_modules"] | array | 工程文件查找的额外排除 glob；支持 *、?、**，遵循 files.exclude。 |
| sourceInsightReader.files.include | [] | array | 工程文件查找的包含 glob，空数组显示全部。 |
| sourceInsightReader.symbolSort | "position" | position / name | 函数列表排序方式。 |
| sourceInsightReader.sourceInsightKeys | false | boolean | 启用 Source Insight 风格的 Alt+=、Alt+,、Alt+.，并将 Shift+F12 路由至编辑区引用结果页；F8 浏览已查询引用。可关闭以恢复 VS Code 默认键位。 |
| sourceInsightReader.contextMode | "definition" | definition / type / enclosing | Context 默认查看当前符号自身的定义或声明，变量和字段不自动跳到类型；也可显式选择类型定义或包含函数。 |
| sourceInsightReader.symbolKinds | "all" | functions / all | 默认显示文件全部符号，包括 C/C++ 头文件包含、宏、全局变量、结构体、枚举和函数。functions 仅显示函数及其容器。 |
| sourceInsightReader.layout | "preserve" | sourceInsight / preserve | 默认保留现有视图布局。显式应用时显示阅读视图；原生面板位置和对齐由用户控制，主侧栏仅按 explorerSide 的显式选择设置。 |
| sourceInsightReader.explorerSide | "preserve" | preserve / left / right | 显式应用阅读布局时的主侧栏位置。preserve 保留当前左右位置，不迁移用户已放置的视图。 |
| sourceInsightReader.relationBackend | "auto" | auto / local / languageService | Relation 调用关系分析后端。auto 优先语言服务并在不可用时回退本地 C；local 无需 clangd 或编译数据库，不求值条件编译，不解析间接调用。 |
| sourceInsightReader.indexExclude | "**/{.git,.cache,node_modules,build,dist,out,research}/**" | string | 本地 C 索引扫描排除规则（VS Code glob）。修改后自动重新扫描，也可运行重建索引命令。 |
| sourceInsightReader.relationView | "horizontalGraph" | horizontalGraph / outline | Relation 的显示方式。横向图同时显示当前函数的直接调用者和直接调用函数；树形列表保留多级 Outline。 |
| sourceInsightReader.textLookupExclude | "**/{.git,.cache,node_modules,build,dist,out,research}/**" | string | 文件夹字符检索额外排除规则；同时遵循 files.exclude / search.exclude 中值为 true 的规则。 |
| sourceInsightReader.symbolHighlightUseF2 | false | boolean | 使用 F2 固定 / 取消同名符号高亮，覆盖 F2 原有重命名；关闭后保留 Ctrl+Alt+H 或命令入口。 |
| sourceInsightReader.relationTimeoutMs | 5000 | number 250–30000 | 语言服务调用关系单次等待上限（毫秒） |
| sourceInsightReader.relationLocalTimeoutMs | 2000 | number 250–15000 | 本地索引调用关系单次等待上限（毫秒），索引建立中不会无限阻塞窗口 |
| sourceInsightReader.relationRetryDelayMs | 30000 | number 1000–300000 | 同一工作区 / 语言 / 查询方向连续两次超时后暂停自动重试的时间（毫秒），手动刷新可立即重试 |
| sourceInsightReader.indexEnabled | true | boolean | 启用本地 C 索引，为符号、定义及调用关系查询提供数据；独立于 Relation 后端选择。 |
| sourceInsightReader.excludedDirectories | [] | array | 屏蔽目录及其全部子目录，在扫描前排除。支持相对工作区路径、工作区内绝对路径或 URI，可在工程文件树中右键批量设置。 |
| sourceInsightReader.autoConfigureClangd | false | boolean | 根据屏蔽的文件和目录自动维护工作区 .clangd 的后台索引排除规则，保留已有编译配置。关闭后移除本插件规则。 |
| sourceInsightReader.excludedFiles | [] | array | 屏蔽指定文件。可在工程文件树中 Shift 连选或 Ctrl / Cmd 多选后右键批量屏蔽。 |
| sourceInsightReader.appearance.panes | {} | object | 各阅读窗口的字体、字号、文字和背景颜色。使用 **SourceInsight-Reader: 设置** 页的 **外观设置** 标签编辑；留空继承主题。 |
| sourceInsightReader.indexMemoryLimitMb | 1024 | integer 128–8192 | 本地 C Worker 的 JS 堆上限（MiB），默认 1024。修改后重建线程。接近预算时保留明确标记的部分索引，真实 OOM 停止自动重试。此值不是整个进程的总内存上限。 |
