# Source Insight Inspired

Source Insight 风格的 VS Code 代码阅读插件，当前版本 **1.0.0**。围绕文件符号、Context、Relation 和 Lookup References，提供连续预览、符号浏览、调用追踪和阅读历史。

需要 VS Code **1.106 或更新版本**（用于右侧辅助侧栏注册）。同一份 VSIX 可用于 Windows 和 Linux，无需额外安装 Node.js 才能使用插件；C 的本地直接调用关系无需 clangd；完整类型、引用和 C++ 语义能力仍需要语言服务。Windows 适配及回归用例已加入，**Windows 实机与实际 UI 验收仍待完成**。

本插件是受 Source Insight 启发的非官方独立项目，与 Source Insight 官方无隶属或背书关系。扩展 ID 为 `local-dev.source-insight-inspired`，配置 / 命令前缀为 `sourceInsightInspired.*`。本版统一更换内部标识；从之前的试用版升级时，请卸载旧插件再安装本版，已有自定义设置和快捷键需要按新前缀重新配置。

## 安装

在 VS Code 扩展视图的菜单中选择“从 VSIX 安装”，选择 `dist/source-insight-inspired-1.0.0.vsix`。也可以在项目根目录运行：

```bash
code --install-extension dist/source-insight-inspired-1.0.0.vsix
```

打开源码工程，在命令面板运行 **Source Insight Inspired: 打开阅读工作台**，或通过命令面板聚焦文件符号。

文件管理直接使用原生 Explorer，插件不再提供文件树。按最新截图布局，文件符号默认显示在左侧辅助侧栏，原生 Explorer 位于右侧主侧栏；底部 Source Insight Inspired 面板只有一个“Context / Relation”视图，内部固定左 Context、右 Relation，与 Terminal（终端）处于同一区域。Lookup References 在主编辑区打开独立结果标签页。可以右键视图标题移动视图、拖动分隔线调整大小；插件不会强行覆盖已有布局。

首次启动会应用截图布局：把主侧栏设为右侧（原生 Explorer），文件符号留在相对的辅助侧栏，并将底部面板放在下方、横跨工作区。之后保留你的手动调整。升级后如旧视图曾被单独移动，执行 **Source Insight Inspired: 应用 Source Insight 布局**；必要时右键视图标题恢复默认容器，再应用布局。0.8 起 Context 与 Relation 在同一个 Webview 内固定左右分栏，不再依赖拖动两个原生视图。默认 60% / 40%，拖动中间竖线调整；也可 Tab 聚焦分隔线后用左右箭头调整，比例保存在 Webview 状态中。旧独立 Relation 视图会随重载移除。

不希望自动布局时，设置 `sourceInsightInspired.layout = preserve`。**Source Insight Inspired: 恢复原侧栏位置** 会恢复应用前的侧栏设置层级；不撤销之后手动调整的宽度或其他视图停靠。恢复主题与恢复布局是独立操作。

Windows 的 PowerShell 安装、clangd 路径、开发及验收步骤见 [Windows 使用指南](docs/WINDOWS.md)。

## 阅读主题

运行 **Source Insight Inspired: 选择阅读主题**（文件符号与 Context 标题栏也有入口）：

- **使用 VS Code 主题**：默认保留当前主题；从 Source Insight 切回时恢复之前的主题设置。
- **使用 Source Insight 自定义主题**：应用根据提供的 `SourceInsight_Configuration.xml` 提取的内置主题。编辑区和 Context 使用浅绿 `#e6ffe3` 背景、紫色注释、红色数字、深蓝声明；按截图区分区域：代码浅绿、原生 Explorer 和文件符号列表灰蓝、窗口标题/标签栏浅灰、底部空白灰色。Context 与 Relation 底部使用紧凑工具栏；文件符号原生树保留精简标题操作及菜单。

也可设置 `sourceInsightInspired.appearance` 为 `vscode` 或 `sourceInsight`。有工作区时仅修改当前工作区的主题选择，没有工作区时修改用户设置；原主题设置会保存用于恢复。通过 VS Code 自带主题选择器切换到其他主题时，插件尊重该选择。不会修改字体、字号、缩进或键位。

主题名称为 **Source Insight Inspired Source Insight**，也出现在 VS Code 的颜色主题选择器中。支持通过标准主题限定的 `workbench.colorCustomizations` 继续自定义。现有颜色或语义高亮覆盖设置仍可能优先于主题。

