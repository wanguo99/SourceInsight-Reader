# 0.5.1 验证报告

日期：2026-10-19；环境：Debian、Node.js 22、clangd 19.1.7。

- 静态检查：语法、命令注册和 TypeScript checkJs 通过。
- 自动测试：53 项，52 通过、1 跳过、0 失败；跳过为 clangd 19 不支持的 outgoing calls。
- 模型测试：标量 typedef 即使由后端标为 Class 也不会自动替代数组定义；显式类型查询保持可用。
- 保留真实 clangd 的函数返回结构体、结构体参数和已有符号、引用验证。
- DOM 模型测试：鼠标 button 3/4 的 down/up/auxclick 一组事件各产生一次 back/forward；阻止默认事件。
- 控制器测试：激活时聚焦文件符号命令传递 preserveFocus，Chat 不被删除或禁用。

## libbmc 实际源码验证

基于配置好的 `source-example`，通过真实 clangd 加载实际 LanguageAdapter 与 ContextView：

- `bmc_epdu_layout.c` 中查询 `bmc_epdu_first`，普通定义结果为 `include/internal/epdu/bmc_epdu_schema.h:250:21`。
- 显式类型查询结果为 `__stddef_size_t.h:18:23`。
- 此前智能规则选择了后者；修复后 Context 普通查询显示前者，状态为“定义”。

Windows/Electron 实机 UI 尚未验收，包括鼠标硬件侧键实际事件分发和右侧容器显示。基础类型判断保守依赖语言服务符号及声明形式；无法确认聚合类型时保留普通定义，不自动转到未知类型。
