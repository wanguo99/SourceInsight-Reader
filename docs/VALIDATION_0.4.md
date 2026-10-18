# 0.4 验证报告

日期：2026-10-18；环境：Debian、Node.js 22、clangd 19.1.7。

- 静态检查覆盖 JavaScript 语法、清单命令注册和 TypeScript checkJs。
- `npm test`：49 项，48 通过、1 跳过、0 失败；跳过项为 clangd 19 不支持的 outgoing calls。
- 新增编辑区引用结果测试：面板创建位置、搜索筛选、精确位置打开、Context 预览、旧结果消息丢弃、源码过期提示、关闭重建及清空。
- 保留真实 clangd 的 C/C++ 语义验证与路径、窗口联动等回归测试。
- 新布局采用官方 secondarySidebar 视图容器，最低 VS Code 1.106；主侧栏位于左侧时，辅助侧栏位于右侧。

Windows 实机和 Electron 界面尚未验收；当前环境无法启动扩展宿主 UI。已有视图布局由 VS Code 保留，升级后可能需要手动移动。
