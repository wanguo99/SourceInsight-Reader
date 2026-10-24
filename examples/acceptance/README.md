# 验收小工程 / Acceptance Workspace

将本目录复制到临时位置再编辑，单独用 VS Code 打开该副本。C 基础验收禁用 clangd/cpptools 并选 `navigationBackend=local`、`relationBackend=local`；语义验收启用 clangd，以下命令生成一个最小编译标志文件即可供样例使用：`compile_flags.txt` 内容为 `-I.`，不要求实际构建。

Copy this directory before testing. Use the local backends without C/C++ language extensions for offline cases. For semantic cases, enable clangd and create `compile_flags.txt` containing `-I.`.

- `a.c`：全局 `arg` 与局部 `arg` 应分开；`r->value` 定位 api.h 的字段；`leaf_callback()` 为间接调用，不能生成到同名全局函数的确定边。
- `leaf` 的直接调用现场：run 一处、process_request 两处、b.c 的 caller 一处，共四处，包含定义时引用数可能再增加。切换语义服务时声明计数由提供者决定。
- `recursive` 用于循环终止；prototype 的 arg 用于原型参数作用域。
- 多根场景把 peer 复制到本目录之外，将 main.c.txt 改名为 main.c，再作为第二根加入工作区；此时它的 leaf 不得混入第一根。仅将嵌套目录作为第二根可能受文件提供者重复枚举影响，根身份以最深匹配根为准。
- READ-05：在书签前插入注释；再复制书签行及其上下文，检查唯一重定位与歧义拒绝。
- SEARCH-10：多行模式检索 `return leaf\(\) \+ leaf\(\)` 或跨行 `run[\s\S]+return`，点击检查完整范围。空行、CRLF 与 emoji 可在副本中添加。

所有人工结果写入测试模板副本，不更改期望来掩盖失败。完整步骤见 docs/ACCEPTANCE-TESTS.md（仓库根目录）。
