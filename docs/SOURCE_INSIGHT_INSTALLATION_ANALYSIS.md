# Source Insight 安装目录分析与插件参考

分析日期：2026-10-19。参考目录：`/home/guohao/vscode-plugin/Source Insight 4.0`；另结合用户提供的 `SourceInsight_Configuration.xml` 和 `SourceInsight_layout.png`。

结论：安装目录没有公开的编辑器源码或网页 UI，但有完整的主题 XML、CHM 用户手册、代码片段、语言定义、事件宏示例，以及主程序内嵌的图标资源，足以进一步核对阅读行为和界面层次。当前最有价值的不是直接复用位图，而是主题字段、样式继承、符号分类和帮助中定义的交互规则。

## 1. 目录清单

目录共 35 个文件，约 19.3 MiB。这里只记录与代码阅读和界面参考有关的内容，不展开授权文件内容。

| 文件/目录 | 实际内容 | 对本插件的价值 |
| --- | --- | --- |
| `sourceinsight4.exe` | Windows PE32 GUI 程序，版本资源为 4.0.84.0 | 核对版本与图标分类；不是源码 |
| `sourceinsight.chm` | 编译 HTML 用户手册，含窗口、选项、命令、主题、布局等章节 | 核对 Context、Relation、符号窗口的正式行为 |
| `themes/default.themes.xml` | 15 套视觉主题，根版本 AppVer 4.00.0078 | 区分编辑区、窗口框架、列表、语法样式及继承关系 |
| `snippets/default.snippets.xml` | 14 个代码片段 | 后续 VS Code snippets 的功能设计参考 |
| `languages/` | 18 个 `.CLF` / `.xclf` 语言定义文件 | 文件类型、关键字、注释、正则解析规则等参考 |
| `c.tom` | C/C++ Token Macros，在 SI 解析前处理部分宏 | 解释 SI 与 clangd 对宏和不完整工程的处理差异 |
| `FileAlias.txt` | 文件名到文件类型别名的映射，例如无扩展名标准库头文件映射为头文件类型 | 对应 VS Code 文件关联设置的设计参考 |
| `utils.em` | 编辑宏示例，例如插入当前符号说明 | 后续辅助编辑命令参考 |
| `eventsample.em` | 应用、文件、编辑器等事件处理宏示例 | 对应扩展激活、编辑器变化和文档事件模型 |
| `StdConst.bas` | 常量定义文本 | 辅助解析材料，与当前主题布局关系较小 |
| `sidiff.exe`、`sihook4.exe`、`reflector*` | Windows 可执行或 Java/.NET 辅助组件 | 此轮仅识别类型；未运行，也不作为插件运行依赖 |
| 文档快捷方式、EULA 等 | 安装与说明文件 | 不参与界面实现 |

安装目录未发现可以直接用于 VS Code 的 CSS、React 源码、布局组件或插件 API。CHM 中的 HTML/CSS 是帮助页面，不是主编辑器的 UI 实现。

## 2. 主题文件

内置主题名称：Black、Bronze、Cocoa、Dark Blue、Dark Gold、Light Blue、Light Green、Lime、Minty、Olive、Sandstone、Silver Blue、Grasshopper、Styles for use with dark backgrounds、Wheat。

其中“Styles for use with dark backgrounds”不是完整界面配色，只包含部分样式；后续若做主题导入，不能把每个 Theme 都假设为完整配置。

主题文件包含独立的 DisplayColors、DisplayPreferences、SymbolPane、Context、Relation 等设置，也包含 Styles 及 ParentStyle 继承。由此可以确认：

- 代码背景、窗口框架、符号列表背景本来就可以不同，不应该只用一个背景色覆盖所有窗口。
- 截图里的配色不是把内置 Light Green 简单套用到整个界面。用户配置明确指定代码背景 `#e6ffe3`、符号列表背景 `#c5d2de`、框架背景 `#dbe2ea`。
- Light Green 内置主题本身的代码背景是白色，框架偏绿色；这与用户截图的自定义组合不同。
- “声明”“引用”“函数引用”“全局变量引用”等样式有继承关系。VS Code 主编辑器需要通过 TextMate 与语义修饰符映射，Context 的基础词法不能假装具备完整语义能力。

当前 0.7 的目标因此是：浅灰标题/标签/工具栏、灰蓝符号与文件列表、浅绿代码、灰色面板空白。活动列表项使用截图近似的蓝底白字。

## 3. 帮助手册中确认的关键交互

选择性提取了 CHM 的以下章节到临时目录分析，未将整本手册复制进插件：

- `Manual/Window Tour/Symbol_Windows.htm`
- `Manual/Window Tour/Toolbars.htm`
- `Manual/Concepts/Context_window1.htm`
- `Manual/Command Reference/Context_Window_Options.htm`
- `Manual/Concepts/Relation_Window.htm`
- `Manual/Command Reference/Relation_Window_Options.htm`
- `Manual/Concepts/Visual_Themes.htm`
- `Manual/Concepts/Saving_Window_Arrangements_with_Layouts.htm`
- `Manual/Command Reference/Window_Tab_Options.htm`

