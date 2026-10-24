# 功能清单与回归检查

用于后续开发、修复和发布前验收。当前重点是本地 C 索引、Context 连续导航及统一配置和外观；自动测试通过不代表覆盖所有 C/C++ 语义。检查日期为 2026-10-23，发布版本为 1.0.9。

## 检查方法

- 自动回归：Node.js 22 下执行 `npm run check`、`npm run test:unit`。
- 语言服务集成：执行 `npm run test:clangd`；需要 clangd。
- 真实界面及 API：执行 `npm run test:host`；需要 VS Code，Linux 无桌面时使用 Xvfb。
- 本地索引用例必须直接检查本地结果，防止语言服务回退掩盖错误。
- 每次修复应覆盖成功定位、同名误跳防护和相关能力边界。检查状态以最后一次实际结果为准。

## 本地 C 索引及定义导航

| 功能 | 验收要点 | 状态 | 回归入口 |
| --- | --- | --- | --- |
| 工程扫描 | `.c/.h` 及大写扩展名，排除目录和文件 | 自动回归通过 | `test/c-index.test.js`、`test/reading-directories.test.js` |
| 扫描超时 | 按实际 C/H 文件数动态分配时间，首次创建、重新扫描和强制重建均生效；超时清理、并发查询及计时器溢出保护 | 自动回归通过 | `test/local-index-timeout.test.js` |
| 函数 | 定义、调用处、声明、函数指针参数中的函数名 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 结构体及联合体 | 定义、全局和局部声明、函数返回及参数类型 | 自动回归通过 | `test/c-index.test.js`、`test/context-navigation.test.js` |
| 枚举 | 枚举标签、显式和隐式枚举值、匿名枚举 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| typedef | 标量、记录类型、函数指针、局部别名 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 变量及参数 | 全局、局部、参数、声明位置及嵌套作用域遮蔽 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| C 名字空间 | 同名类型标签和变量、struct 与 union、不同函数局部类型 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 宏 | 对象宏、函数宏调用及自身定义定位 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 字段逐层定位 | 明确声明类型、typedef 链、指针、数组、嵌套及匿名字段；未知类型不猜测 | 自动及宿主回归通过 | `test/c-navigation.test.js`、`test/c-index.test.js`、`test/host/index.js` |
| 普通点击与类型查询 | 变量和字段停在自身定义或声明；只有 Shift+点击及类型模式查询类型 | 自动及宿主回归通过 | `test/context-navigation.test.js`、`test/clangd.test.js`、`test/host/index.js` |
| 条件编译内成员 | 保留各分支枚举值和字段，不求值条件 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 全局搜索 | 函数、宏、变量、类型、枚举成员、字段与名称片段 | 自动回归通过 | `test/symbol-search.test.js`、`test/c-index.test.js`、`test/c-navigation.test.js` |
| 跨文件查询 | 包含链、同工程候选、多根工程隔离 | 自动回归通过 | `test/c-index.test.js`、`test/c-navigation.test.js` |
| 坐标通信 | 真实 VS Code Position 的 getter 跨 Worker 传输 | 自动及宿主回归通过 | `test/c-index.test.js`、`test/host/index.js` |
| 文件坐标 | UTF-16、中文、CRLF、Windows 盘符及大小写 | 自动回归通过 | `test/windows.test.js`、`test/c-index.test.js`、`test/c-navigation.test.js` |
| 缓存及增量 | 解析版本失效、删除、脏文档覆盖、取消扫描 | 自动回归通过 | `test/c-index.test.js`、`test/architecture.test.js` |

## Context 及阅读交互

| 功能 | 验收要点 | 状态 | 回归入口 |
| --- | --- | --- | --- |
| 主编辑器跟随 | 定义、类型定义、包含函数模式及防抖 | 自动回归通过 | `test/reading.test.js`、`test/context-navigation.test.js` |
| 预览内点击 | 函数、类型、枚举、变量和字段按预览坐标定位；逐层进入类型，主编辑器位置保持 | 自动及宿主回归通过 | `test/context-navigation.test.js`、`test/host/index.js` |
| 安全渲染 | 源码按文字显示；注释和字符串不作为导航链接 | 自动回归通过 | `test/context-renderer.test.js`、`test/syntax.test.js` |
| 查询竞态 | 旧响应和旧快照不能覆盖当前目标 | 自动回归通过 | `test/context-navigation.test.js`、`test/host/index.js` |
| 锁定及失败恢复 | 锁定不跳转；失败保留原预览；源码修改后拒绝旧坐标 | 自动回归通过 | `test/context-navigation.test.js` |
| 候选及历史 | 多定义显式选择、前后导航和候选定位 | 自动回归通过 | `test/context-navigation.test.js`、`test/host/index.js` |
| 刷新与重建 | 刷新当前预览；重建扫描工程并刷新 Context；忙时按钮禁用 | 自动回归通过 | `test/context-renderer.test.js`、`test/architecture.test.js` |

