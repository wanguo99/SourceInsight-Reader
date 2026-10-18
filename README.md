# Source Reader

Source Insight 风格的 VS Code 代码阅读插件，当前版本 **0.5.0**。围绕文件符号、Context、Relation 和 Lookup References，提供连续预览、符号浏览、调用追踪和阅读历史。

需要 VS Code **1.106 或更新版本**（用于右侧辅助侧栏注册）。同一份 VSIX 可用于 Windows 和 Linux，无需额外安装 Node.js 才能使用插件；C/C++ 语义能力需要 clangd 等语言服务。Windows 适配及回归用例已加入，**Windows 实机与实际 UI 验收仍待完成**。

## 安装

在 VS Code 扩展视图的菜单中选择“从 VSIX 安装”，选择 `dist/source-reader-0.5.0.vsix`。也可以在项目根目录运行：

```bash
code --install-extension dist/source-reader-0.5.0.vsix
```

打开源码工程，在命令面板运行 **Source Reader: 打开阅读工作台**，或通过命令面板聚焦文件符号。

文件管理直接使用原生 Explorer，插件不再提供文件树。文件符号默认显示在右侧辅助侧栏；底部 Source Reader 面板包含 Context 和 Relation，与 Terminal（终端）处于同一区域。Lookup References 在主编辑区打开独立结果标签页。可以右键视图标题移动视图、拖动分隔线调整大小；插件不会强行覆盖已有布局。

VS Code 以主侧栏在左侧的常规布局为基准。升级后若文件符号仍在左侧，将其标题拖到右侧辅助侧栏，或右键标题选择“移动视图”。插件保留视图 ID，因此已有位置可能被保留。

升级后若 Relation 仍在侧栏，可右键 Relation 标题，选择“移动视图”并将目标设为 Source Reader 的底部面板，或直接拖动标题到已有的 Context 区域。VS Code 会保留用户之前调整的位置。执行“Source Reader: 聚焦 Context”可显示底部阅读面板，再拖动视图边界调整排列和大小。

Windows 的 PowerShell 安装、clangd 路径、开发及验收步骤见 [Windows 使用指南](docs/WINDOWS.md)。

## 典型阅读流程

1. 使用原生 Explorer，或 `Alt+Shift+P` 查找工程文件。
2. 在文件符号定位函数，或 `Alt+Shift+S` 查找全局符号。全局查询复用语言服务索引，支持输入时更新与选择预览。
3. 将光标放在函数调用或变量上，Context 智能显示函数定义或变量的类型定义；也可切换到类型定义或包含函数模式。
4. 在 Context 中查看带基础语法着色的源码，使用“向上浏览 / 向下浏览”查看更多内容。点击其中的标识符可继续在 Context 内跳转，Shift+点击强制查看类型，工具栏 ← / → 或 Alt+, / Alt+. 返回/前进。点击“在主编辑器打开”打开预览位置；非符号区域双击或按 Enter 也可打开。
5. `Alt+=` 跳转到定义，`Alt+,` 返回，`Alt+.` 前进。定义有多个候选时先选择，不静默跳到第一个。
6. `Shift+F12` 为光标处符号在编辑区打开 Lookup References 结果页；顶部搜索框按文件路径或源码筛选，`Ctrl+F` 聚焦搜索框、Esc 清空、Enter 聚焦首个结果。点击结果或聚焦结果后按 Enter 跳到源码，Alt+点击在 Context 预览；支持刷新和历史查询。`F8 / Shift+F8` 循环预览筛选后的引用。
7. Relation 中查看“谁调用它 / 它调用谁”，逐层展开；同一调用边的多个调用位置单独保留。锁定根节点后可以继续阅读其他代码。

可以直接打开 `examples/cpp` 体验：`process_request` 调用 `leaf` 两次，`recurse` 展示递归，`main` 中有同名局部变量和函数指针示例。

## 窗口联动

| 窗口 | 操作和行为 |
| --- | --- |
| 文件符号 | 默认显示头文件、宏、全局变量、结构体、枚举和函数；按名称过滤与排序，可切换仅函数 |
| Context | 自动跟随、候选选择、基础语法着色、上下浏览、独立预览历史、锁定和刷新 |
| Relation | 两个调用方向、惰性展开、调用位置、递归标记、根节点锁定、查询缓存 |
| Lookup References | 编辑区结果标签页、顶部搜索框、按文件分组、源码片段、分页、筛选、查询历史 |

选择 Relation 节点只改变 Context，按 Enter 或右键“在主编辑器打开”才跳转。引用结果页点击直接打开源码，Alt+点击在 Context 预览。Context 锁定时，Enter 仍打开树中实际选中的位置，不会误开锁定的预览。

Context 与 Relation 分别锁定；锁定后自动事件不改变目标，刷新只更新原目标。Relation 切换方向保留已选定的根节点。源码编辑后，引用和关系标为可能过期；预览读取当前缓冲区，包括未保存内容，但原位置可能移动，需重新定位。

阅读历史记录插件跳转、文件切换和命令触发的编辑器选区跳转。普通光标移动不逐个入栈。Context 的前进、后退是独立的预览历史。

## Context 内连续阅读

默认“智能定义”模式优先保留函数本体；对于有类型定义结果的变量，优先展示其结构体、类或其他类型。函数返回结构体时仍展示函数定义，避免误跳到返回类型。普通定义和类型定义都由语言服务解析；普通定义不可用时尝试声明，多个候选需手动选择。强制类型模式无结果时会提示无结果，不以变量声明冒充类型定义。

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

