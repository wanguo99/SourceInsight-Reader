# 验证证据来源

这些 JSON 是本轮实际运行的报告，不是人工验收结果。不同报告记录各自测量时刻：

- `host-linux-vsix.json`：S6 最终应用代码的实际 VSIX 安装回归，Linux / VS Code1.142.0，18通过/1 outgoing跳过；截图位于本地 dist/settings-features.png、appearance-settings.png、reading-appearance.png、reading-folded.png。
- `accuracy-c.json`：S5 的18个标注语料场景，known与unknown单列。
- `benchmark-synthetic-s3.json`：S3合成测量；数据中的 working-tree 为测量时的开发快照，后续S3提交 fbbffc0。不外推真实项目性能。
- `soak-short.json`：S5实际4秒短跑，150轮/3重启；不是八小时验证。

宿主日志复核：插件自身的窗口级配置按资源读取警告已消除；clangd19 的 documentSymbol 取消与 outgoingCalls 不支持仍产生提供者日志，后者在截图期间触发过原生错误提示。outgoing 未计通过，正式门槛要求clangd20+并检查该现象是否消失；不能把18/1理解成零后端错误或完整语义支持。原始临时日志只在本机，不随脱敏诊断自动导出。

最终 VSIX 的 SHA 以 dist/*.vsix.sha256 为准；构建不会把 dist 的日志/截图纳入安装包。验收结果请另填 ACCEPTANCE-RESULTS-TEMPLATE.csv 的副本。

- `index-memory-oai.json`：1.1.0反馈后的真实OAI目录只读Worker实测，含旧版OOM及修复后全量/缓存/同Worker重建对照；未上传源码和绝对工程路径。

- `host-memory-fix-linux-vsix.json`：本次1.1.0内存修复的实际VSIX宿主回归，18通过/1因clangd版本条件跳过。

- `host-offline-colors-linux-vsix.json`：C着色修复的实际VSIX隔离宿主，未安装clangd且关闭工程索引，4项通过，包含OAI源文件只读副本；截图在dist/offline-{c,oai}-colors.png。
- `host-color-fix-linux-vsix.json`：C着色修复后的完整VSIX宿主回归，18通过/1因clangd19不支持outgoing跳过。两份报告为Linux/VS Code1.142.0，不代表Windows/Remote用户实机验收通过。

- `index-recovery-oai.json`：1.0.10的真实OAI只读扫描、缓存重载及类型/大文件查询验证；区分7个真实C++头文件、1个顶层模式文件和1个编码提示文件，保留1165个解析恢复标记。
- `host-release-1.0.10-linux-vsix.json`、`host-release-1.0.10-offline-linux-vsix.json`：当前1.0.10实际安装包分别19通过/1版本条件跳过及4通过。报告保留被测ZIP的SHA；加入验证文档后重新打包，通过逐项比对确保最终包与被测包仅文档不同，运行时资源完全一致。
- `host-index-rebuild-oai.json`：本次1.0.10重建修复的实际VSIX专项；OAI缓存加载、写缓存后连续两次新线程重建均7256文件，首批查询在整轮完成前恢复，源码只读。宿主Node24.21.0 / VS Code1.142.0。
- `host-index-rebuild-linux-vsix.json`：本次重建修复的普通实际VSIX宿主19通过/1版本条件跳过，包含等待旧线程退出后重新查询的检查。最终制品仅追加验证文档，运行时逐项比对一致。


统一索引新增 `oai-unified-index.json`（Node22 全 C/C++ 7309 候选、缓存启动及查询延迟）、`host-unified-index-oai.json`（真实 VSIX 的 C/H 7263 候选连续重建）、`host-unified-index-linux-vsix.json`（含双提供者持久化的真实界面/语言服务回归）。后两者记录实际测过的包 SHA；若之后仅补故障保护或文档，不把旧报告伪装成对所有最终字节的重复实测。最终常规 VSIX 复测以同目录最终报告为准。


1.1.0 发布证据：oai-index-before-1.1.0.json / oai-index-audit-1.1.0.json 为独立宏/位置核对及声明回查；oai-xran-1.1.0.json 为真实 OAI + 临时官方 SDK 头文件的 23 处查询；oai-benchmark-1.1.0.json、host-oai-1.1.0.json、host-ui-1.1.0.json、host-colors-1.1.0.json 分别记录大工程、原生重建、界面和离线着色。后续最终包宿主报告另加 final 文件，保留实际测试包 SHA。


## 1.1.0 正式标签说明

源码标签 `1.1.0` 收录本轮全部改动及验收材料。`libbmc-enum-fix-1.1.0.json` 与配套 host/libbmc/OAI 报告记录最近一轮实际测量；429 项自动测试、222 项人工用例保持。报告中的 committed/published 字段与 SHA 是测量时状态，不改写成对重新构建制品的重复实测。清理旧 VSIX 后的新包与 SHA、SBOM 和最终安装报告保存在本地 dist；发布源码与构建步骤见 FINAL-DELIVERY.md。

## 1.1.0 后续未发布修复

当前修复暂未提交，不属于既有 `1.1.0` 标签；版本号保持不变。完整过程与能力边界见 [内核 / NTN 验证报告](../LINUX-NTN-VALIDATION.md)，人工功能用例共 239 项。

- `kernel-baseline-1.1.0.json`：已发布实现的内核基线，9,769 文件有效、53,274 文件预算遗漏。
- `kernel-index-1.1.0-unreleased.json`：修复后补全 63,043 文件，包含资源测量和 7 个独立定义探针；该轮复用了中断缓存，不是全冷启动。
- `kernel-warm-1.1.0-unreleased.json`：完整缓存新进程恢复，63,043 文件复用、0 重解析，函数/调用数量一致。
- `kernel-macro-audit-1.1.0-unreleased.json`：63,043 文件、5,895,940 个宏定义和 1,432,611 处替换名称独立审计，无遗漏或乱序；不代表已验证所有编译器语义。
- `kernel-large-macro-*-1.1.0-unreleased.json`：两个 23.9/15.6 MB 真实生成头文件的独立流式提取与宏覆盖压力验证。
- `kernel-lsp-1.1.0-unreleased.json`：使用用户指定的同一工程构建目录，三个真实 clangd 定义跳转场景。
- `kernel-cache-automated-1.1.0-unreleased.json`：470 项自动测试，469 通过、1 跳过；检查与类型验证通过。
- `ntn-index-initial-1.1.0-unreleased.json` / `ntn-index-complete-1.1.0-unreleased.json`：70,480 文件的初轮与新进程补齐到 70,482 文件的真实测量，保留末尾两文件预算不足的初始结果。
- `ntn-warm-1.1.0-unreleased.json`：70,482 文件全部复用、0 重解析，9 个独立定义探针通过，并核对重要诊断不被 C++ 大纲挤掉。
- `ntn-macro-audit-1.1.0-unreleased.json`：全库 119,626 个宏定义和 379,444 处替换文本名称核对，无遗漏或乱序。

实际 VSIX 宿主报告在打包之后单独保存，不修改历史报告中的被测包 SHA。当前内存保护为协作式预算；原生分配峰值和大文件/C++ 能力边界以完整报告为准。

- `host-kernel-ntn-cache-1.1.0-unreleased.json`：最终 VSIX 实际安装，23 通过 / 1 跳过；语义颜色配置作用域警告为 0，保留 clangd 19 一次提供者失败的日志计数。
- `runtime-kernel-ntn-cache-1.1.0-unreleased.json`：158 个运行时文件与最终源码相同，记录实际被测包 SHA、原 1.1.0 包完整性及检查时间。此报告在打包后归档，不将新增文档伪装为重打包后的重复安装测试。

## EXPORT_SYMBOL 引用角色修复（未发布）

- `kernel-export-references-1.1.0-unreleased.json`：真实 Linux 7.0 调度源码中 36 处导出宏的 clangd 复现，63 个导出位置符号项过滤、21 个参数声明标记纠正，物理定义保留。
- `export-references-checks-1.1.0-unreleased.json`：478 项自动测试，477 通过 / 1 因 clangd 版本跳过；源码检查和类型检查通过。完整人工功能用例增加到 245 项。

这部分修改不改变 facts-17，本地缓存继续复用；具体行为及原生大纲边界见 [导出宏修复](../EXPORT-SYMBOL-REFERENCE-FIX.md)。实际包的宿主报告在安装后单独归档。

- `host-export-references-1.1.0-unreleased.json`：最终导出宏验收包实际安装，24 通过 / 1 跳过，包含符号、主编辑器与 Context 的真实用例。
- `runtime-export-references-1.1.0-unreleased.json`：159 个运行文件无差异，保存被测 VSIX 的准确 SHA。

## 内核各类符号与 Context 文件候选（后续未发布修改）

本轮语法事实升级 facts-18；前一节“不改变缓存”的结论仅适用于独立导出宏修复。完整方法、各类型矩阵及纯本地差异见 [内核符号验证](../KERNEL-SYMBOL-VALIDATION.md)。

- `kernel-symbols-cold-1.1.0-unreleased.json`：63,043 文件全冷启动，749,271 函数、4,336,962 处调用，0 硬失败/预算遗漏；保留资源采样与 22,609 个恢复文件计数。问题详情原接口上限 5,000，归档不重复保存这份截断列表。
- `kernel-symbols-oracle-1.1.0-unreleased.json`：真实 clangd 引用参照、源码哈希及 20 类符号的唯一/重名/未知分类。项目外目标、未解析查询与自返回内建函数单独计数。
- `kernel-symbols-queries-1.1.0-unreleased.json`：新进程复用全部文件、0 重解析；生产 Worker 与真实 LanguageAdapter/Context 对照。自动模式 162/162 通过，本地 133 个同位置、4 个候选包含正确位置、11 个位置不同、14 个未命中，不将后两者合并为通过。
- `kernel-symbols-compiler-1.1.0-unreleased.json`：当前工程自身四个 ARM64 编译单元的实际参数及源码/构建副本哈希，四份内容均一致。
- `kernel-symbols-macros-1.1.0-unreleased.json`：全库宏与替换文本标识符词法审计，缺失及位置乱序均为 0。
- `kernel-symbols-preview-1.1.0-unreleased.json`：修复过程中的预检证据，明确使用旧库加当前源码覆盖，不能当作最终完整 Worker 验证。
- `symbol-context-checks-1.1.0-unreleased.json`：488 项自动测试，487 通过/1 跳过；源码、清单、文档及类型检查通过。人工验收用例为 255 项。
- `host-symbol-context-1.1.0-unreleased.json`：最终验收 VSIX 安装，24 通过/1 跳过；包含直接文件列表、选中状态与预览目标行的截图 SHA。保留原生提供者失败计数，不声明所有宿主日志无错误。
- `runtime-symbol-context-1.1.0-unreleased.json`：按报告列明的运行目录和清单核对 158 个文件，无差异，记录实际被测包 SHA。最终实测文档在测试后归档，不改写既有 VSIX 的测试身份。

## ESP32 条件头文件导航

- `esp32-includes-before-1.1.0-unreleased.json`：在真实 ESP32-Satellite 中复现 6 个项目头文件均无法预览、误列无关 SDK 的问题。
- `esp32-includes-fixed-1.1.0-unreleased.json`：复用全部 502 个文件、0 重解析，6 个头文件在 Context 与本地定义链接中均命中，缺失提示仅针对当前文件；VS Code API 使用测试适配，实际 Worker/LocalIndex/LanguageAdapter/Context 参与运行。
- `esp32-include-checks-1.1.0-unreleased.json`：删除用户指定的 clangd 20+ outgoing 测试后，498 项全部通过，0 失败、0 跳过，检查及类型验证通过。完整人工用例 263 项。此前报告保持当时的实际结果。

具体路径、测试方法及边界见 [ESP32 include 修复](../ESP32-INCLUDE-FIX.md)。真实安装与最终包身份在打包后单独归档。

- `host-esp32-includes-1.1.0-unreleased.json`：实际 VSIX 安装，25 项宿主检查通过、0 跳过，包含条件组件头文件的 Context 与原生定义链接验证及截图摘要。
- `runtime-esp32-includes-1.1.0-unreleased.json`：159 个运行文件无差异，记录标准文件名包的 SHA 和旧包归档摘要保持情况。