此版本内置的是该 XML 的配色映射，不导入其他任意 XML。Source Insight 的混合字号、阴影、逐词背景和布局设置无法由 VS Code 颜色主题完整复刻；Context 的基础词法高亮也不等同于主编辑器的语义高亮。映射与恢复规则见 [主题说明](docs/THEMES.md)。

## 典型阅读流程

1. 使用原生 Explorer，或 `Alt+Shift+P` 查找工程文件。
2. 在文件符号定位函数，或 `Alt+Shift+S` 查找全局符号。全局查询复用语言服务索引，支持输入时更新与选择预览。
3. 将光标放在函数调用或变量上，Context 显示函数、标量变量或数组定义；结构体等对象可预览类型；也可切换到类型定义或包含函数模式。
4. 在 Context 中查看带基础语法着色的源码，使用“向上浏览 / 向下浏览”查看更多内容。点击其中的标识符可继续在 Context 内跳转，Shift+点击强制查看类型，工具栏 ← / →、Alt+, / Alt+. 或代码区域的鼠标后退/前进侧键返回/前进。点击“在主编辑器打开”打开预览位置；非符号区域双击或按 Enter 也可打开。
5. `Alt+=` 跳转到定义，`Alt+,` 返回，`Alt+.` 前进。定义有多个候选时先选择，不静默跳到第一个。
6. `Shift+F12` 为光标处符号在编辑区打开 Lookup References 结果页；顶部搜索框按文件路径或源码筛选，`Ctrl+F` 聚焦搜索框、Esc 清空、Enter 聚焦首个结果。点击结果或聚焦结果后按 Enter 跳到源码，Alt+点击在 Context 预览；支持刷新和历史查询。`F8 / Shift+F8` 循环预览筛选后的引用。
7. Relation 默认同时显示左侧直接调用者、中间当前函数、右侧直接调用函数。底部“视图”可切换为原有树形列表，继续逐层展开。锁定根节点后可以继续阅读其他代码。

可以直接打开 `examples/cpp` 体验：`process_request` 调用 `leaf` 两次，`recurse` 展示递归，`main` 中有同名局部变量和函数指针示例。

## 窗口联动

| 窗口 | 操作和行为 |
| --- | --- |
| 文件符号 | 默认显示头文件、宏、全局变量、结构体、枚举和函数；按名称过滤与排序，可切换仅函数 |
| Context | 自动跟随、候选选择、基础语法着色、上下浏览、独立预览历史、锁定和刷新 |
| Relation | 固定在 Context 右栏；双向一层横向图 / 多级树形列表可切换，保留调用位置、根节点锁定、查询缓存和底部工具栏 |
| Lookup References | 编辑区结果标签页、顶部搜索框、按文件分组、源码片段、分页、筛选、查询历史 |

单击 Relation 函数节点只在 Context 预览对应调用现场；双击、按 Enter 或底部 ↗ 按钮在主编辑器打开函数定义；底部还提供查询引用、设为根、折叠与锁定操作。引用结果页点击直接打开源码，Alt+点击在 Context 预览。Context 锁定时，Enter 仍打开树中实际选中的位置，不会误开锁定的预览。

Context 与 Relation 分别锁定；锁定后自动事件不改变目标，刷新只更新原目标。Relation 切换方向保留已选定的根节点。源码编辑后，引用和关系标为可能过期；预览读取当前缓冲区，包括未保存内容，但原位置可能移动，需重新定位。

阅读历史记录插件跳转、文件切换和命令触发的编辑器选区跳转。普通光标移动不逐个入栈。Context 的前进、后退是独立的预览历史。

启用插件后会显示文件符号视图，替换辅助侧栏中当前选中的 Chat 视图，并尽量保留编辑器焦点；按截图布局时它位于左侧。Chat 仍可手动切回。

Context 标题行直接显示“Context · 定义 · 文件名:行:列”，不再单独占一行显示目标信息。长文件名省略，悬停显示完整路径；只有多候选时出现候选下拉行。

## Context 内连续阅读

