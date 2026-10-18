# libbmc Context 错误跳转排查与配置

验证日期：2026-10-18；clangd 19.1.7。源码副本位于 `/home/guohao/vscode-plugin/source-example`。

## 已复现的原因

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
