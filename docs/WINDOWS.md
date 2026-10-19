# Windows 安装、开发与验收

目标平台为 Windows 10/11 上的 VS Code 桌面版。0.2.0 已实现 Windows 路径和工具适配，使用通用 VSIX。当前开发环境为 Debian，**没有 Windows 实机通过记录**；本指南同时提供可复现的验收步骤。

## 1. 安装运行工具

仅使用本地 C 调用关系时，只需安装 VS Code 1.106+，WASM 运行时已打包，无需额外 Node.js、LLVM 或编译器。需要完整类型、引用和 C++ 语义时再安装以下工具。已有 VS Code 和 clangd 20+ 时可跳过安装。在 PowerShell 中，可以使用 winget：

```powershell
winget install --id Microsoft.VisualStudioCode --exact
winget install --id LLVM.LLVM --exact
```

也可使用 [VS Code 官方安装包](https://code.visualstudio.com/docs/setup/windows) 和 [clangd 官方安装说明](https://clangd.llvm.org/installation) 中的 LLVM/clangd 包。安装程序可能要求管理员权限；插件本身不需要管理员权限。

关闭并重新打开终端和 VS Code，检查：

```powershell
code --version
& 'C:\Program Files\LLVM\bin\clangd.exe' --version
code --install-extension llvm-vs-code-extensions.vscode-clangd
```

LLVM 安装位置不同则使用实际路径。只有语言服务模式需要 clangd 20 或更新版本才能提供“它调用谁”；本地 C 模式不受该版本限制。

建议在工作区 `.vscode/settings.json` 中明确配置：

```json
{
  "clangd.path": "C:\\Program Files\\LLVM\\bin\\clangd.exe",
  "clangd.checkUpdates": false
}
```

若同时启用了微软 C/C++ 语义引擎和 clangd，按项目需要选择其中一种，避免多后端重复返回。此版本的实测语义基线是 clangd，尚未验收微软 C/C++ 后端。

## 2. 安装插件

将生成的 `source-insight-inspired-0.10.7.vsix` 复制到 Windows。VS Code 扩展视图菜单选择“从 VSIX 安装”，或运行：

```powershell
code --install-extension '.\source-insight-inspired-0.10.7.vsix'
```

用户只安装 VSIX 即可，不需要 npm、Python、Linux 环境或自行编译。

打开 C/C++ 工程，运行 **Source Insight Inspired: 打开阅读工作台**。若安装后窗口仍使用旧扩展，执行 VS Code 的“开发人员: 重新加载窗口”。

## 3. C/C++ 工程配置

- 推荐为工程提供 `compile_commands.json`，包含真实宏、头文件目录和编译选项。
- 编译数据库应使用 Windows 上有效的路径，不能直接使用 Linux 的 `/home/...` 路径。
- MSVC 工程需要正确的工具链和标准库配置；生成编译数据库时使用已经初始化工具链的开发者终端。
- 本仓库示例只依赖少量 C++ 基础语法，提供 `compile_flags.txt`，可先用它区分插件问题与工程工具链问题。
- Windows 常见的 CRLF、盘符大小写、中文与空格路径和 UNC 资源标识已加入逻辑测试；UNC 共享连接和权限仍由 Windows/VS Code 管理。

## 4. 从源码开发

将整个 `source-insight-inspired` Git 仓库复制或克隆到 Windows，例如 `C:\work\source-insight-inspired`。安装 Node.js 22 后，在 PowerShell 运行：

```powershell
Set-Location 'C:\work\source-insight-inspired'
npm ci
npm run check
npm run test:unit
$env:CLANGD_PATH = 'C:\Program Files\LLVM\bin\clangd.exe'
npm run test:clangd
npm run package
```

如果 PowerShell 的执行策略阻止 `npm.ps1`，将命令写为 `npm.cmd ci`、`npm.cmd run check` 等，无需为了本项目修改全局执行策略。

F5 选择“运行 Source Insight Inspired”启动开发宿主。宿主集成测试可运行：

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
$env:CLANGD_PATH = 'C:\Program Files\LLVM\bin\clangd.exe'
npm run test:host
```

系统版 VS Code 则将路径改为 `C:\Program Files\Microsoft VS Code\Code.exe`；通常脚本会自动检测，无需设置。ZIP/便携版应显式设置 Electron 可执行文件路径。

扩展目录默认是 `$HOME\.vscode\extensions`。如果不同：

```powershell
$env:SOURCE_INSIGHT_INSPIRED_EXTENSIONS_DIR = 'D:\VSCodeData\extensions'
```

测试会把 clangd 扩展和样例复制到临时目录，使用独立用户配置，不依赖 Windows 开发者模式、符号链接权限或修改原工程。

没有 VS Code 或 clangd 扩展时，可显式允许测试工具下载：

```powershell
$env:SOURCE_INSIGHT_INSPIRED_DOWNLOAD_VSCODE = '1'
$env:SOURCE_INSIGHT_INSPIRED_INSTALL_CLANGD_EXTENSION = '1'
npm run test:host
```

该开关不会安装 clangd 后端本身，仍需有效的 `CLANGD_PATH` 或 PATH。

## 5. Source Insight 风格使用

0.10.5 起，首次启用将符号列表从 Explorer 中移出，在左侧提供与 Explorer 同级的独立入口；点击文件符号后只显示符号列表，独立“工程文件”窗口放到右侧，之后保留手动移动。`sourceInsightInspired.layout = preserve` 时跳过迁移。工程文件保留内嵌输入框，下方按 Explorer 的行高、缩进、箭头、选中颜色及当前文件图标主题显示目录树；输入 `src\bmc catlg` 等路径 / 文件名会直接过滤树并保留父目录，Esc 清空恢复普通树。点击文件或 Enter 打开，切换编辑器会同步选中；标题栏按钮刷新。此窗口可独立移动到左侧或右侧。

需要 VS Code 1.106+。Context / Relation 是一个底部视图，内部固定 Context 左、Relation 右，与 Terminal 同一区域。Lookup References 在编辑区打开结果标签页。升级后请重新加载窗口，旧独立 Relation 视图会移除；直接拖中间分隔线调整内部宽度，无需拖动窗口标题。

- `Alt+=` 跳到定义，`Alt+,` 返回，`Alt+.` 前进。
- `Shift+F12` 查询引用，`F8 / Shift+F8` 逐个预览当前筛选结果。
- Relation 单击函数节点只在 Context 预览对应调用现场，双击或 Enter 在主编辑器打开函数定义；引用结果点击或 Enter 打开源码，Alt+点击预览；Context 内点击符号继续跳转，Shift+点击查看类型；“在主编辑器打开”按钮打开当前预览位置。
- 用 Context 模式菜单选择“类型定义”查看变量结构，或“包含函数”持续看当前函数签名。
- 固定调用分析时锁定 Relation；固定某段源码时锁定 Context，两者独立。
- 右键视图标题移动窗口，拖动边界调整大小。VS Code 不提供完整的 Source Insight 窗口布局复刻能力。
- 若键位与现有习惯冲突，关闭 `sourceInsightInspired.sourceInsightKeys` 并自行绑定需要的命令。

首次启用会自动保存原主题配置并应用 Source Insight 主题。执行 **Source Insight Inspired: 恢复原主题** 可一键还原，或将 `sourceInsightInspired.appearance` 设为 `vscode`；重载后保留恢复状态。主题也可通过 **Source Insight Inspired: 选择阅读主题** 切换。选择 Source Insight 后应看到浅绿编辑区、紫色注释、红色数字；选择 VS Code 主题应恢复原主题。字体保持现有设置，不依赖 Windows 专用字体。

执行“Source Insight Inspired: 应用 Source Insight 布局”可重新应用底部面板及你配置的侧栏设置，默认不改变左右位置；`sourceInsightInspired.explorerSide` 可设为 `preserve`（默认）、`left` 或 `right`；“恢复原侧栏位置”恢复原侧栏设置。`sourceInsightInspired.layout = preserve` 时不自动改变位置。文件符号提供独立文件标签栏与常驻搜索框，标题操作菜单位置仍受 VS Code 控制；Context 和 Relation 工具栏均在分栏底部。

## 6. 验收清单

- [ ] 在带中文和空格的本地目录打开样例工程。
- [ ] 工程文件树支持展开、折叠、路径模糊过滤、清空恢复及打开文件；文件标签随主文件更新，搜索框支持即时筛选及清空，排序、折叠和定位正常。
- [ ] 打开 `examples/c/outline.c`，可见包含、宏、全局变量、结构体、枚举和函数，展开结构体能看到成员。
- [ ] 全局符号查询能找到 `leaf`，选择时预览，Enter 后打开主编辑器。
- [ ] Context 显示着色、行号、目标高亮；上下浏览、锁定和刷新正确。
- [ ] 启用插件后辅助侧栏显示文件符号，保留原有左右位置，可手动切回 Chat。
- [ ] 标量数组如 `bmc_epdu_first` 定位数组定义，Shift+点击才查看 `size_t`。
- [ ] Context 代码区域鼠标后退/前进侧键使用独立预览历史。
- [ ] 函数调用定位函数本体，结构体变量定位类型；Context 内点击继续跳转，Shift+点击查类型，后退/前进正确。
- [ ] Relation 能看到 `process_request` 调用 `leaf` 的两个位置，位置属于调用者文件。
- [ ] 关闭 clangd 后，C 的本地 incoming/outgoing 和调用点跳转正常，缓存重启后恢复。
- [ ] 语言服务模式下使用 clangd 20+ 验证 outgoing，切换方向后根节点保持不变。
- [ ] `recurse` 的递归路径停止展开。
- [ ] Shift+F12 在编辑区打开引用结果标签页，Ctrl+F 聚焦顶部筛选框；支持路径/源码筛选、历史、分页和 F8 前后浏览。
- [ ] 工程文件树与文件符号支持左右位置调整，重载后保留；底部 Context / Relation 始终内部左右排列；拖动分隔线后重载可保留比例。
- [ ] 符号名前的头文件、宏、结构体、函数、变量、成员图标不同，搜索和展开后图标仍正确。
- [ ] 文件符号与 Explorer 在左侧同级独立切换；右侧工程文件保留内嵌搜索并跟随文件图标主题。
- [ ] Context 的 C 类型、宏、成员、数字、字符串与多行注释着色，长注释中间开始的预览颜色正确。
- [ ] Context 定义/文件信息位于标题行，不额外占一行；多候选下拉正常。
- [ ] Relation 默认左调用者、中当前函数、右调用函数；两侧只显示一层，调用点可选择预览。
- [ ] 底部“视图”切换树形列表后可多级展开，切换不改变根节点和锁定状态；点击预览、双击/Enter 打开、键盘操作正确。
- [ ] Context 锁定在 A 时，从关系树按 Enter 打开 B，不会误开 A。
- [ ] Alt 导航可以返回插件跳转、文件切换和命令型选区跳转的起点。
- [ ] Source Insight 主题与 VS Code 原主题可切换，重载后仍可恢复原主题；标题/标签栏浅灰、Explorer/文件符号列表灰蓝、代码浅绿，Context 底部按钮可用。
- [ ] 深浅主题、键盘焦点、多个编辑器分栏和中文源码显示正常。
- [ ] 修改但不保存源码后，预览更新，引用和关系显示过期状态。
- [ ] `npm run test:host` 成功，报告 `dist/host-results.json` 中 `completed` 为 `true`。

以上清单尚未在 Windows 实机勾选完成。跨平台 CI 配置位于 `.github/workflows/ci.yml`，宿主测试需手动启用 `run_host`；新增配置尚未触发远端运行。
