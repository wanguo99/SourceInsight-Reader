# Source Reader

Source Insight 风格的 VS Code 代码阅读插件，当前版本为 **0.1.0 初版**。提供文件树、函数列表、Context、Relation 和 Lookup References，复用已安装的语言服务。

## 安装与试用

从本项目打包后，在普通终端执行：

```bash
cd /home/guohao/vscode-plugin/source-reader
code --install-extension dist/source-reader-0.1.0.vsix
code examples/cpp
```

在 VS Code 命令面板运行 **Source Reader: 打开阅读工作台**。也可以点击活动栏的书本图标，打开侧栏。

默认布局：侧栏包含文件树、函数列表和 Relation；底部 Source Reader 面板包含 Context 和 Lookup References。可使用 VS Code 的移动视图功能调整位置。

### C/C++ 语言后端

安装 clangd 可执行文件和 `llvm-vs-code-extensions.vscode-clangd` 扩展。**完整的双向调用层次需要 clangd 20 或更新版本**。clangd 19 已实测支持符号、定义、类型定义、调用者和引用，但不实现 outgoing calls。

如果安装了多个版本，可在工作区配置实际使用的路径，例如：

```json
{
  "clangd.path": "/path/to/clangd",
  "clangd.checkUpdates": false
}
```

使用自己的工程时，需要为 clangd 配置头文件路径、宏和编译参数。示例工程提供 `compile_flags.txt`，也可使用 CMake 生成编译数据库：

```bash
cmake -S examples/cpp -B examples/cpp/build -G Ninja
cmake --build examples/cpp/build
```

遇到无结果时，先确认语言服务已启动，再使用对应窗口的刷新命令。插件不能通过公开的通用查询接口可靠区分“确实没有结果”“后端未就绪”和所有“不支持”情况，提示会保留这一不确定性。

## 五项核心功能

| 窗口 | 初版操作 |
| --- | --- |
| 文件树 | 展开目录，单击文件在主编辑器打开；右键可在 Context 预览；支持包含、排除配置 |
| 函数列表 | 跟随主文件，保留类和命名空间层级；单击定位；工具栏筛选，菜单切换排序 |
| Context | 光标停留后预览定义；支持多个候选、类型定义、锁定、刷新、预览历史及打开目标 |
| Relation | 查看“谁调用它”“它调用谁”；逐层展开；查看同一调用边的多个现场；可锁定根节点 |
| Lookup References | 从编辑器或符号右键查询；按文件分组；展开文件查看行列和源码片段；选择结果预览现场 |

Relation 和引用结果中，选择节点只改变 Context。右键“在主编辑器打开”，或点击 Context 中同名按钮，才会跳转主阅读位置。预览区域支持选择和复制文本。

Context 与 Relation 分别锁定。锁定后，光标移动、选择其他节点不会改变锁定目标；刷新只更新原目标。Relation 切换调用方向保留根节点。源码变化后，引用和关系标记为可能过期，需要刷新；预览会读取未保存缓冲区，但原位置可能已移动，因此也会提示位置可能过期。

主阅读位置支持以下命令：

- `Source Reader: 阅读位置后退`
- `Source Reader: 阅读位置前进`

可在键盘快捷方式设置中自行绑定。Context 中的前进、后退只作用于预览历史。

### 建议体验路径

1. 打开 `examples/cpp/reader.cpp`，在函数列表选择 `process_request`。
2. 将光标放在 `leaf` 调用上，在 Context 查看定义。
3. 对 `leaf` 执行 Lookup References，展开文件并选择引用，观察 Context 中的调用现场。
4. 在函数列表对 `leaf` 执行“设为 Relation 根节点”，查看 `process_request` 调用它的两个位置。
5. 锁定 Relation，再移动主编辑器光标，确认关系根节点保持不变。
6. 对 `recurse` 展开关系，查看递归终止标记。

