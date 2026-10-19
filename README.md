# Source Insight Inspired

Source Insight 风格的 VS Code 代码阅读插件，当前版本 **0.0.1**。围绕文件符号、Context、Relation 和 Lookup References，提供连续预览、符号浏览、调用追踪和阅读历史。

需要 VS Code **1.106 或更新版本**（用于右侧辅助侧栏注册）。同一份 VSIX 可用于 Windows 和 Linux，无需额外安装 Node.js 才能使用插件；C 的本地直接调用关系无需 clangd；完整类型、引用和 C++ 语义能力仍需要语言服务。Windows 适配及回归用例已加入，**Windows 实机与实际 UI 验收仍待完成**。

本插件是受 Source Insight 启发的非官方独立项目，与 Source Insight 官方无隶属或背书关系。扩展 ID 为 `local-dev.source-insight-inspired`，配置 / 命令前缀为 `sourceInsightInspired.*`。本版统一更换内部标识；从之前的试用版升级时，请卸载旧插件再安装本版，已有自定义设置和快捷键需要按新前缀重新配置。

后续修改按补丁版本递增：`0.10.1` → `0.10.2` → `0.10.3`，不再复用同一版本号。

## 安装

在 VS Code 扩展视图的菜单中选择“从 VSIX 安装”，选择 `dist/source-insight-inspired-0.0.1.vsix`。也可以在项目根目录运行：

```bash
code --install-extension dist/source-insight-inspired-0.0.1.vsix --force
```

打开源码工程，在命令面板运行 **Source Insight Inspired: 打开阅读工作台**，或通过命令面板聚焦文件符号。

插件提供独立的“工程文件”窗口。0.10.5 起，文件符号与原生 Explorer 是左侧同级的两个独立入口，切换到文件符号时不再显示 Explorer；右侧为工程文件；工程文件与文件符号均可独立移动；底部 Source Insight Inspired 面板只有一个“Context / Relation”视图，内部固定左 Context、右 Relation，与 Terminal（终端）处于同一区域。Lookup References 在主编辑区打开独立结果标签页。可以右键视图标题移动视图、拖动分隔线调整大小；插件不会强行覆盖已有布局。

0.10.5 首次启用进行一次布局迁移：符号列表移出 Explorer，成为左侧独立入口；工程文件在右侧，并设置底部阅读面板；之后保留手动调整。`sourceInsightInspired.layout = preserve` 会跳过迁移。`sourceInsightInspired.explorerSide` 的 `preserve` 保留之后的位置，`left` / `right` 切换主侧栏。符号列表可右键标题选择“移动视图”，或拖动视图 / 容器到主侧栏或辅助侧栏，实现独立布局；移动后重载不会被插件重置。升级后如旧视图曾被单独移动，执行 **Source Insight Inspired: 应用 Source Insight 布局**；必要时右键视图标题恢复默认容器，再应用布局。0.8 起 Context 与 Relation 在同一个 Webview 内固定左右分栏，不再依赖拖动两个原生视图。默认 60% / 40%，拖动中间竖线调整；也可 Tab 聚焦分隔线后用左右箭头调整，比例保存在 Webview 状态中。旧独立 Relation 视图会随重载移除。

不希望自动布局时，设置 `sourceInsightInspired.layout = preserve`。**Source Insight Inspired: 恢复原侧栏位置** 会恢复应用前的侧栏设置层级；不撤销之后手动调整的宽度或其他视图停靠。主题由 VS Code 原生颜色主题设置管理。

Windows 的 PowerShell 安装、clangd 路径、开发及验收步骤见 [Windows 使用指南](docs/WINDOWS.md)。

版本从 **0.0.1** 重新计数：`0.0.1 → … → 0.0.99 → 0.1.0 → … → 0.1.99 → 0.2.0`。版本重置后从较高旧版本覆盖安装时，命令加 `--force`。

## 阅读主题

主题统一由 VS Code 管理，与其他主题同级：按 **Ctrl+K，再 Ctrl+T**，或执行 **首选项：颜色主题**，选择 **Source Insight Inspired Source Insight**。切换回其他主题也使用同一入口。主题选择由 VS Code 保存，安装、升级、重载插件均保留当前主题。

