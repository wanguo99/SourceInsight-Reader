# 0.2.0 验证报告

日期：2026-10-18。开发与本地执行环境：Debian 13 x86_64、Node.js 22.23.3、VS Code 1.142.0、clangd 19.1.7。

## 本地结果

- `npm run check`：通过语法、命令注册与 VS Code 1.85 类型接口检查。
- `npm test`：40 项通过，1 项跳过，0 项失败。
- 真实 clangd 协议测试使用独立的中文/空格目录及 CRLF 源码，验证符号、定义、类型、调用者、多个调用位置、递归、引用和同名局部变量作用域。
- outgoing 的真实后端测试因 clangd 19 不支持而跳过，不能算已完成端到端验证；归一化与方向切换逻辑另有测试覆盖。
- VSIX 使用官方 vsce 打包为通用扩展，无运行时第三方依赖或平台专用二进制。

## 本轮新增的回归覆盖

- Windows 盘符大小写、中文与转义空格、UNC 共享边界、盘符根目录和嵌套工作区。
- Windows 用户版/系统版/自定义 VS Code 路径；无需管理员符号链接权限的扩展复制。
- 全局符号查询乱序、选择预览、Enter 打开，以及扫描途中关闭文件选择器。
- 引用按文件/源码筛选、旧筛选响应隔离、有限历史、筛选后的循环导航。
- Context 锁定时，Enter 打开树上实际选中的目标。
- Context 类型/包含函数模式、连续上下浏览和锁定保护。
- 词法着色、跨行注释和 C++ 原始字符串状态、纯文本回退、DOM 中按字面渲染源码。
- Relation 缓存和切换方向时保留根节点。
- 原生文件切换、命令型选区跳转的阅读历史；旧文件打开请求不能覆盖更新目标。

## 宿主和 Windows 状态

重新运行 `npm run test:host`，已通过测试准备阶段：复制扩展和示例到临时目录，并启动已安装的 VS Code。Electron 仍在进入测试前失败：

```text
FATAL:content/browser/sandbox_host_linux.cc:41
shutdown: Operation not permitted (1)
SIGTRAP
```

本次日志目录：`/tmp/sourceinsight-reader-host-BCTunS`。后续普通终端成功运行宿主测试后，可查看 `dist/host-results.json` 中 `completed`、平台、通过/跳过项。DOM 模型测试不等于实际 Webview、焦点、布局和主题测试。

**尚未在 Windows 实机执行，也未触发远端 CI。** Windows 兼容性当前依据平台无关实现、Windows 场景回归和已编写的 CI/宿主入口，不能表述为“Windows 已通过实机验收”。操作步骤与未勾选清单见 [Windows 指南](WINDOWS.md)。

`.github/workflows/ci.yml` 中的 Windows/Linux 默认任务覆盖检查、单元测试和打包；真实 VS Code/clangd 宿主任务需手动启用 `run_host`。本地仓库未推送远端。

## 下一轮实机验收重点

1. Windows 10/11 x64、clangd 20+ 的完整双向关系树。
2. 真正的鼠标/键盘焦点、快捷键冲突、多个编辑器分栏和视图移动。
3. 深浅主题下的基础着色、复制、目标高亮及中文源码。
4. MSVC 工程编译数据库、UNC 文件访问和大型工程性能。
5. 最低 VS Code 1.85、Remote/WSL、微软 C/C++ 后端。

本轮已完善五个核心功能的使用链路，但仍不宣称与 Source Insight 完全一致。布局、索引后端、完整语义高亮、浏览器模式和高级关系分析差异见 README。