## 配置

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `sourceReader.autoPreview` | `true` | 光标停留时自动查询定义 |
| `sourceReader.autoRelation` | `true` | 未锁定的 Relation 跟随包含光标的函数 |
| `sourceReader.debounceMs` | `250` | 自动查询防抖间隔，毫秒 |
| `sourceReader.contextLines` | `20` | 目标行上下的预览行数 |
| `sourceReader.symbolSort` | `position` | 源码顺序或 `name` 名称排序 |
| `sourceReader.files.include` | `[]` | 文件包含 glob；空数组显示所有文件 |
| `sourceReader.files.exclude` | `.git`、`node_modules` | 额外排除 glob |

文件树还遵循当前资源配置中 `files.exclude` 值为 `true` 的条目。初版 glob 支持 `*`、`?`、`**`，暂不支持花括号展开、`when` 条件、`.gitignore` 或 `search.exclude` 联动；符号链接不进入文件树。

## 开发与验证

开发环境：Node.js 22、npm、VS Code；真实 C/C++ 语义测试还需 clangd。

```bash
npm ci
npm run check
npm test
npm run package
```

- `check`：JavaScript 语法、扩展入口、命令注册及 TypeScript 对 JavaScript 的静态检查。
- `test`：纯逻辑、模拟 VS Code 的控制器/窗口行为，以及通过标准输入输出访问真实 clangd 的语义测试。旧版 clangd 不支持的 outgoing 测试明确跳过。
- `package`：使用官方 `@vscode/vsce` 生成 `dist/source-reader-0.1.0.vsix`，不发布到 Marketplace。

首版采用带静态检查的 CommonJS JavaScript，直接加载源码，无需编译输出；与需求文档建议的 TypeScript 源码方案存在这一实现选择差异，后续可按模块迁移。

在 VS Code 中打开本目录，按 F5 选择“运行 Source Reader”即可启动开发宿主。

### 扩展宿主集成测试

```bash
npm run test:host
```

默认使用 Linux 已安装的 `/usr/share/code/code` 和 `~/.vscode/extensions` 中的 clangd 扩展。可以通过以下变量调整：

- `VSCODE_EXECUTABLE_PATH`：VS Code 的 Electron 可执行文件路径。
- `SOURCE_READER_EXTENSIONS_DIR`：已安装扩展目录。
- `CLANGD_PATH`：仅用于标准输入输出语义测试的 clangd 路径；宿主使用 `clangd.path` 设置。

无 `DISPLAY` 时，测试脚本通过 `xvfb-run` 启动虚拟显示，需安装 Xvfb。测试使用临时用户数据和扩展目录，并保留日志路径。宿主测试会短暂修改示例工程的自动跟随配置及缓冲区，结束时恢复；请在没有用户编辑的示例工作区运行。

当前受限开发环境中的 Electron 启动被操作系统以 `Operation not permitted` 终止，因此**扩展宿主和实际界面尚未验收通过**。逻辑测试及真实 clangd 协议测试不能替代这部分验证。

## 当前边界

- Context 显示带行号与目标高亮的只读纯文本，暂不提供语法着色。
- 初版提供调用树，不包含类型继承树、图形调用图和多个固定关系实例。
- 函数列表当前只显示函数及其容器，其他符号分类开关尚未提供。
- 引用列表尚未提供文本过滤、查询历史及按所在函数二次分组；每个文件先显示 200 项，可继续加载。
- 通用公开命令的取消采用丢弃过期结果；不保证中断底层语言服务计算。
- 编辑后锁定目标不做精确位置变换，提示可能过期，应重新定位符号。
- 主导航历史只记录插件发起的跳转及其起点；不会替代 VS Code 的完整编辑器历史。
- 文件树可展示多个工作区根，但跨平台、多根语义、Remote/WSL 和大型工程性能尚未验收。
- 静态调用关系受后端限制，函数指针和动态分派不保证完整。

完整需求及后续阶段见 [开发需求与计划](docs/DEVELOPMENT_PLAN.md)，本次验证记录见 [初版验证报告](docs/VALIDATION.md)。

设计与兼容参考：[Source Insight Context](https://www.sourceinsight.com/doc/v4/userguide/Manual/Command_Reference/Context_Window_Options.htm)、[Source Insight Relation](https://www.sourceinsight.com/doc/v4/userguide/Manual/Concepts/Relation_Window.htm)、[VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)、[LLVM 20 发布说明：新增 outgoing calls](https://releases.llvm.org/20.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html)。