默认“智能定义”模式优先保留函数本体；对于类型目标可确认为结构体、类、联合体或枚举的对象，可自动预览该类型；标量变量、常量和标量数组仍显示其定义与初始化值，不自动转到 `size_t` 等标量 typedef。函数返回结构体时仍展示函数定义，避免误跳到返回类型。C 的普通函数定义优先使用本地索引，避免把调用位置当成定义；其他定义和类型定义使用语言服务。普通定义不可用时尝试声明，多个候选需手动选择。强制类型模式无结果时会提示无结果，不以变量声明冒充类型定义。

Context 内点击带下划线悬停效果的标识符，可继续查看该符号；Shift+点击强制类型查询。也可用 Tab 聚焦链接、Enter 跳转。跳转使用当前预览文件的坐标，支持跨文件，保留独立预览历史，不移动主编辑器。锁定状态下需要先解锁才能继续跳转。源码缓冲区修改后需刷新，旧预览点击不会继续使用过期位置。

## 快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Alt+=` | 跳转到定义 |
| `Alt+,` / `Alt+.` | 主阅读位置后退 / 前进 |
| `Shift+F12` | Lookup References |
| `Alt+Shift+S` | 查找全局符号 |
| `Alt+Shift+P` | 查找工程文件 |
| `F8` / `Shift+F8` | 有可用引用结果时，预览下一个 / 上一个引用 |
| `Enter` | 在 Relation 中打开选中位置，或在引用结果页打开聚焦结果；在 Context 代码区域打开预览 |

前三个 Alt 导航键参考 Source Insight 的默认导航设计。其他键位为本插件的安排。设置 `sourceInsightInspired.sourceInsightKeys = false` 可关闭导航、查询和 F8 的默认绑定，恢复 VS Code 对应默认行为；树和 Context 内的 Enter 操作保留。所有动作也可以通过命令面板执行或重新绑定。

## Relation 横向关系图（0.10.0）

默认采用从左向右的关系图：**直接调用者 → 当前函数 → 直接调用函数**。两侧同时查询，各显示一层，不继续展开孙级节点。当前函数突出显示；函数节点仅显示函数名，文件位置和完整名称通过悬停查看。窗口较窄或调用者较多时支持横向、纵向滚动，中间分隔线仍可调整 Context / Relation 的宽度。

单击函数节点只在 Context 预览调用现场：caller 显示其内部调用当前函数的位置，callee 显示当前函数中调用它的位置。多个调用位置默认预览第一处；无调用位置时回退到函数定义。双击或 Enter 在主编辑器打开函数定义。节点下的“调用点 n”可选择具体调用位置并预览；底部“设为根”可继续查看选中函数的上下游。某一方向查询失败时，另一侧可用结果仍会保留。

通过底部“视图”按钮或命令 **Source Insight Inspired: 选择 Relation 显示方式** 切换，立即生效并保存设置，不改变当前根节点和锁定状态。也可以手动配置：

```json
"sourceInsightInspired.relationView": "horizontalGraph"
```

改为 `"outline"` 使用原有树形列表，支持方向切换和多级展开。横向图每侧最多显示 200 个函数；超过时提示，可切换列表查看。

## 本地 C 调用索引（0.9.0）

默认 `sourceInsightInspired.relationBackend = "auto"`：工作区内 `.c`/`.h` 的 Relation 优先查询内置 Tree-sitter/WASM 索引；不在本地覆盖范围时尝试语言服务。无需安装额外工具或准备编译数据库，后台工作线程处理解析、头文件关联和查询。光标在函数调用名上时跟随该目标，在函数体其他位置跟随包含函数。

- 支持谁调用它、它调用谁、逐级展开、递归标记，以及同一调用边的全部直接调用位置。
- 按文件区分 `static` 函数；头文件中的 `static inline` 按直接/传递 include 关系关联；项目 include 路径使用相邻文件优先和唯一后缀匹配，歧义时不任选一个。
- 定义位置与调用位置分开保存。未解析外部函数、宏调用或多个候选节点会标明“未解析”，点击定位调用现场，不伪装成定义。
- 首次按需扫描，之后加载缓存并按内容哈希检查；源码修改、保存、外部变化、创建和删除触发增量更新。未保存内容仅覆盖内存，不写入磁盘快照。
- 在底部 Relation 点刷新可检查全工程；命令 **Source Insight Inspired: 重建本地 C 调用索引** 可丢弃缓存重新解析。扫描状态和错误见“输出 → Source Insight Inspired”。
- 可设 `relationBackend = "local"` 只用本地后端，或 `"languageService"` 恢复纯语言服务模式（同时关闭本地函数定义及文件符号回退）。
- `sourceInsightInspired.indexExclude` 控制排除目录，默认排除 `.git/.cache/node_modules/build/dist/out/research`；单文件上限 8 MiB，仅本地文件 URI，系统头文件不会额外扫描。

