# EXPORT_SYMBOL 被误当作定义的修复

用户反馈内核中的导出宏会将已有函数或变量的使用位置显示为定义。已在真实 clangd 会话和用户的 Linux 7.0 源码上复现并修复。

## 根因

`include/linux/export.h` 的导出链包含 `extern typeof(sym) sym` 和 addressable 辅助声明。clangd 按编译结果返回这些声明，会在 `EXPORT_SYMBOL(sym)` 处增加函数、变量及生成辅助项，并把参数的语义 token 标记为 declaration。此前插件直接采用这些结果，导致导出位置出现在定义列表中、被染成定义颜色。

本地 C 语法解析没有在这些导出位置产生重复定义；问题出在编译器宏展开结果到源码阅读视图之间的角色转换。

## 修复范围

- 识别 EXPORT_SYMBOL、GPL、NS、NS_GPL、GPL_FUTURE、FOR_MODULES 和 EXPORT_PER_CPU_SYMBOL/GPL，支持多行、注释、字符串命名空间及原始 UTF-16 坐标。
- 在插件符号树和语义快照写入前过滤导出展开项；旧语义缓存回放时也过滤，保留实际函数、变量和宏定义。
- 在导出参数上移除 declaration/definition 标记，保留函数/变量类型及其他修饰；Context 和 Source Insight 主题的主编辑器呈现引用样式。纠正原生声明字体时保留编辑器基础字体权重。
- 语言服务定义或声明目标如果指向导出宏，不把该位置作为物理定义/声明；自动模式的定义查询可继续使用本地真实定义。
- 仅处理明确的导出宏，不泛化为“所有宏调用都不是定义”；SYSCALL_DEFINE、DEFINE_PER_CPU 及用户声明宏仍保留原有行为。同名普通函数的显式定义不被隐藏。

本地解析器与 facts-17 未改变，已有索引可继续复用，安装后重载窗口即可。版本保持 1.1.0，原标签与已有发布包不修改，当前修改未提交。

## 真实内核复现

源码为 `/home/guohao/am62x/workspace/linux/linux-7.0/kernel/sched/core.c`，clangd 使用此前由指定内核构建目录提取并映射的临时编译命令，源码和工程配置只读。

| 项目 | 结果 |
| --- | --- |
| 导出宏调用 | 36 处 |
| clangd 原始导出位置符号项 | 63 个，含重复函数和 addressable 辅助项 |
| 过滤后的导出位置定义项 | 0 个 |
| 纠正的导出参数声明 token | 21 个 |
| 剩余错误声明 token | 0 个 |
| schedule 真正定义 | 保留在源码第 6998 行 |

机器报告见 `docs/validation/kernel-export-references-1.1.0-unreleased.json`。该验证覆盖当前文件中的导出角色，不将它解释为所有内核宏的完整展开验证。

## 回归与验收

自动回归覆盖导出变体、CRLF/Unicode、多行注释、真实定义保留、原始语义数据不被修改、旧缓存回放、快照写入前过滤、错误定义目标回退，以及语义覆盖下的主编辑器颜色/字体纠正和编辑后的缓存失效。真实 clangd 集成复现宏展开并核对过滤后的符号与 token。

当前 `npm run check` 通过，`npm test` 共 478 项、477 通过、1 因 clangd 19 不支持 outgoing calls 跳过、0 失败。测试日期为本地 2026-10-26；实际 VSIX 安装和截图结果在构建后归档，不将旧包的宿主报告当作本包的结果。

人工步骤见 [完整用例](ACCEPTANCE-TESTS.md) 中 EXPORT-01～06。实际 VSIX 的宿主与运行文件校验报告在构建后单独归档，记录被测包 SHA。

VS Code 原生大纲若直接使用 clangd 的结果，仍可能展示其宏展开结构；本次修复作用于 SourceInsight-Reader 的阅读视图与快照，不替换其他扩展提供的原生大纲。主编辑器的引用纠正遵循既有 Source Insight 主题及语义着色开关。

## 实际验收包

- `dist/wanguo-sourceinsight-reader-1.1.0-export-symbol-fix.vsix`，SHA-256：`9f636b1d4b6044d899933d3fd75a4269734d08b25c17a4d868c36153b1fee9a7`。
- Linux / VS Code 1.142.0 实际安装测试：24 通过、1 因 clangd 能力跳过、0 项检查失败。新增导出宏用例同时核对插件符号列表、主编辑器覆盖样式和 Context token；主编辑器截图为 `dist/export-symbol-references.png`。
- 159 个运行文件与当前源码逐字节一致。实际报告位于 `docs/validation/host-export-references-1.1.0-unreleased.json` 和 `runtime-export-references-1.1.0-unreleased.json`。
- clangd 19 在其他截图阶段仍有先前已记录的提供者失败及原生通用提示；本轮导出宏用例通过，不把“后端日志零错误”计为验收项。

此段和宿主报告在实际安装后追加到源码文档，VSIX 未因此重打包。导入该包后重载窗口即可，无需清缓存或重建本地索引；Git 修改仍未提交，已有 1.1.0 标签和原包不变。