插件不再自动切换主题，不提供单独主题模式、主题选择或恢复命令；旧的 `sourceInsightInspired.appearance` 配置不再生效，可从 settings.json 删除。升级不会自动还原或改变当前正在使用的主题。

文件符号、工程文件、Context 与 Search Results 标题栏的齿轮按钮打开 **功能设置**，使用 VS Code 原生设置界面筛选本插件，集中配置布局、索引、窗口行为与快捷键等功能。

内置主题提供浅绿代码区、灰蓝列表、浅灰标题栏及黄色符号高亮；主编辑器、Context、Explorer、符号与结果列表一起跟随原生主题切换。支持通过标准主题限定的 `workbench.colorCustomizations` 自定义，已有颜色或语义高亮覆盖设置仍可能优先于主题。

此版本内置的是 XML 配色映射，不导入其他任意 XML。Context 的基础词法高亮不等同于主编辑器的语义高亮，配色映射见 [主题说明](docs/THEMES.md)。

符号列表顶部是独立的文件标签栏，配色与 Context / Relation 标题栏一致，悬停显示完整路径。下方常驻搜索框按符号名 / 头文件名即时筛选，不区分大小写，匹配子项时保留父级。Esc 或 × 清空搜索，Ctrl+F 聚焦搜索（列表聚焦时），支持中文输入。点击符号定位源码，Alt+点击或空格在 Context 预览；右键提供“查询引用”和“设为 Relation 根节点”。标题菜单仍可切换排序及全部符号 / 仅函数。

符号名前显示参考 `UI/图标.png` 绘制的 16px SVG 图标：头文件包含为黄色 `#`，宏定义为红色 `#`，结构体为金色 `S`，函数为青色文档，全局变量为蓝色圆形，成员为绿色菱形箭头。枚举、枚举成员、联合体、类型别名和常量分别使用独立图标。图标随插件分发，不依赖字体；悬停仍可查看符号类别与位置。

## 工程文件树（0.10.5）

右侧独立“工程文件”窗口，上方保留一行 24px 内嵌搜索框，下方按原生 Explorer 的样式显示目录和文件：22px 行高、可配置缩进、引导线、折叠箭头、悬停及选中颜色。文件图标直接读取当前 VS Code 文件图标主题的字体 / 图片资源，常见 C、头文件、JSON 等图标随主题变化；无法读取主题、字体加载失败或图标图片损坏时使用折角文件 / 文件夹图标；字体加载成功后才显示对应字形，避免缺字方框。为保留内嵌搜索，视图仍使用 Webview，未改成不支持内嵌输入框的原生 TreeView，不再在原生 Explorer 内额外占一个搜索窗口。支持多根工作区，目录优先排序，点击箭头展开 / 折叠；点击文件或 Enter 打开源码，切换编辑器会展开并选中对应文件。窗口可通过标题菜单移动到任意一侧。

输入后按文件名 / 目录名的连续字符包含关系过滤，不区分大小写。例如 `main` 只保留名称中含 main 的文件或目录（包括 `main.c`、`domain.c`），不再将分散字符 `m_a_i_n.c` 作为模糊命中。匹配目录也不会带出其下名称无关的文件；保留父目录仅用于显示层级。仍支持路径约束和空格组合，如 `src/bmc catalog`，最后一项必须包含在当前节点名称中，前面各项用于约束路径；兼容 Windows 路径分隔符。匹配项和必要父级自动展开；清空搜索恢复普通目录树及之前的展开状态。没有常驻提示文字，完整路径和扫描状态通过悬停查看。Esc 清空，标题栏刷新按钮重新扫描。命令 **Source Insight Inspired: 聚焦工程文件** 可聚焦输入框。

