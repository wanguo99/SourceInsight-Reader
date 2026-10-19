# 0.1.0 初版验证报告

日期：2026-10-18。

## 环境

- Debian 13，x86_64。
- Node.js 22.23.3，npm 10.9.9。
- VS Code CLI 1.142.0。
- Debian clangd 19.1.7。
- VS Code clangd 扩展已安装。

## 已完成验证

`npm run check`：通过源码语法、入口、所有声明命令注册检查，以及基于 VS Code 1.85 类型定义的 JavaScript 静态检查。

`g++ -std=c++17 -fsyntax-only examples/cpp/main.cpp examples/cpp/reader.cpp`：通过示例工程语法检查。

`npm run package`：已通过官方 vsce 工具生成 `dist/source-insight-inspired-0.1.0.vsix`；仅本地打包，未发布。

`npm test`：18 项通过，1 项跳过，0 项失败。包含：

- 请求版本隔离、定义位置归一化、引用去重与同一行多个位置。
- 层级和扁平符号、重载区分、函数过滤与显示父节点。
- 调用位置属于调用者文件，路径内递归检测。
- 有界导航历史、前进分支截断、文件过滤。
- 模拟 VS Code 下的 Context 锁定、刷新、候选选择、未保存内容、失败清空和乱序请求。
- 模拟 VS Code 下的函数列表和引用会话隔离、Relation 锁定及过期查询丢弃、主阅读导航和预览分离。
- 真实 clangd 标准输入输出协议：函数符号、定义、类型定义、调用者、同一调用者两个现场、递归关系、引用与同名局部变量作用域。

被跳过的唯一测试为真实 clangd 的 outgoing calls。clangd 19 返回 `-32601 method not found`；LLVM 20 官方发布说明确认该能力从 20 开始提供。插件已实现通用 outgoing 调用入口及结果处理，归一化逻辑已测试，但当前环境中该方向未完成真实后端验收。

## 尚未完成的验证

`npm run test:host` 已尝试启动，但 Electron 在进入测试前因当前环境限制退出：

```text
FATAL:content/browser/sandbox_host_linux.cc:41
shutdown: Operation not permitted (1)
SIGTRAP
```

这不是宿主测试通过。五个视图的真实布局、渲染、主题、焦点和键盘操作，需要在普通终端运行宿主测试并人工确认。测试脚本会输出临时日志目录，成功后生成 `dist/host-results.json`。

还未验收：clangd 20+ 的 outgoing、微软 C/C++ 后端、最低 VS Code 1.85 实机、多根语义、Remote/WSL、大工程性能及 P95 响应指标。

## 对开发计划的进度说明

- M0：通用查询及 clangd 19 的标准协议验证完成；选择固定 Webview 作为 Context 宿主；真实宿主验证未完成。
- M1–M4：五项功能已具备初版实现，逻辑链路已测试；不代表全部 P0/P1 验收完成。
- M5：补齐使用说明和 VSIX 打包流程；发布前仍需完成真实宿主及人工阅读验收。
- P1/P2 未实现范围见 README，初版不宣称达到需求文档的最终发布完成标准。

参考：[LLVM 20.1 发布说明](https://releases.llvm.org/20.1.0/tools/clang/tools/extra/docs/ReleaseNotes.html)。
