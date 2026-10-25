# libbmc Context 错误跳转排查与配置


## 2026-10-25 实际工程修复

本次检查的是 `/home/guohao/am62x/workspace/libbmc` 原工程。`BMC_EPDU_COMMAND_POWER_STAT_GET` 定义在 `include/bmc/epdu/bmc_epdu.h:169`，`src/epdu/bmc_epdu_command.c:17` 使用它。本地语法索引能按当前项目头文件定位；主编辑器诊断来自 clangd，两个后端需要的上下文不同。

根因已复现：项目没有 `.clangd`、`compile_commands.json` 或 `compile_flags.txt`。clangd 使用通用回退命令，先报首行 `bmc/epdu/bmc_epdu.h` 找不到，再连带报告枚举、uint16_t 和结构体未声明，共 21 个错误。不能通过本地索引存在该枚举来清除编译器诊断，也不能把宏/枚举定义伪造为编译参数。

经系统授权，已在原工程新增以下配置，并生成 `build/clangd/compile_commands.json`：

```yaml
# EPDU reading configuration; regenerate with production options/toolchain for a full build.
CompileFlags:
  CompilationDatabase: build/clangd
```

```sh
cmake -S /home/guohao/am62x/workspace/libbmc \
  -B /home/guohao/am62x/workspace/libbmc/build/clangd \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DBMC_BUILD_CORE=OFF -DBMC_BUILD_EPDU=ON \
  -DBMC_BUILD_SAMPLES=OFF -DBUILD_TESTING=OFF
```

该数据库有 17 个编译单元，其中 EPDU 9 个；包含真实项目 `include` 路径。当前完整默认配置缺少 libcurl 开发依赖，所以这是一套 EPDU 阅读配置，不能冒充完整生产/AM62x 交叉编译数据库。生产构建应在依赖与实际工具链就绪后，用真实选项重新生成。`.gitignore` 仅增加 `/build/clangd/` 与 `/.cache/clangd/`；业务源码和默认 CMakeLists 未改动，配置修改未提交。

验证：不再显式传入 `--compile-commands-dir`，clangd 自行读取原工程 `.clangd` 后，`bmc_epdu_command.c` 与 `bmc_epdu.h` 的 `--check` 均为 0 errors；真实 LSP 发布给编辑器的 diagnostics 为空，定义精确返回该头文件第 169 行。原 VS Code 窗口可执行一次 **clangd: Restart language server** 刷新旧诊断。

## 本地解析恢复修复

还复现了状态中的两个恢复文件，二者与上述 clangd 缺头文件问题独立：

- `samples/bmc-test/epdu/bmc_test_telemetry.c`：同一功能宏在分离的 `#if BMC_HAS_COLLECTOR` 中打开/关闭括号，普通预处理语法树吞掉整个 `bmc_test_telemetry` 定义。本次仅对原本存在恢复且不超过 2MiB 的文件，尝试保留未知分支内容的块内指令投影；替代语法树须完全有效，并且不能减少已识别函数。原本有效的语法树保持原样，不选定任意编译分支。
- `src/backend/redfish/bmc_redfish_inventory.c`：`cJSON_ArrayForEach` 为循环宏，普通 C 语法树会恢复一个缺分号节点；未展开宏不等于业务代码缺分号。本次补齐未命名 MISSING 标点的位置，问题列表可定位第 306 行（另一个点在 403 行），保留该文件的 11 个函数。完整语义仍需 cJSON/Redfish 依赖与相应编译配置。

实际本地结果从 **145 文件、630 函数、5114 调用、2 个恢复文件** 改为 **145 文件、631 函数、5193 调用、1 个恢复文件**，处理失败为 0。新增的函数和调用来自恢复的 telemetry 函数体；不是隐藏诊断。解析事实版本升级 facts-15，旧 facts-14 自动重建，SQLite schema 仍为 4，扩展版本保持 1.1.0。

专项回归：`test/libbmc-indexing.test.js` 4 项，覆盖跨条件括号、已有效树/未知分支、缺失标点定位和本地枚举导航；真实 clangd 回归覆盖“缺 include 时未声明 → 配置编译数据库后编辑器诊断清空且定义正确”。实际结果及最终包校验值见 `validation/libbmc-enum-fix-1.1.0.json`。人工验收见 `LIBBMC-01`～`LIBBMC-05`。

后文保留上一次副本验证的历史，当前原工程配置和能力以上述记录为准。

历史验证日期：2026-10-18；clangd 19.1.7。源码副本位于 `/home/guohao/vscode-plugin/source-example`。

## 2026-10-18 历史副本排查

原工程没有找到编译数据库。`clangd --check` 报告首行头文件 `bmc/epdu/bmc_epdu.h` 找不到，后续类型、宏等也无法正常解析。

只打开 `src/epdu/bmc_epdu_command.c`、不配置 include 路径时，直接通过 clangd LSP 查询：

- 查询 `bmc_epdu_query_decode` 中第 170 行的 `bmc_epdu_frame_parse`。
- `textDocument/definition` 返回同一文件第 105 行，即 `bmc_epdu_command_frame_decode` 内的调用位置。
- 返回来自 clangd 本身，尚未经过插件的位置转换或渲染。这与用户报告一致。

这是头文件缺失、解析错误恢复时出现的错误目标，不应将该调用点视为真实函数定义。实际定义是 `src/epdu/bmc_epdu_frame_codec.c:46`，声明是 `include/bmc/epdu/bmc_epdu.h:269`。

## 副本中已应用的配置

新增 `.clangd`：

```yaml
CompileFlags:
  CompilationDatabase: build/clangd
Index:
  Background: Build
```

执行以下命令生成 EPDU 阅读使用的编译数据库：

```bash
cmake -S /home/guohao/vscode-plugin/source-example \
  -B /home/guohao/vscode-plugin/source-example/build/clangd \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DBMC_BUILD_CORE=OFF -DBMC_BUILD_SAMPLES=OFF -DBUILD_TESTING=OFF
```

这次只生成构建系统和编译数据库，没有编译或修改业务源码。默认完整工程的 CMake 配置在当前环境缺少 `pkg-config`；因此临时关闭 CORE、样例和测试来生成覆盖 EPDU 的有效配置，不代表完整工程的生产构建配置。将来安装完整构建依赖后，应按实际生产选项重新生成数据库。

已在副本 `.gitignore` 中排除 `build/clangd/` 和 `.cache/clangd/`。编译数据库包含当前机器的绝对路径；复制到 Windows 或其他目录后需要在当地重新生成。

## 验证结果

- `clangd --check=.../src/epdu/bmc_epdu_command.c`：0 errors。
- 使用副本根目录初始化 clangd，不添加额外 fallback flags，仅打开 `bmc_epdu_command.c`。
- 启用后台索引后，同一个第 170 行调用的 `textDocument/definition` 正确返回 `bmc_epdu_frame_codec.c` 第 46 行、第 5 列。
- 不需要提前打开实现文件，也不需要修改插件或业务函数。

在 VS Code 中打开副本，执行 **clangd: Restart language server**，等待索引后重新选择该调用。如果已有 `clangd.arguments` 禁用了后台索引或显式指定了另一个编译数据库目录，需要先调整这些旧参数。若需要将此配置用于原工程，请在原工程内生成数据库并复制上述相对路径 `.clangd`，不要复用副本的绝对路径数据库。

以上为真实 clangd 协议与检查命令验证；当前环境不能启动 Electron，未声称已完成实际 Context UI 验收。

参考：[clangd 配置](https://clangd.llvm.org/config)、[编译命令与解析环境](https://clangd.llvm.org/design/compile-commands)。