第一版持久化使用工作区扩展存储目录中的 `c-index-v1.json`，保存语法事实，启动后重建内存查询表；尚未引入 SQLite/sql.js。这样先解决 Relation 的可靠性，后续可替换存储层而不改变界面接口。

本地索引不求值 `#if`、不展开宏、不推断函数指针或动态调用。条件分支会共同收录，同名候选需选择；不确定目标只显示未解析调用，不能据此认定没有运行时调用。含语法错误的文件尽量保留可识别部分，完整性见输出记录。

## C/C++ 配置

安装 clangd 可执行文件，以及 VS Code 的 `llvm-vs-code-extensions.vscode-clangd` 扩展。语言服务模式下完整双向调用层次需要 **clangd 20+**；clangd 19 支持调用者查询，但没有 outgoing calls。本地 C 模式的两个方向不受这个版本限制。

工程应提供正确的头文件、宏和编译参数，例如 `compile_commands.json` 或 `compile_flags.txt`。示例提供后者，也可在已配置构建工具链的终端生成编译数据库：

```bash
cmake -S examples/cpp -B examples/cpp/build -G Ninja
cmake --build examples/cpp/build
```

语言服务模式的零结果可能表示没有直接调用，也可能来自索引未就绪、配置不足或能力不受支持。空结果不再永久缓存；重新展开或刷新可重试，同一根节点临时查询失败时保留已取得的结果。本地 C 模式则明确提示未找到直接调用或目标未解析。

## 完整文件符号（0.3）

原“函数列表”更名为“文件符号”，默认显示全部符号。C/C++ 的结构体、联合体、枚举、变量和函数使用语言服务返回的层次结构；成员可展开查看。头文件包含、对象宏和函数宏由源码扫描补充，支持多行宏、CRLF 和未保存缓冲区，并与语言服务结果去重。每个条目显示类别，选择后可定位源码。

源码补充项不判断条件编译是否生效，因此 `#if 0` 内的包含和宏也可能显示；悬停会标明此限制。此列表显示当前文件的包含语句，不递归展开所包含头文件。语言服务无结果或响应缓慢时，C 文件改用 Tree-sitter 提供函数、函数声明、全局变量、结构体/联合体、枚举、typedef 和基础成员列表；复杂类型语义仍需语言服务。

打开 `examples/c/outline.c` 可验证包含、宏、全局变量、结构体、typedef、枚举和函数。如果旧工作区仍只显示函数，在命令面板执行“Source Insight Inspired: 切换全部符号/仅函数”，或设置：

```json
"sourceInsightInspired.symbolKinds": "all"
```

libbmc 中“函数定义跳到另一个调用处”的已复现实例与配置步骤见 [libbmc clangd 排查记录](docs/LIBBMC_CLANGD.md)。

## 配置项

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `sourceInsightInspired.layout` | `sourceInsight` | 首次应用左符号/右 Explorer/底部面板；`preserve` 保留当前位置 |
| `sourceInsightInspired.appearance` | `vscode` | 保留/恢复 VS Code 主题，或 `sourceInsight` 使用内置 XML 配色 |
| `sourceInsightInspired.autoPreview` | `true` | 自动预览 |
| `sourceInsightInspired.autoRelation` | `true` | Relation 自动跟随当前函数 |
| `sourceInsightInspired.contextMode` | `definition` | `definition` 智能定义（函数定义/结构体等对象类型）、`type` 强制类型定义、`enclosing` 包含函数 |
| `sourceInsightInspired.debounceMs` | `250` | 自动查询防抖间隔，毫秒 |
| `sourceInsightInspired.contextLines` | `20` | 目标上下预览行数 |
| `sourceInsightInspired.symbolSort` | `position` | 源码顺序或 `name` 名称排序 |
| `sourceInsightInspired.symbolKinds` | `all` | 全部符号，或 `functions` 仅函数及其容器 |
| `sourceInsightInspired.sourceInsightKeys` | `true` | 启用上述导航、查询快捷键 |
| `sourceInsightInspired.files.include` | `[]` | 文件包含 glob，空数组显示全部 |
| `sourceInsightInspired.files.exclude` | `.git`、`node_modules` | 额外排除 glob |