## 其他功能回归

| 功能 | 验收要点 | 状态 | 回归入口 |
| --- | --- | --- | --- |
| 文件符号 | 全部符号与仅函数模式、筛选、排序、图标 | 自动回归通过 | `test/symbol-view.test.js`、`test/document-symbols.test.js` |
| 工程文件 | 文件名搜索、目录屏蔽、根目录和文件图标 | 自动回归通过 | `test/file-search.test.js`、`test/reading-directories.test.js` |
| Relation | 直接调用、递归终止、间接调用不误报、后端回退、锁定 | 自动回归通过 | `test/relation-backend.test.js`、`test/relation-pane.test.js`、`test/c-index.test.js`、`test/c-navigation.test.js` |
| 引用与全文 | 语义引用与文本匹配分开、结果跳转和过期位置保护 | 自动回归通过 | `test/references-editor.test.js`、`test/text-lookup.test.js` |
| 高亮及主题 | 同名高亮、选中可读性、快捷键与源码文字不变 | 自动回归通过 | `test/symbol-highlight.test.js`、`test/appearance.test.js` |
| 函数头强调 | 仅定义和声明处的函数名独立强调；Context 名称 116%、参数 94%，主编辑器名称字重及字距突出、参数常规；多行、嵌套参数、编辑失效及主题切换 | 自动及宿主回归通过 | `test/function-heads.test.js`、`test/host/index.js` |
| Context 同源配色 | 已安装语言扩展的真实 TextMate 语法与编辑器语义提供者；宏与枚举定义蓝、引用红；颜色、加粗、斜体、主题分组覆盖和关闭语义高亮；旧响应不能覆盖新预览 | 自动及宿主回归通过 | `test/textmate-colors.test.js`、`test/preview-colors.test.js`、`test/host/index.js` |
| 外观配置菜单 | 设置齿轮直接打开同一配置页的功能 / 外观标签，不弹菜单、不跳原生设置页；无独立颜色按钮；100 项类型颜色、字体、字号和窗口背景配置；分类、筛选、颜色选择器、默认值回填；只写修改项，区分用户和工作区 | 自动及宿主回归通过 | `test/appearance.test.js`、`test/appearance-options.test.js`、`test/host/index.js` |
| 功能配置与保存 / 重载 | 25 项功能配置与 manifest 默认值一致；布尔、枚举、范围和整数校验；列表保留逗号和 Windows 路径；两个标签一起保存，失败保留输入且不重载；重开页不丢弃输入 | 自动及宿主回归通过 | `test/settings-panel.test.js`、`test/appearance.test.js`、`test/host/index.js` |
| 独立面板外观 | Context、Relation、文件符号、工程文件、检索结果独立字体、默认文字、字号和背景；即时同步，关闭释放订阅；无效值不注入 CSS | 自动及宿主回归通过 | `test/appearance-options.test.js`、`test/architecture.test.js` |
| Relation 小框 | 按截图使用灰色方角卡片、细边框和红线；卡内前三处行号点击准确预览、更多位置选择；旧坐标禁止导航；字号改变同步几何高度 | 自动、宿主及截图检查通过 | `test/relation-pane.test.js`、`test/relation-renderer.test.js` |
| 原生折叠按钮 | 默认常驻，展开为方框减号、折叠为方框加号；保留原生折叠和其他图标；已有显式用户配置优先，可在外观页修改 | 自动、宿主及截图检查通过 | `test/appearance-options.test.js`、`test/host/index.js` |
| Java 及 Python | 符号和语言服务接入不受 C 索引变更影响 | 自动回归通过 | `test/java-python.test.js` |
| 消息及生命周期 | 消息白名单、过期会话、关闭文件和资源释放 | 自动回归通过 | `test/architecture.test.js`、`test/closing-files.test.js` |

## 能力边界

优化阶段与全量手工步骤见 [商用就绪计划](COMMERCIAL-READINESS.md)、[完整验收用例](ACCEPTANCE-TESTS.md) 和 [执行记录](OPTIMIZATION-LOG.md)。

### 准确性优化 S1

