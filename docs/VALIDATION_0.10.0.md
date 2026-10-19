# 0.10.0：Relation 横向关系图验证

日期：2026-10-19。

## 功能与范围

默认 `sourceInsightReader.relationView = horizontalGraph`，同一 Relation 窗口按左至右显示直接调用者、当前函数、直接调用函数。两侧只查询一层，不加载孙级。原多级树形列表通过 `outline` 保留，底部“视图”和选择显示方式命令可以立即切换，保持根节点与锁定状态。

节点支持单击 Context 预览、双击 / Enter 打开、调用点选择预览、底部设为根。图使用 SVG 连线和原生按钮，名称以文本节点渲染；文件位置和完整名称可悬停查看。每侧最多 200 项，超过时提示切换列表。最小图宽 560 像素，支持双向滚动；初次定位当前函数，标题保持可见。

## 自动验证

`npm run check` 通过。完整 `npm test` 共 80 项，79 通过、1 跳过；跳过项为 clangd 19 不支持的 outgoing 查询，本地 C 索引的两个方向均通过。日志：`dist/tests-0.10.0.log`。

新增覆盖：

- 同时查询 incoming/outgoing，只查询直接相邻函数，保留调用点。
- 某一侧查询失败时另一侧仍显示，旧根节点的异步结果被丢弃。
- 图与 Outline 切换、配置命令保存、锁定根节点保持。
- 每侧超过 200 项的限制、窄窗口布局、多调用者布局与左右连线方向。
- 实际渲染脚本的图节点、SVG 连线、文本安全、预览、打开、调用点、键盘操作和切回列表。
- 用户 libbmc 样例经后台 Worker → LanguageAdapter → RelationTree → RelationPane 的完整数据链路：`bmc_string_copy_nullable` 图中有 29 个直接调用者、1 个直接调用函数 `bmc_string_copy_impl`、66 处调用位置。无需启动 clangd。

## 验收边界

本机为 Linux，测试采用真实 Tree-sitter/WASM、后台 Worker 与 VS Code API / DOM 替身，未运行 Windows 实机或真实 Electron UI 验收。布局滚动、主题颜色、不同 DPI 和鼠标交互仍需实机确认。原本地索引的条件编译、宏展开、间接调用等边界见 [0.9.0 报告](VALIDATION_0.9.0.md)。
