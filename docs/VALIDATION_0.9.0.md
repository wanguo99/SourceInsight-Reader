# 0.9.0：本地 C Relation 索引验证

日期：2026-10-19。主要针对 Windows C 源码阅读中 Relation 依赖 clangd、频繁返回空结果的问题。

## 问题复现

用户样例 `source-example` 中，`bmc_string_copy_nullable` 定义在
`include/internal/foundation/bmc_string_internal.h:28`，是 `static inline`。

样例的 `build/clangd/compile_commands.json` 当前只有 17 个翻译单元，覆盖 foundation/config/output/EPDU 等部分，没有完整覆盖 backend/model/bmc/tests 中的调用。

本机 clangd 19.1.7，开启 background-index，仅打开该头文件：

```text
prepareCallHierarchy → 找到 bmc_string_copy_nullable，头文件第 28 行
incomingCalls       → []，0 个调用者
```

这是一次明确的服务返回空结果复现；不同打开文件和索引状态可能返回不同数量，不能认定 clangd 在所有配置下都无法查询此函数。

原插件将空查询 Promise 保存在关系缓存中，同一节点重复展开不会重新请求。原文件监听还会因不相关文件变化把关系标记过期。这两处进一步放大了服务未就绪/索引不足的问题。

## 本次实现

- 官方 Tree-sitter JS/WASM 和 C grammar 随 VSIX 分发，资源来源和校验值见 `vendor/tree-sitter/manifest.json`，许可证一起分发。运行时显式读取两个 WASM Buffer，不进行网络请求，不依赖用户安装编译器或 Node。
- 后台 Worker 提取 C 函数、声明、全局变量、聚合类型、基础成员、typedef、include、宏名和直接调用位置。
- 内存查询表按符号身份与文件区分 static；头文件 static-inline 依赖 include 可见关系。传递 include 支持环路去重；相邻头文件优先，唯一项目后缀作为回退，歧义不任选一个。
- 保存定义范围、名称范围与每次调用范围；Relation 的上下游跳转不混用坐标。
- 未解析的函数/宏及多个候选显示未解析节点，定位调用现场；函数指针调用和函数地址引用不冒充直接调用。
- 工作区扩展存储中保存 `c-index-v1.json` 语法事实快照；内容哈希判定变化，工作线程重建内存查询表。当前不是 SQLite/sql.js 数据库。
- 文件监听、未保存文档覆盖、保存、关闭回退到磁盘、删除和工作区变化更新索引；失败保留可用结果并记录输出。
- Relation 的语义空结果不长期缓存，非空请求去重；同一根节点临时失败时保留已有结果；语言服务调用层次查询有 5 秒超时。
- 文件符号查询在本地与语义提供者之间竞争可用结果；语义提供者挂起不会阻塞编辑器接入和 Relation 启动。普通 C 函数 Context 命中本地定义时，不等待可能挂起的类型查询。
- C 普通函数定义优先本地解析；语言服务文件符号无结果时有本地回退；复杂类型与引用仍使用语言服务。

## libbmc 核对结果

真实 Tree-sitter/WASM 解析用户样例的 145 个 C/头文件，不启动 clangd：

| 核对项 | 结果 |
| --- | --- |
| `bmc_string_copy_nullable` 定义 | `bmc_string_internal.h:28` |
| 直接调用者 | 29 个函数 |
| 直接调用位置 | 66 处，逐一核对原文名称及范围 |
| 下游函数 | `bmc_string_copy_impl`，定义在同头文件第 15 行 |
| `bmc_epdu_query_decode` 调用 frame_parse | 调用点在 command.c:170，定义在 frame_codec.c:46 |
| 原始解析函数数 | 630；这是解析输出数量，不是人工确认的完整召回率 |
| 含语法错误的文件 | 20；尽量提取可识别内容，不声称完整语义解析 |

这些是本次固定样例的结果，修改样例后计数可能变化。自动测试在用户样例不存在的其他环境中会明确跳过 libbmc 一项。

## 自动验证

`test/c-index.test.js` 实际运行官方 WASM、索引模型、后台 Worker 及 VS Code API 替身，覆盖：

- 文件内 static 同名隔离、头文件 static-inline 与传递 include。
- 调用者/被调用者的坐标分离、重复调用、嵌套调用、中文/空格文件名、emoji 和 CRLF UTF-16 坐标。
- 条件编译重复定义、宏、函数指针和函数地址传递的保守处理。
- 函数声明、struct/union/enum 成员、typedef、全局变量、函数指针变量的文件符号。
- 磁盘快照、未保存文档覆盖、缓存恢复、源码变动、位置迁移、文件删除、损坏缓存重建。
- 无语言服务时 LanguageAdapter + RelationTree 的完整后台查询。
- 永不响应的文件符号/类型提供者不阻塞本地文件符号和函数 Context。
- 冷空结果重试、正结果缓存、服务临时失败保留结果。
- libbmc 指定函数、调用点和定义位置核对。

原有 Context/Relation DOM、窗口内导航、锁定、异步过期结果丢弃、布局、主题、Windows URI、引用和真实 clangd 协议回归同时运行。

完整测试共 75 项：74 通过，1 项因 clangd 19 不支持 outgoing 而跳过；本地 C 的两个调用方向均通过验证。`npm run check` 通过（语法、类型、命令注册与官方解析资源 SHA-256）。日志保存在开发目录 `dist/tests-0.9.0.log`，不随插件发布。

已解包实际 VSIX，从包内路径启动后台 Worker，并重新扫描 libbmc：145 个文件，无文件读取/缓存失败，返回同样的 29 个调用者、66 处调用及下游定义第 15 行。确认包内包含解析器、两个 WASM 和许可证，不依赖开发目录的 node_modules。结果保存在 `dist/packaged-index-validation.json`。这属于无界面的包内运行验证，不等于 Windows/Electron UI 验收。

下述边界不受自动测试通过的影响。

## 适用范围及待验收项

- 本地索引限当前工作区的 `.c`/`.h` 本地文件 URI，单文件上限 8 MiB，默认排除生成目录等；扫描规则可以配置。
- 不求值条件编译、不展开宏、不推断函数指针目标、不提供完整类型/引用语义；头文件后缀匹配不等价于编译器完整搜索路径。
- 第一版会对变化文件重新解析、重建内存关系表；未实现 Tree-sitter 编辑级 AST 复用或 SQLite 大项目增量图更新。
- 已保留 Windows/Linux CI，测试使用系统路径 API、URI 归一化和 WASM Buffer；本机是 Linux，没有执行 Windows 实机安装或真实 Electron UI 验收。
- 最低 VS Code 1.106 的宿主运行、大型工程规模、Remote/WSL 仍需单独验收。

后续优化应优先增加可配置 include 搜索路径、条件分支证据、类型/引用关联和大项目存储；避免重新回到只按名称猜测定义的实现。