前三个 Alt 导航键参考 Source Insight 的默认导航设计。其他键位为本插件的安排。设置 `sourceReader.sourceInsightKeys = false` 可关闭导航、查询和 F8 的默认绑定，恢复 VS Code 对应默认行为；树和 Context 内的 Enter 操作保留。所有动作也可以通过命令面板执行或重新绑定。

## C/C++ 配置

安装 clangd 可执行文件，以及 VS Code 的 `llvm-vs-code-extensions.vscode-clangd` 扩展。完整双向调用层次需要 **clangd 20+**；clangd 19 支持调用者查询，但没有 outgoing calls。

工程应提供正确的头文件、宏和编译参数，例如 `compile_commands.json` 或 `compile_flags.txt`。示例提供后者，也可在已配置构建工具链的终端生成编译数据库：

```bash
cmake -S examples/cpp -B examples/cpp/build -G Ninja
cmake --build examples/cpp/build
```

零结果可能表示没有匹配项、语言服务未就绪、工程配置不足或该能力不受支持。公开通用查询接口无法在所有情况下可靠区分这些状态；可以检查语言服务输出并手动刷新。

## 完整文件符号（0.3）

原“函数列表”更名为“文件符号”，默认显示全部符号。C/C++ 的结构体、联合体、枚举、变量和函数使用语言服务返回的层次结构；成员可展开查看。头文件包含、对象宏和函数宏由源码扫描补充，支持多行宏、CRLF 和未保存缓冲区，并与语言服务结果去重。每个条目显示类别，选择后可定位源码。

源码补充项不判断条件编译是否生效，因此 `#if 0` 内的包含和宏也可能显示；悬停会标明此限制。此列表显示当前文件的包含语句，不递归展开所包含头文件。全局变量、结构体等语义条目仍需 clangd 正确解析工程。

打开 `examples/c/outline.c` 可验证包含、宏、全局变量、结构体、typedef、枚举和函数。如果旧工作区仍只显示函数，在命令面板执行“Source Reader: 切换全部符号/仅函数”，或设置：

```json
"sourceReader.symbolKinds": "all"
```

## 配置项

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `sourceReader.autoPreview` | `true` | 自动预览 |
| `sourceReader.autoRelation` | `true` | Relation 自动跟随当前函数 |
| `sourceReader.contextMode` | `definition` | `definition` 智能定义（函数定义/变量类型）、`type` 强制类型定义、`enclosing` 包含函数 |
| `sourceReader.debounceMs` | `250` | 自动查询防抖间隔，毫秒 |
| `sourceReader.contextLines` | `20` | 目标上下预览行数 |
| `sourceReader.symbolSort` | `position` | 源码顺序或 `name` 名称排序 |
| `sourceReader.symbolKinds` | `all` | 全部符号，或 `functions` 仅函数及其容器 |
| `sourceReader.sourceInsightKeys` | `true` | 启用上述导航、查询快捷键 |
| `sourceReader.files.include` | `[]` | 文件包含 glob，空数组显示全部 |
| `sourceReader.files.exclude` | `.git`、`node_modules` | 额外排除 glob |

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

脚本检测 Windows 用户/系统版 VS Code 和常见 Linux/macOS 安装位置。可设置 `VSCODE_EXECUTABLE_PATH` 覆盖路径；Windows 应指向 `Code.exe`，不使用 `code.cmd`。`SOURCE_READER_EXTENSIONS_DIR` 可覆盖已安装扩展目录，`CLANGD_PATH` 可覆盖测试后端。

测试复制样例工程和 clangd 扩展到临时目录，不修改原工程，无需 Windows 符号链接权限。没有 Linux 显示环境时使用 Xvfb。可显式设置 `SOURCE_READER_DOWNLOAD_VSCODE=1`、`SOURCE_READER_INSTALL_CLANGD_EXTENSION=1`，允许脚本在缺少工具时下载测试用 VS Code 和安装 clangd 扩展。

已添加 Windows/Linux 检查和打包 CI，宿主任务需要手动启用 `run_host`。当前仓库尚未推送远端，CI 配置并未实际执行，不能视为 Windows 通过记录。

## 与 Source Insight 的差异

- 文件、符号和调用关系复用语言服务；没有独立的 Source Insight 式全工程解析数据库，准确性和准备时间依赖后端与工程配置。
- VS Code 的停靠与布局受平台控制，支持手动调整，不能完全复刻 Source Insight 的窗口布局。
- Context 为只读预览，使用基础词法着色；支持 C/C++、JS/TS、JSON，其他语言保留纯文本。不等于完整 TextMate/语义高亮，最多回看 400 行恢复跨行状态，超长单行保留纯文本。
- 暂未实现浏览器只读编辑模式、类型继承树、图形调用图和多个固定关系实例。
- 引用还未按所在函数二次分组；结果标签页每文件初始展示 200 项，可加载更多。工程文件搜索最多扫描 10000 项，全局符号最多展示 1000 项，并提示上限。
- 公开语言命令的逻辑取消通过丢弃过期结果实现，不保证终止底层计算。
- 编辑后锁定位置不做精确变换；函数指针和动态分派关系不保证完整。
- Windows 大小写敏感目录、Remote/WSL、大型工程性能和最低 VS Code 1.106 实机尚未验收。

验证状态见 [0.5 验证报告](docs/VALIDATION_0.5.md)，原始需求见 [开发计划](docs/DEVELOPMENT_PLAN.md)。

参考：[Source Insight 导航](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Symbol_Navigation_Commands.htm)、[前进后退](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Go_Back_and_Go_Forward_commands.htm)、[VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)、[LLVM 20 outgoing calls](https://releases.llvm.org/20.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html)。