函数筛选偏好保存在工作区状态。引用历史和预览历史只保留当前会话，避免跨重启使用失效符号位置。

工程文件查找还遵循 `files.exclude` 值为 `true` 的条目。初版 glob 支持 `*`、`?`、`**`；暂不提供花括号、`when` 条件、`.gitignore` 和 `search.exclude` 联动。

## 开发和测试

开发建议使用 Node.js 22。安装 VSIX 的普通用户无需安装这些开发依赖。

```bash
npm ci
npm run check
npm run test:unit
npm run test:clangd
npm run package
```

`npm test` 运行所有逻辑、DOM 模型和真实 clangd 协议测试。未安装 clangd 时通用测试会明确跳过真实语义部分；`test:clangd` 则要求 clangd 存在。clangd 19 的 outgoing 测试也会明确跳过。

源码采用经过 TypeScript 静态检查的 CommonJS JavaScript，运行时无第三方依赖，无需构建平台专用二进制。`package` 使用官方 vsce 打包，不发布至 Marketplace。项目可用 F5 启动扩展开发宿主。

扩展宿主测试：

```bash
npm run test:host
```

脚本检测 Windows 用户/系统版 VS Code 和常见 Linux/macOS 安装位置。可设置 `VSCODE_EXECUTABLE_PATH` 覆盖路径；Windows 应指向 `Code.exe`，不使用 `code.cmd`。`SOURCE_INSIGHT_INSPIRED_EXTENSIONS_DIR` 可覆盖已安装扩展目录，`CLANGD_PATH` 可覆盖测试后端。

测试复制样例工程和 clangd 扩展到临时目录，不修改原工程，无需 Windows 符号链接权限。没有 Linux 显示环境时使用 Xvfb。可显式设置 `SOURCE_INSIGHT_INSPIRED_DOWNLOAD_VSCODE=1`、`SOURCE_INSIGHT_INSPIRED_INSTALL_CLANGD_EXTENSION=1`，允许脚本在缺少工具时下载测试用 VS Code 和安装 clangd 扩展。

已添加 Windows/Linux 检查和打包 CI，宿主任务需要手动启用 `run_host`。当前仓库尚未推送远端，CI 配置并未实际执行，不能视为 Windows 通过记录。

## 与 Source Insight 的差异

- 已有独立 C 语法调用索引和持久化快照，但不是完整编译器语义数据库；复杂宏、间接调用、完整类型推导、Lookup References 和 C++ 仍依赖语言服务。
- VS Code 的停靠与布局受平台控制，支持手动调整，不能完全复刻 Source Insight 的窗口布局。
- Context 为只读预览，使用基础词法着色；支持 C/C++、JS/TS、JSON，其他语言保留纯文本。不等于完整 TextMate/语义高亮，最多回看 400 行恢复跨行状态，超长单行保留纯文本。
- 暂未实现浏览器只读编辑模式、类型继承树、图形调用图和多个固定关系实例。
- 引用还未按所在函数二次分组；结果标签页每文件初始展示 200 项，可加载更多。工程文件搜索最多扫描 10000 项，全局符号最多展示 1000 项，并提示上限。
- Relation 横向图每侧最多显示 200 项；原树形列表单次最多渲染 500 项、40 层，超过时提示，可折叠其他分支；本地和语言服务查询使用同一展示模型。
- 公开语言命令的逻辑取消通过丢弃过期结果实现，不保证终止底层计算。
- 编辑后锁定位置不做精确变换；函数指针和动态分派关系不保证完整。
- Windows 大小写敏感目录、Remote/WSL、大型工程性能和最低 VS Code 1.106 实机尚未验收。

验证状态见 [0.10.0 验证报告](docs/VALIDATION_0.10.0.md)，原始需求见 [开发计划](docs/DEVELOPMENT_PLAN.md)。

参考：[Source Insight 导航](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Symbol_Navigation_Commands.htm)、[前进后退](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Go_Back_and_Go_Forward_commands.htm)、[VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)、[LLVM 20 outgoing calls](https://releases.llvm.org/20.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html)。

Source Insight 安装目录、内置主题、帮助与界面资源分析见 [安装目录分析](docs/SOURCE_INSIGHT_INSTALLATION_ANALYSIS.md)。
