# 内核符号与 Context 候选列表验证（基于 1.1.0，未发布）

源码：`/home/guohao/am62x/workspace/linux/linux-7.0`。构建：`/home/guohao/am62x/workspace/buildroot/output/build/linux-custom`。源码只读，数据库及测量报告写入独立验证目录。当前事实版本为 facts-18，数据库结构仍为 schema 5；旧语法事实会自动重建，语言服务观察结果保留自己的配置与内容校验。

## 验证方法

以真实 clangd 19 的语义引用和定义响应作为独立位置参照，使用该内核自己的 ARM64 编译参数与生成头文件。验证用编译数据库选取与源码一致的四个编译单元，去除该版本 clang 不支持的 GCC 参数并明确目标架构；不修改项目配置，不借用其他工作区 SDK。

样本来自 init/main.c、kernel/fork.c、kernel/sched/core.c、drivers/char/mem.c，以及 sched.h、bpf.h、types.h、list.h。只采集引用位置，纠正 EXPORT_SYMBOL 展开引入的声明标记；不把“定义跳到自身”当作引用验证。记录源码 SHA-256，源码变化后拒绝复用参照结果。

分别查询生产索引 Worker 的本地结果，以及真实 LanguageAdapter → Context 路径的自动模式结果。自动模式先准备原生 AST，再进行稳定查询，因此该项不代表语言服务冷启动延迟。重复结果必须等待明确选择。唯一/重名按当前项目索引中相同名称空间的物理定义统计；目录无对应定义时标记未知，不能据此证明全局唯一。未解析引用和项目外目标单独计数，不计入通过样本。

## 符号范围

最终采集 162 个真实引用位置，覆盖以下 20 类；此前 144 个位置属于预检样本集。唯一/重名数量以末尾完整索引矩阵为准，不能把其他名称空间的同名项当作重复定义。

| 类别 | 示例/覆盖方式 |
| --- | --- |
| 普通函数 | 跨文件及头文件函数 |
| 静态函数 | 当前文件及 static inline，含重名 |
| 全局变量 | 定义、extern 声明及跨文件使用 |
| 静态全局变量 | 文件作用域与名称冲突 |
| 局部变量 | 参数外的函数内变量及遮蔽 |
| 静态局部变量 | 函数内 static 与尾部注解 |
| 全局常量 | const 对象及跨文件绑定 |
| 静态常量 | static const 对象 |
| 局部常量 | 函数作用域 const 对象 |
| 参数 | 普通函数及系统调用声明宏参数 |
| typedef | 普通别名与 bool、size_t 等特殊语法节点 |
| 结构体 | 唯一标签及同名标签 |
| 联合体 | 具名联合体及重名候选 |
| 枚举类型 | enum 标签与条件定义 |
| 枚举成员 | 普通枚举与 false、true |
| 普通字段 | 指针成员访问及匿名结构体布局 |
| 位域 | 以原生声明后的冒号识别，区别普通字段 |
| 对象宏 | 常量宏、注解宏与架构相关宏 |
| 函数宏 | 普通调用、声明及迭代宏 |
| 标签 | 前向/后向 goto、不同函数中的重名标签 |

函数指针、数组、局部类型和匿名聚合另有现有自动测试覆盖；此表不表示每个 C/GNU 扩展都已经有独立真实内核样本。

## 本轮修复

1. 工程正式 include 树优先于 tools 等副本，避免同名头文件阻断整个类型/枚举/宏依赖链。项目边界检查继续生效。
2. 尾部 __initdata、__read_mostly 等注解保留真实变量与数组定义；注解自身的源位置仍可导航。
3. 提取语法库归入 primitive_type 的合法 typedef 名称与使用位置；int、long 等关键字不作为定义。
4. 保留旧式内核 false/true 枚举引用，不因 C23 布尔字面量语法节点而漏索引。
5. C/C++ 头文件识别排除宏体，避免 sched.h 的 class 比较表达式被判为 C++。
6. 识别 __randomize_layout 等已知注解，恢复 mm_struct 等匿名布局内部成员。
7. 为明确的 for_each_* 语句保留控制结构，避免 per_cpu 的变量实参被误记为参数类型。
8. SYSCALL_DEFINE1–6 / COMPAT_SYSCALL_DEFINE1–6 的已识别声明保留原始参数位置与作用域；任意项目宏仍交由语言服务展开。
9. goto 标签使用独立名称空间与函数作用域，前向引用可定位；标签编码可持久化并在 SQLite 重载后恢复。
10. 类型位置中的宏也能作为可见候选；宏查询按名称读取位置，避免遍历每个可见头文件逐条查询数据库。

投影仅用于解析，保留 UTF-16 坐标与换行，不写回原始源码。未知条件分支继续保留，避免猜测当前配置。

## Context 的重复定义

直接列出“相对文件路径:行:列”，点击后预览并保留列表和选中状态。同名文件显示各自目录，同一文件中不同定义位置分别保留。列表有独立滚动与高度限制，支持 Tab、上下方向键、Home/End、Enter/空格；锁定后不能切换，旧快照和无效下标不能误选新符号。