- 文件级回调对象及头文件回调声明不会绑定成其他翻译单元同名函数；原型参数拥有独立作用域。
- 不可见枚举和记录类型不返回为已确认定义。明确的 C++ 语法或显式关联为 C++ 的头文件拒绝 C grammar；仅被编辑器默认标为 cpp 的 C 兼容头文件仍支持离线阅读。
- 多根工程在设置屏蔽项后保持身份隔离；允许外部 SDK 定义预览，非法范围配置仍拒绝查询。
- 支持 UTF BOM 和 files.encoding 指定的可解码编码；非法字节、二进制或超过限制文件有明确逐文件错误，不提供旧目标。
- 验证入口：`test/commercial-correctness.test.js`，对应手工 NAV-02/03/06/07/08、SCOPE-02/03、IDX-03/04、REL-10。

### 查询优化 S2

- `navigationBackend` 定义/符号策略和 `queryTimeoutMs` 等待预算；自动定义短语义等待后回退本地，预览标明来源。
- 同代次同查询合并；超时的实际后台工作占据并发额度，源码/配置变化取消等待；语义调用层次句柄不跨代次复用。
- Relation auto 优先语义服务；local 保留独立基础阅读。引用能力缺失与空引用区分。
- 编译数据库、flags、presets、clangd 参数及文件关联更改使查询配置身份变化。
- 自动：`test/query-coordinator.test.js`；手工：QUERY-01～04、ENV-01。

### 性能与完整浏览 S3

- 索引首批快照、当前文件优先、进度看门狗、批量文件更新；依赖反向索引与包含闭包有界缓存。
- 无变化快照不重写，分片序列化；全文匹配使用可终止 Worker，源码先显示再异步着色，同版本 TextMate 文本镜像复用。
- 文件树按目录展开加载，搜索完整枚举；文件、文档符号和关系均可继续加载。
- 迟到文件事件的有限重试不覆盖真实源码变更；函数头强调使用同文档版本快照。
- 自动：`test/performance-budgets.test.js`、`test/local-index-timeout.test.js`、`test/query-coordinator.test.js`；合成基准 `npm run benchmark`；手工 PERF-03～05、FAULT-03。

- 本地索引读取工程源码，不需要编译、编译数据库或 clangd；只内置 C 语法解析。
- C++、Java、Python 的语义定义查询由对应语言服务提供。
- 结构体字段支持符号搜索，以及依据显式声明类型解析 `obj.field`、`ptr->field`、数组和嵌套字段。字段先定位到所属记录中的声明，不自动进入元素类型。宏生成类型、强制转换和函数调用结果等复杂接收表达式仍由语言服务补充。
- 不执行宏展开，不计算条件编译，不承诺函数指针实际目标和复杂类型推导。
- 显式类型定义查询及 Lookup References 的语义引用依赖语言服务。
- 真实 Windows 和 Remote 会话的界面行为需要相应环境验收；Linux 下模拟 Windows URI 只能验证路径逻辑。

## 本轮问题与验证记录

### 已复现并修复

| 问题 | 修复后行为 | 重点回归 |
| --- | --- | --- |
| 真实 Position 对象跨线程丢失 getter | 将行列转换为普通数值字段再发给 Worker | getter 模拟对象、真实 VS Code API |
| 函数返回类型和参数类型漏记 | 签名保留类型引用坐标，不将签名识别为调用 | Context 点击结构体名 |
| 匿名枚举、局部类型及条件分支成员遗漏 | 收录匿名枚举值、局部 typedef 和标签，以及条件分支成员 | `test/c-navigation.test.js` |
| 参数声明位置不在查询作用域 | 参数从名字声明处到函数体末尾可定位 | 参数声明、引用与嵌套遮蔽 |
| 同名标签和变量混淆 | 区分标签、类型引用、值引用，局部类型不泄漏到其他函数 | struct、union、局部变量与 typedef |
| 函数值引用、函数宏及仅声明函数查询为空 | 函数值引用查函数；宏调用查宏；没有定义时保留函数声明 | 回调注册、宏调用及声明回退 |
| extern 遮住真实变量定义 | 优先返回同工程中的真实定义，排除包含链之外的 static 符号；保留头文件内可见的 static 变量 | extern、static 及不可见宏 |
| typedef 枚举成员重复搜索 | 以文件及声明坐标去重，保留不同位置的真实候选 | 同一枚举值只显示一次 |
| 字段查询缺少接收对象信息 | 保存声明类型，按接收变量逐层定位字段；使用变量声明处的类型绑定 | `bmc_result->samples`、数组、嵌套及 typedef 遮蔽 |
| 普通点击自动转到类型 | 默认只定位符号自身；类型查询改为显式操作 | 本地和真实 clangd 路径一致 |
| 本地目标全部被过滤后不再查询语言服务 | 过滤后的本地结果为空时继续查询语言服务 | 被屏蔽本地目标与合法语言服务目标 |

