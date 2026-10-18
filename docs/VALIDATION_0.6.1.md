# 0.6.1 验证报告

- JavaScript、命令清单和 TypeScript checkJs 静态检查通过。
- 自动测试 59 项：58 通过、1 跳过、0 失败，跳过项为 clangd 19 outgoing calls。
- 既有主题契约检查扩展为侧栏与编辑区背景一致、固定区域背景一致、标题区一致以及活动选择和函数图标颜色。
- 修改只作用于 Source Insight 主题，原主题选择与恢复流程无变化。

当前环境仍不能运行 Electron UI，Windows/实际侧栏效果待验收。现有 workbench.colorCustomizations 会覆盖主题；第三方文件图标内嵌颜色由该图标主题控制。