自动着色更新保留候选按钮的焦点与滚动位置；加载候选时列表不消失，预览完成后滚到目标行。真实 VS Code 宿主中分别截取未选择与已选择画面，避免仅凭模型测试认定界面正确。

## 结论的边界

全库文件收录、独立引用样本、宏词法审计和编译器语义是不同证据。不能用文件数量或自身定义检查证明整个内核所有配置都语义正确。

纯本地模式不展开完整预处理环境。ARM64 的 asm 头文件选择、构建生成头文件及条件分支需要对应编译配置；自动模式通过当前项目的语言服务补齐。原生返回 extern/函数声明而本地返回其他文件中的实体定义时，位置差异保留在报告中，不直接归为通过，也不直接宣称错误绑定。缓存恢复后还要重复核验。

人工验证请使用 [完整测试用例](ACCEPTANCE-TESTS.md) 中 CTX-03、CTX-11–13、KERNEL-09–15。全部已有功能用例也保留在同一文档，CSV 由文档脚本同步生成。

## 完整重建及最终矩阵实测

本轮候选包运行文件与被测源码一致，SHA-256：`782c86219fdacc00ccb8d3ce2aa4720800ce991b858fdd1ed9736e423ca8490c`。测试后归档的本报告不改变该 VSIX 的运行文件。

- 完全冷启动：63,043/63,043 文件，749,271 函数，4,336,962 处调用；0 硬失败、0 预算遗漏、0 大文件截断。耗时 2,669.339 秒，采样 RSS 峰值 1,014 MiB，内存预算 1,024 MiB，解析线程峰值 2，总 CPU 上限设置 25%。
- 22,609 文件使用语法恢复，137 文件为 C++ 大纲；这两项继续显示，不代表完整语义成功。问题详情接口最多返回 5,000 项，不能把列表长度当作总量。
- 新进程缓存恢复：63043 文件复用、0 文件重解析，扫描 15.394 秒，函数/调用数量与冷启动一致。
- 全库词法审计：5,895,940 宏定义、1,432,611 处替换文本标识符，缺失与位置乱序均为 0；这不是宏展开后的语义证明。
- 自动模式：162/162 命中独立参照；纯本地：133 个同位置、4 个候选包含正确位置、11 个参照位置不同、14 个未命中。参照排除了 97 个项目外目标、114 个原生未解析查询、1 个返回调用位置自身的目标。
- 验证环境：Node.js 22、VS Code 1.142.0、clangd 19；自动测试 487 通过/1 跳过，真实 VSIX 宿主 24 通过/1 跳过。宿主仍记录两次 clangd 提供者失败，未将其写成无错误；语义颜色作用域警告为 0。

| 符号类型 | 唯一名称 | 重名 | 唯一性未知 | 自动模式通过 | 本地同位置 | 本地含正确候选 | 本地位置不同 | 本地未命中 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| typedef | 4 | 4 | 1 | 9/9 | 6 | 0 | 0 | 3 |
| 对象宏 | 4 | 4 | 0 | 8/8 | 6 | 0 | 1 | 1 |
| 枚举类型 | 4 | 4 | 0 | 8/8 | 8 | 0 | 0 | 0 |
| 函数宏 | 4 | 4 | 0 | 8/8 | 7 | 1 | 0 | 0 |
| 全局变量 | 4 | 4 | 4 | 12/12 | 10 | 1 | 0 | 1 |
| 静态函数 | 4 | 4 | 1 | 9/9 | 6 | 2 | 0 | 1 |
| 结构体 | 4 | 4 | 4 | 12/12 | 11 | 0 | 0 | 1 |
| 枚举成员 | 4 | 4 | 1 | 9/9 | 8 | 0 | 0 | 1 |
| 局部常量 | 4 | 4 | 0 | 8/8 | 8 | 0 | 0 | 0 |
| 全局常量 | 4 | 1 | 4 | 9/9 | 7 | 0 | 2 | 0 |
| 普通函数 | 4 | 4 | 4 | 12/12 | 0 | 0 | 8 | 4 |
| 字段 | 4 | 4 | 0 | 8/8 | 8 | 0 | 0 | 0 |
| 参数 | 4 | 4 | 0 | 8/8 | 8 | 0 | 0 | 0 |
| 局部变量 | 4 | 4 | 1 | 9/9 | 8 | 0 | 0 | 1 |
| 标签 | 4 | 4 | 0 | 8/8 | 8 | 0 | 0 | 0 |
| 静态全局变量 | 4 | 1 | 1 | 6/6 | 5 | 0 | 0 | 1 |
| 静态常量 | 4 | 1 | 0 | 5/5 | 5 | 0 | 0 | 0 |
| 静态局部变量 | 2 | 2 | 0 | 4/4 | 4 | 0 | 0 | 0 |
| 位域 | 4 | 2 | 0 | 6/6 | 6 | 0 | 0 | 0 |
| 联合体 | 2 | 2 | 0 | 4/4 | 4 | 0 | 0 | 0 |