### 符号列表

手册描述的是当前文件的全部符号，包括函数、结构体、类、宏和常量；支持成员展开、枚举值、局部定义、类别过滤和排序。底部有小工具栏。较长函数和数据结构可以使用粗体强调；还可以表示条件编译层级。

当前插件已有全部符号、成员层次、预处理补充和排序。尚未实现条件编译层级、按相对函数长度加粗、局部定义稳定提取和自定义底部工具栏。原生 TreeView 不提供任意底部工具栏插槽；若以后要求完全同款，需要设计 Webview 符号树并补齐键盘及无障碍能力，而不是只改主题。

### Context

函数调用应显示函数定义；数据结构变量可以解码到其基础结构体、联合体或类。帮助中的“base types”针对数据结构，不表示所有变量都应该跳到 `size_t` 等标量 typedef。这与 0.5.1 收窄智能类型跟随的修复一致。

Context 还有多候选/首候选、锁定、跟踪光标符号或包含函数、是否跟踪注释/字符串等选项。当前插件保留多候选选择，不会为了模仿首候选模式而静默选择可能错误的定义。

### Relation

SI 的 Relation 不只是调用树，还能按符号类别显示引用、继承、结构成员等。可以控制自动展开层数、重复分支、调用点分组、列、过滤和多个关系窗口。当前插件主要提供双向函数调用与递归处理；不应把现有调用树描述成已完整实现 SI 的关系系统。

### 布局和按钮

手册确认布局可保存，符号窗口下方有排序工具栏。用户 XML 的 `PanelToolbarBottom="1"` 与截图的底部按钮一致。因此 0.7 将可控的 Context 工具栏移到底部，将原生窗口标题操作精简到必要按钮和菜单。

用户最终选择左符号、右原生 Explorer。插件使用 VS Code 主侧栏放右、辅助侧栏放左实现，底部面板置下并横跨工作区；不新增自定义文件管理器。初次应用后保留手动调整，并提供重应用/恢复原侧栏设置的命令。

## 4. 主程序内嵌图标资源

使用 7-Zip 只读枚举 PE 资源，得到：200 个 BITMAP、46 个 ICON、25 个 CURSOR、15 个图标组、17 个光标组，以及版本和 manifest 资源。

部分位图以功能命名，如 MACRO、MEMBER、METHOD、NAMESPACE、PREPROC、PROTO、STRUCT、TYPEDEF、UNION；还存在名为 ICONCONTEXT 的图标组。这说明 SI 的符号图标是按语义类别系统化区分的，可用于检查我们是否遗漏类别，而不是只给所有符号使用同一个函数图标。

枚举中未出现标准 MENU、DIALOG、STRINGTABLE 分组，所以不能声称已经获得可直接重建窗口的完整菜单/对话框模板。当前分析未反汇编程序、未运行 EXE、未读取授权内容，也未将原始位图、图标、帮助或可执行文件打包进插件；本插件继续使用自有或 VS Code 原生图标。

## 5. 文件格式与可移植性

安装目录中的默认主题和片段 XML 可以直接解析；用户提供的总配置则有 Markdown 外壳，并含 1 个 XML 1.0 不允许的 U+0014 控制字符。只在内存中去掉外壳与非法控制字符后可以完整解析。没有改动原文件。

这意味着未来做通用导入时，需要可解释的清理、校验和预览步骤，不能假设扩展名为 `.xml` 就可无条件整份套用。主题、快捷键、文件类型、布局和宏也必须分开映射。

C Token Macros、CLF 和 SI 宏脚本不是 clangd 配置或 VS Code 扩展代码，不能直接执行或照搬。尤其不能用宽松文本索引掩盖真实缺失头文件的工程配置问题；libbmc 的错误跳转仍应通过正确编译数据库解决。

## 6. 对后续开发的优先级建议

| 优先级 | 参考点 | 当前处理 |
| --- | --- | --- |
| 当前交付 | 截图的区域颜色、左符号/右 Explorer、Context 底部按钮 | 0.7 已实现可公开控制部分，原生界面位置限制明确说明 |
| 优先 | 符号树内联筛选、分类过滤、展开状态、底部工具栏 | 可进一步评估自定义 Webview 符号树；保留原生树的稳定性和键盘体验作为对照 |
| 优先 | Context 的跟踪规则、数据结构类型与多候选 | 延续已有修复，以真实语言服务测试验证 |
| 后续 | Relation 按类别显示引用、类型、继承 | 属于新关系模型，不是简单主题改动 |
| 后续 | 从主题 XML 选择性导入不同配色 | 解析继承与缺省字段后再生成 VS Code 主题，不导入整份个人设置 |
| 后续 | 代码片段、无扩展名头文件关联 | 可使用 VS Code snippets / files.associations，按用户实际需求增加 |
| 暂不纳入 | 复刻 Windows 原生菜单、任意停靠、位图按钮和全部宏引擎 | 与 VS Code 公开扩展模型差异较大，无需捆绑原程序 |

该分析以实际提供的文件为证据；可复制的是交互模型与配置映射方法，不等于获得了 SI 的源码或解析数据库实现。