创建 / 删除文件、工作区及排除规则变化后更新列表，搜索词和手动展开状态保存在工作区。遵循 `files.exclude` 和插件的 `files.include` / `files.exclude` 规则；最多扫描 50000 个文件，过滤时取前 2000 个匹配文件、最多显示 3000 个树节点，超限信息在输入框悬停提示中显示。目录由匹配文件构建，因此空目录不显示。当前提供代码阅读所需的浏览、过滤和打开，不包含新建 / 重命名 / 删除操作；原生 Explorer 仍可用于文件管理。

## Ctrl 悬停与跳转

主编辑器中按住 Ctrl 悬停可解析的符号，会使用 VS Code 原生定义链接提示与小手光标；Ctrl+点击跳到定义，F12 同样可用（macOS 通常使用 Cmd）。内置索引为工作区 C 函数提供定义链接，其他符号和 C++ 依赖语言服务；没有可解析定义的符号不会冒充链接。若启用 `editor.multiCursorModifier = ctrlCmd`，VS Code 会把鼠标跳转修饰键改为 Alt。

Context 中保留单击预览下一级定义，也支持 Ctrl+悬停高亮与 Ctrl+点击；不跳转主编辑器。

Context 提供 C/C++ 词法高亮：关键字、基础类型、struct / union / enum 名称、`*_t` 类型、函数、宏形式标识符、成员访问、数字、字符串及注释。`#include` 路径和宏定义体分别着色；多行注释、原始字符串及反斜线续行字符串保留状态。按文档版本缓存状态检查点，预览从长注释中间开始也能恢复颜色。宏和类型分类包含词法启发规则，不等同于编译器语义高亮。

## 典型阅读流程

1. 使用右侧工程文件树浏览或搜索路径 / 文件名，也可用原生 Explorer 或 `Alt+Shift+P`。
2. 在文件符号定位函数，或 `Alt+Shift+S` 查找全局符号。全局查询复用语言服务索引，支持输入时更新与选择预览。
3. 将光标放在函数调用或变量上，Context 显示函数、标量变量或数组定义；结构体等对象可预览类型；也可切换到类型定义或包含函数模式。
4. 在 Context 中查看带基础语法着色的源码，使用“向上浏览 / 向下浏览”查看更多内容。点击其中的标识符可继续在 Context 内跳转，Shift+点击强制查看类型，工具栏 ← / →、Alt+, / Alt+. 或代码区域的鼠标后退/前进侧键返回/前进。点击“在主编辑器打开”打开预览位置；非符号区域双击或按 Enter 也可打开。
5. `Alt+=` 跳转到定义，`Alt+,` 返回，`Alt+.` 前进。定义有多个候选时先选择，不静默跳到第一个。
6. `Shift+F12` 为光标处符号在编辑区打开 Lookup References 结果页；顶部搜索框按文件路径或源码筛选，`Ctrl+F` 聚焦搜索框、Esc 清空、Enter 聚焦首个结果。点击结果或聚焦结果后按 Enter 跳到源码，Alt+点击在 Context 预览；支持刷新和历史查询。`F8 / Shift+F8` 循环预览筛选后的引用。
7. Relation 默认同时显示左侧直接调用者、中间当前函数、右侧直接调用函数。底部“视图”可切换为原有树形列表，继续逐层展开。锁定根节点后可以继续阅读其他代码。

可以直接打开 `examples/cpp` 体验：`process_request` 调用 `leaf` 两次，`recurse` 展示递归，`main` 中有同名局部变量和函数指针示例。

## 文件夹字符检索（Lookup Text，0.10.8）

选中字符或把光标放在变量 / 函数名上，右键选择 **Source Insight Inspired: Lookup Text（文件夹字符检索）**，也可以从命令面板执行。它在底部打开与 Context 平级、可独立拖动的 **Search Results** 面板，参考 `UI/lookup.png`：左侧是检索历史，右侧按所在函数、文件行列、匹配源码逐条列出并高亮命中字符。

默认搜索当前源码所属的工作区文件夹；多根工作区可通过顶部下拉框切换。输入框可修改字符后按 Enter 再查，提供“区分大小写”和“全词”选项。默认按字面字符包含匹配，包含声明、定义、调用、注释和字符串中的命中，不依赖 clangd。已有本地 C 索引时补充所在函数；不能确定时显示 `—`，而不是猜测作用域。原有 Shift+F12 的语义 Lookup References 保留。