### 本地与原生的差异清单

“位置不同”指未包含原生返回的坐标，包含实体定义/声明差异及不同条件分支；不能统一改称错误定义，也不能统一改称通过。宏生成符号和架构头文件仍需当前工程的语言服务。

| 类别 | 符号 | 查询位置 | 原生参照位置 | 本地结果 |
| --- | --- | --- | --- | --- |
| 位置不同 | `__read_mostly` | `init/main.c:129:31` | `arch/arm64/include/asm/cache.h:77:9` | `include/linux/cache.h:51:9` |
| 未命中 | `COMMAND_LINE_SIZE` | `init/main.c:144:35` | `arch/arm64/include/uapi/asm/setup.h:25:9` | 无 |
| 位置不同 | `strlen` | `init/main.c:206:11` | `arch/arm64/include/asm/string.h:22:24` | `include/linux/fortify-string.h:255:9`、`include/linux/string.h:201:24` |
| 位置不同 | `parameqn` | `init/main.c:207:7` | `include/linux/moduleparam.h:415:13` | `kernel/params.c:86:6` |
| 位置不同 | `get_option` | `init/main.c:259:6` | `include/linux/string.h:319:12` | `lib/cmdline.c:56:5` |
| 未命中 | `u32` | `init/main.c:272:2` | `include/asm-generic/int-ll64.h:21:15` | 无 |
| 未命中 | `u8` | `init/main.c:274:2` | `include/asm-generic/int-ll64.h:17:15` | 无 |
| 位置不同 | `memcmp` | `init/main.c:286:8` | `arch/arm64/include/asm/string.h:28:12` | `arch/arm/boot/compressed/string.c:98:5`、`arch/s390/lib/string.c:265:5`、`arch/x86/boot/string.c:32:5` 等 |
| 位置不同 | `memmove` | `init/main.c:514:4` | `arch/arm64/include/asm/string.h:39:14` | `include/linux/fortify-string.h:692:9`、`include/linux/string.h:263:15` |
| 位置不同 | `sysctl_is_alias` | `init/main.c:558:6` | `include/linux/sysctl.h:268:6` | `include/linux/sysctl.h:305:20` |
| 位置不同 | `strnchr` | `init/main.c:574:6` | `include/linux/string.h:180:15` | `lib/string.c:402:7` |
| 位置不同 | `user_mode_thread` | `init/main.c:725:8` | `include/linux/sched/task.h:105:14` | `kernel/fork.c:2720:7` |
| 未命中 | `randomize_kstack_offset` | `init/main.c:848:25` | `init/main.c:835:7` | 无 |
| 位置不同 | `linux_banner` | `init/main.c:1029:18` | `include/linux/printk.h:14:19` | `init/version-timestamp.c:24:12`、`init/version.c:50:12` |
| 未命中 | `blacklisted_initcalls` | `init/main.c:1261:28` | `init/main.c:1244:39` | 无 |
| 未命中 | `task_no_new_privs` | `kernel/fork.c:1769:6` | `include/linux/sched.h:1848:1` | 无 |
| 未命中 | `task_set_no_new_privs` | `kernel/fork.c:1770:3` | `include/linux/sched.h:1849:1` | 无 |
| 未命中 | `trace_sched_set_state_tp` | `kernel/sched/core.c:538:2` | `include/trace/events/sched.h:890:1` | 无 |
| 未命中 | `trace_sched_set_need_resched_tp` | `kernel/sched/core.c:1132:2` | `include/trace/events/sched.h:895:1` | 无 |
| 位置不同 | `fair_sched_class` | `kernel/sched/core.c:3259:27` | `kernel/sched/sched.h:2721:33` | `kernel/sched/fair.c:298:26` |
| 未命中 | `VAL` | `kernel/sched/core.c:3749:39` | `arch/arm64/include/asm/barrier.h:212:31` | 无 |
| 未命中 | `pgprot_t` | `drivers/char/mem.c:243:41` | `arch/arm64/include/asm/pgtable-types.h:57:37` | 无 |
| 未命中 | `VMA_SHARED_BIT` | `drivers/char/mem.c:523:32` | `include/linux/mm.h:300:2` | 无 |
| 未命中 | `fd_empty` | `include/linux/bpf.h:2617:6` | `include/linux/file.h:45:20` | 无 |
| 未命中 | `__s128` | `include/linux/types.h:13:9` | `include/uapi/linux/types.h:17:29` | 无 |

原始证据见 validation/kernel-symbols-{cold,oracle,queries,compiler,macros}-1.1.0-unreleased.json；包与宿主证据见 validation/{symbol-context-checks,host-symbol-context,runtime-symbol-context}-1.1.0-unreleased.json。临时全量缓存已移至工作区外层 .validation-cache/kernel-facts18-final，未放入插件 Git 仓库。缓存主库约 22.0 GiB，磁盘占用仍是大工程使用时需要考虑的成本。
