# SourceInsight-Reader

[English](README.en.md) · [功能验收用例](docs/ACCEPTANCE-TESTS.md) · [支持矩阵](docs/SUPPORT-MATRIX.md) · [命令索引](docs/COMMAND-REFERENCE.md)

Source Insight 风格的 VS Code 代码阅读插件：在当前阅读位置旁预览定义、浏览调用者和调用现场、查找引用、保存分析进度。内置基础 C 索引；C++、Java、Python 的完整语义能力由对应语言扩展提供。

当前为 **1.0.9 优化开发构建**，六阶段开发和自动回归记录见 [优化台账](docs/OPTIMIZATION-LOG.md)。平台、提供者和长期稳定性待验项在支持矩阵单列，开发完成不等于正式商用验收通过。

## 开始阅读

1. 在 VS Code 1.106 或以上安装 `dist/wanguo-sourceinsight-reader-1.0.9.vsix`，打开源码工程。
2. 命令面板运行 **SourceInsight-Reader: 入门指南**，再运行 **能力与工程诊断**。C 基础阅读无需编译；C++ 建议安装 clangd 并配置编译数据库，Java 使用 Red Hat Java 标准模式，Python 使用 Python/Pylance 并选解释器。
3. 运行 **打开阅读工作台**，选择源码符号。Context 显示定义/声明，Relation 显示调用关系；主编辑器阅读位置保留。
4. 按需选择 **键位预设**。默认保留 F2 重命名、原生引用键、已有布局和图标主题，`.clangd` 自动维护默认关闭。

[独立验收工程](examples/acceptance/README.md) 可复制后直接使用。真实大型工程按 [质量流程](docs/QUALITY-GATES.md) 记录环境和后端。

## 当前功能

| 工作流 | 支持内容 | 操作与验收 |
| --- | --- | --- |
| 工程与文件 | 多根目录树、按目录加载、文件名/路径过滤、主题图标、批量屏蔽、继续显示 | FILE / SCOPE |
| 符号阅读 | 全部符号/仅函数、名称与源码排序、过滤、当前函数跟随、全局符号 | SYM |
| Context | 定义/类型/包含函数模式、多候选、内部符号导航、独立历史、锁定、刷新、查找、完整函数、旁侧固定标签 | CTX / READ |
| Relation | 横向直接关系图、多层 Outline、incoming/outgoing、全部调用现场、递归终止、锁定、继续显示、语义复查 | REL |
| 其他关系 | 实现提供者、原生类型层次入口、DocumentSymbols 成员、本地 C 直接 include/反向依赖 | REL-12 / REL-13 |
| 引用 | 语言服务引用、本地 C 唯一绑定引用、完整位置、源码片段、路径/文本筛选、历史、翻页和遍历 | REF |
| 文本检索 | 字面串、大小写、全词、正则、多行、未保存缓冲区、多根范围、取消、保存查询/历史 | SEARCH |
| 持久阅读 | 书签、笔记、阅读任务；唯一内容锚点漂移恢复，删除/歧义拒绝旧行号；分类清理 | READ-04～07 |
| 外观与键盘 | 统一功能/外观设置、主编辑器和各面板样式、同源 TextMate/语义样式、函数头强调、可选 Source Insight 键位/折叠图标 | SET / KEY / A11Y |
| 工程维护 | 增量索引、首批快照、失败文件隔离、编码、缓存重建、clangd 差异预览/备份/托管块移除、脱敏诊断导出 | IDX / ENV / CLANGD |

完整步骤、前置条件、预期和环境验收共 **138 项**，见 [ACCEPTANCE-TESTS.md](docs/ACCEPTANCE-TESTS.md)。[CSV 模板](docs/ACCEPTANCE-RESULTS-TEMPLATE.csv) 可复制填写 PASS / FAIL / BLOCKED / N/A；初始 NOT_RUN 不代表通过。命令和配置参考由 manifest 生成，检查会防止文档过期。

## 后端与准确性

`navigationBackend=auto` 优先短预算语言服务定义，再回退本地 C；`local` 用于离线 C，`languageService` 只用提供者。引用在无可用语义绑定时可回退本地；有语义定义的空引用保持语义空。Relation 有独立 `relationBackend` 策略。结果说明来源，空、缺能力、超时、过期和不完整分别处理。

内置 C 支持函数、变量/参数、宏、枚举、typedef、结构体/联合体和按明确声明类型定位字段。它**不求值条件编译、不展开宏、不推导函数指针实际目标、不解析 C++ 模板或完整类型系统**。C 兼容 `.h` 可离线处理；显式 C++ 关联或明确 C++ 语法交给语言服务。无法确认的绑定不生成确定关系。

语言服务结果取决于扩展就绪状态、编译单元与参数。clangd outgoing 需要 20+；Java/Python 动态或缺失能力不能由文本匹配替代。类型层次使用原生入口，未实现自有跨语言继承数据库；旁侧固定阅读使用当前文件，不是不可变历史快照。

## 资源预算

- 本地 C 单文件 8MiB，Worker JS 堆预算 512MiB；文件枚举 30 秒、在线无进度 60 秒看门狗，扫描另有按文件数增长的总预算。失败文件有状态，不保留旧结果冒充当前结果。
- 预览先显示源码，再异步着色；完整函数单次最多 2000 行，可继续上下阅读。
- Relation 图每侧初始 200 项、Outline 初始 500 项/40 层，可继续加载；深度最高 200 层，更深从节点重新设根。
- 文本检索默认最多 20000 文件/20000 命中、单文件 4MiB、总读 128MiB；单次匹配 Worker 1.5秒，超时可终止。达到预算会说明结果不完整，可缩小范围再查。
- 文件搜索不先按旧 50000/10000 上限截断；大列表分页/按需展示。全局符号单次最多 1000 项，可缩小查询。

预算是保护边界，不是所有真实工程的性能承诺。合成测量与原始证据见交付报告。

## 安装验证与开发

```sh
npm ci
npm run check
npm run test:unit
npm run test:clangd
npm run package
npm run verify:package
npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.0.9.vsix
```

使用 Node 22；真实宿主需要 VS Code、clangd 扩展与服务器，Linux 无桌面用 Xvfb。F5 可启动开发宿主。跨平台 CI、真实 Java/Pylance、准确性语料、故障/八小时工具见 [QUALITY-GATES.md](docs/QUALITY-GATES.md)。最终 VSIX 同时生成 SHA-256、验证报告与供应链资产清单。

- [当前全部配置](docs/CONFIGURATION.md)
- [商用审计的42项问题与阶段计划](docs/COMMERCIAL-READINESS.md)
- [最终开发交付报告](docs/FINAL-DELIVERY.md)
- [隐私与数据保留](PRIVACY.md)、[支持与问题反馈](SUPPORT.md)、[Beta 验证](docs/BETA-VALIDATION.md)
- [历史更新记录](CHANGELOG.md)、[原始开发计划](docs/DEVELOPMENT_PLAN.md)