- 单击结果或 Enter 在主编辑器复用预览标签页，双击固定文件标签页；Alt+点击仍可在 Context 预览。
- 面板顶部切换“字符检索 / 引用检索”，分别保留查询与筛选结果。点击结果不会切回 Context；Context / Relation 的原有布局保持不变。
- “上一个 / 下一个”以及 F8 / Shift+F8 循环遍历全部结果，跨页会自动切换。离开结果页查看源码后仍可使用 F8 继续；切回语义引用页则 F8 恢复遍历引用。
- 每页 300 项，支持翻页；历史保留本次会话最近 20 次查询。
- 搜索包括文件夹内未保存的编辑内容。源码或文件夹变化后标记过期，刷新后再跳转；跳转前还会校验原文，防止打开已移动的位置。
- 可取消扫描或发起新查询，旧查询不能覆盖新结果。遵循 `files.exclude` / `search.exclude` 中值为 true 的规则，并额外使用 `sourceInsightInspired.textLookupExclude`。

当前最多扫描 20000 个文件、保留 20000 处匹配，单文件上限 4 MiB、总读取上限 128 MiB。二进制 / 过大文件会跳过；读取失败、达到扫描或匹配上限会在状态栏明确提示，不能把这种结果视为完整召回。UTF-8 直接扫描，其他编码交给 VS Code 按文件编码读取。检索范围是工作区文件夹，不扫描工作区之外的目录。

本次用户 libbmc 样例检索 `bmc_timeout_ms` 得到 13 处匹配、2 个文件，逐项核对了原文及行列（历史验证数据）。

## 窗口联动

| 窗口 | 操作和行为 |
| --- | --- |
| 文件符号 | 默认显示头文件、宏、全局变量、结构体、枚举和函数；按名称过滤与排序，可切换仅函数 |
| Context | 自动跟随、候选选择、基础语法着色、上下浏览、独立预览历史、锁定和刷新 |
| Relation | 固定在 Context 右栏；双向一层横向图 / 多级树形列表可切换，保留调用位置、根节点锁定、查询缓存和底部工具栏 |
| Lookup Text | 工作区文件夹字符检索、独立 Search Results 结果页、源码高亮、函数与文件位置、历史、分页及 F8 遍历 |
| Lookup References | 编辑区结果标签页、顶部搜索框、按文件分组、源码片段、分页、筛选、查询历史 |

单击 Relation 函数节点只在 Context 预览对应调用现场；双击、按 Enter 或底部 ↗ 按钮在主编辑器打开函数定义；底部还提供查询引用、设为根、折叠与锁定操作。引用结果页点击直接打开源码，Alt+点击在 Context 预览。Context 锁定时，Enter 仍打开树中实际选中的位置，不会误开锁定的预览。

Context 与 Relation 分别锁定；锁定后自动事件不改变目标，刷新只更新原目标。Relation 切换方向保留已选定的根节点。源码编辑后，引用和关系标为可能过期；预览读取当前缓冲区，包括未保存内容，但原位置可能移动，需重新定位。

阅读历史记录插件跳转、文件切换和命令触发的编辑器选区跳转。普通光标移动不逐个入栈。Context 的前进、后退是独立的预览历史。