### 1.0.9 验证结果

- `npm run check`：通过，包含语法、manifest、版本、解析资源及 JavaScript 类型检查。
- `npm run test:unit`：231 项通过，0 失败、0 跳过，日志为 `dist/tests-1.0.9.log`。
- 新增动态超时回归覆盖实际文件数、超过原 60 秒上限后的继续扫描、并发查询复用 Worker、刷新和强制重建重新计算、超时清理及计时器上限。
- 本轮未重新运行真实 VS Code 宿主和完整 clangd 集成测试，相关历史验证保留如下。

### 1.0.8 验证结果

- `npm run check`：通过，包含语法、manifest 和 JavaScript 类型检查。
- `npm test`：227 项测试，226 项通过、1 项跳过、0 失败；覆盖两个标签、25 项功能配置、跨标签未保存修改、当前页默认值、混合保存校验、保存成功后才重载及真实 clangd 集成。
- `npm run test:host`：17 项通过、1 项跳过。覆盖真实 VS Code Position、结构体签名、变量声明、字段声明、后续类型导航，以及主编辑器和 Context 的函数头强调。
- 跳过项为 clangd outgoing calls：当前 clangd 19，相关检查要求 clangd 20 及以上。
- 真实 libbmc 样例：`bmc_routing.c` 的多处 `bmc_result->samples` 均定位到 `include/bmc/bmc/bmc_device.h` 第 80 行的字段声明；枚举定义及既有调用关系回归保留。
- 界面截图：`dist/settings-features.png`、`dist/appearance-settings.png`、`dist/reading-appearance.png`、`dist/reading-folded.png`；可运行 `npm run test:host -- --capture-ui` 重现。
- 未做原生 Windows 桌面验收；本轮宿主测试运行于 Linux Xvfb。Java/Python 的独立语言服务未进行真实宿主验收，其模拟协议回归已通过。

### 后续开发约定

1. 改动对应功能时，在本清单定位验收项；新增功能同步增加用例和能力边界。
2. 本地索引变更必须覆盖不依赖语言服务的回归，语法事实字段变更需更新解析缓存标识。
3. 普通点击不得自动改跳变量或字段的类型；类型导航必须由类型名点击、Shift+点击或类型模式触发。
4. 修改跨 Worker 或 Webview 的参数时，使用普通可序列化数据，并补真实 VS Code API 验证。
5. 更新验证记录时写实际命令、结果及环境，不把模拟测试写成真实平台验收。

### 本轮外观一致性审查

| 检查项 | 结果 / 调整 |
| --- | --- |
| 同一源码位置的宏和枚举成员 | 真实 clangd + VS Code 验证定义 / 声明蓝、引用红，两个窗口一致 |
| 函数、变量、字段、静态和只读修饰符 | 保留原有语义规则，菜单按符号和定义 / 引用分别配置 |
| 运算符和标点 | 修正简单词法映射中的默认黑色回退，使用语言语法真实作用域 |
| 字符串底色 | 移除 Context 独立黄色底色，对齐主编辑器 |
| 加粗、斜体、下划线及删除线 | 独立解析语义属性并叠加 TextMate 属性，显式 false 生效；函数头强调保留 |
| 自定义规则 | 支持原生语法与语义覆盖、通配主题分组及组合主题选择器，保留原生优先级 |
| 字体和背景 | 保存前校验；主编辑器背景同时覆盖行号栏和面包屑；默认文字贯通词法及语义回退 |
| 锁定预览的延迟着色 | 锁定取消导航，不取消当前源码的待返回样式；被替换、关闭或修改的源码不接收旧样式 |
| 保留的 Webview | 显式同步新增主题色变量，避免 Relation 回退为浅黄卡片；切换主题和修改配置即时更新 |
| 配置保存 | 不把工作区对象复制进用户设置；恢复颜色不删除无关字重；写入失败保留输入，可重试 |
| 原生装饰边界 | Context 不复制括号层级色、诊断、活动括号、内嵌提示等原生装饰；公开 API 不支持主编辑器单符号字号或任意折叠按钮位置 |