启用插件后会显示文件符号视图，替换辅助侧栏中当前选中的 Chat 视图，并尽量保留编辑器焦点；它的左右位置取决于主侧栏位置及你手动移动的结果。Chat 仍可手动切回。

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
| `sourceInsightInspired.layout` | `sourceInsight` | 首次设置底部面板；`preserve` 保留布局 |
| `sourceInsightInspired.explorerSide` | `preserve` | 主侧栏位置：`preserve` / `left` / `right`；工程文件和符号列表均可独立移动 |
| `sourceInsightInspired.autoPreview` | `true` | 自动预览 |
| `sourceInsightInspired.autoRelation` | `true` | Relation 自动跟随当前函数 |
| `sourceInsightInspired.contextMode` | `definition` | `definition` 智能定义（函数定义/结构体等对象类型）、`type` 强制类型定义、`enclosing` 包含函数 |
| `sourceInsightInspired.debounceMs` | `250` | 自动查询防抖间隔，毫秒 |
| `sourceInsightInspired.contextLines` | `20` | 目标上下预览行数 |
| `sourceInsightInspired.symbolSort` | `position` | 源码顺序或 `name` 名称排序 |
| `sourceInsightInspired.symbolKinds` | `all` | 全部符号，或 `functions` 仅函数及其容器 |
| `sourceInsightInspired.sourceInsightKeys` | `true` | 启用上述导航、查询快捷键 |
| `sourceInsightInspired.textLookupExclude` | 默认排除生成 / 依赖目录 | 文件夹字符检索额外排除规则 |
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

0.0.1 重置版本并通过代码检查与 VSIX 打包。旧 dist 安装包和测试产物已清理。本地 C 索引和早期横向图的历史验证见 [0.10.0 验证报告](docs/VALIDATION_0.10.0.md)，原始需求见 [开发计划](docs/DEVELOPMENT_PLAN.md)。

参考：[Source Insight 导航](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Symbol_Navigation_Commands.htm)、[前进后退](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Go_Back_and_Go_Forward_commands.htm)、[VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)、[LLVM 20 outgoing calls](https://releases.llvm.org/20.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html)。

Source Insight 安装目录、内置主题、帮助与界面资源分析见 [安装目录分析](docs/SOURCE_INSIGHT_INSTALLATION_ANALYSIS.md)。

## 同名符号黄色高亮与固定（0.10.15）

使用内置 Source Insight 主题时，VS Code 原生的选中文字匹配、符号读引用、写引用及文本同名匹配统一采用黄色背景与边框，自动跟随当前选择，不另加一套临时扫描。代码选区本身仍为浅暖黄底，保持宏和声明的深蓝字可读。需要开启 VS Code 的 `editor.selectionHighlight`；符号引用自动高亮还取决于语言服务及 `editor.occurrencesHighlight`。切换到其他 VS Code 主题时，原生临时高亮遵循该主题自己的颜色，固定高亮功能仍可用。

在主编辑器选中完整符号，或把光标放在符号上，按 **F2**，或 **Ctrl+Alt+H**（macOS：Cmd+Alt+H）。所有可见编辑器和 Context 中同名的完整符号会同步显示暖黄色背景、黑字与边框；切换文件、分栏和编辑源码后会更新。不依赖 clangd，按大小写精确匹配，包含注释与字符串；这是同名文字高亮，不区分不同作用域的同名变量。单个编辑器最多标记 20000 处。Context 中也可选中文字后按相同快捷键联动高亮。

再次对同一符号执行取消，选择新符号执行则替换。命令面板执行“Source Insight Inspired: 清除固定符号高亮”可随时清除。固定符号保存到当前工作区，重载 / 重新打开工作区后恢复；取消或清除也同步保存，不修改源码或主题设置。

0.10.14 默认使用 F2 高亮，F8 保持检索遍历。设置 `sourceInsightInspired.symbolHighlightUseF2 = false` 可恢复默认 F2 重命名；Ctrl+Alt+H、编辑器右键“固定 / 取消同名符号高亮”、命令面板及 Context 工具栏“高亮”按钮仍可用。执行后状态栏显示符号和当前可见编辑器中的匹配数量，并写入插件输出日志。

也可自行在“首选项：打开键盘快捷方式(JSON)”中配置：

```json
{
  "key": "f2",
  "command": "sourceInsightInspired.toggleSymbolHighlight",
  "when": "editorTextFocus"
}
```

该映射会在主编辑器覆盖 F2 原有重命名；也可将 key 改为 f8（覆盖结果遍历）。Context 也响应 F2（遵循上述开关）和 Ctrl+Alt+H。配色可通过 `sourceInsightInspired.symbolHighlight.background`、`foreground`、`border` 三个颜色 ID 自定义。
