# 1.1.0 C 着色回退修复

本报告保留此前1.1.0验收包的验证记录。用户已确认修复可用，当前按用户指定将完整修复整合为1.0.10发布包；下方复现命令使用当前发布包名。

## 现场结论

用户提供的 `resource/SourceInsight_layout_2.png` 中，`oaioran.c` 的关键字、字符串及部分调用仍有颜色，但变量、字段等缺少分类色，主编辑器和 Context 都受影响。本地工程索引已完成，因此重建索引不会直接修复这条着色链路。

2026-10-24 的 Remote clangd 日志明确包含 `Failed to find compilation database`，目标是该文件；clangd 使用默认命令解析，并报告 IncludeCleaner 缺失路径。语言服务虽能返回部分结果，却缺少工程实际头文件路径和宏等配置；不能把已安装 clangd 或本地索引完成视为编译语义完整。

原实现主编辑器依靠原生 TextMate 和外部语义标记，Context 复用这两者；本地 C 索引没有为它们补充颜色。主题将普通标识符默认设成黑色，因此未得到语义分类的变量显示为黑色。该现象与截图及日志一致。

## 实现与边界

- 新增独立单文件 Tree-sitter C 着色，不依赖 `indexEnabled`、索引进度和跨文件绑定。识别函数、参数、变量、static、字段、类型、同文件宏和枚举；保留声明与引用区别、局部遮蔽和函数指针的变量身份。
- 主编辑器使用可见区域装饰，Context 使用同一份分类；不注册竞争的语义提供者。已有外部语义标记覆盖的位置全部让出，部分重叠也不覆盖。晚就绪的语言服务通过可见 C 编辑器约3秒一次的检查接管其分类。
- 仅在 SourceInsight-Reader Source Insight 主题、语言模式 C、允许的项目范围和语义着色开启时工作。尊重资源/语言/主题作用域的语义颜色及显式关闭；切换主题、编辑和关闭会丢弃旧装饰/响应。不修改工程或用户设置。
- 解析在线程内执行：JS 堆128MiB、单文件UTF-8最多2MiB、解析和提取各约1秒、请求总预算3秒；缓存最多2个文档，一个在途及两个等待请求，可见区域最多5000个装饰。空闲30秒释放线程，异常后冷却5秒；失败文档的同一版本不自动重试，修改或重新打开后可恢复，其他正常文件继续可用。WASM及进程总内存不等于JS堆限制。
- 外部语义查询有1.5秒显示预算，最多4个真实在途文档；超时继续占槽直到真正完成，防止轮询不断积累挂起请求。旧文档版本和替换后的预览不能使用迟到响应。
- 这是语法角色着色：不展开宏、不解释条件编译、不跨头文件建立精确类型绑定，也不判断运行时回调目标。C++、Java、Python沿用既有语言服务。超预算/失败保留原生 TextMate 和外部语义着色。

获得完整工程语义仍应通过工程正常构建生成 `compile_commands.json`，让 clangd 使用实际编译参数。此次没有在用户的 OAI 源码目录生成或修改配置。

## 验收样例

选择 Source Insight 主题，将文件语言设为 C，关闭 clangd 和本地工程索引，打开：

```c
struct R { int field; };
enum E { READY };
static int count;
int leaf(int value) { return value; }
int run(struct R *r) {
  int local = leaf(r->field);
  return local + count + READY;
}
```

默认颜色下，声明为蓝色（static变量按更具体规则为紫色），普通变量引用青色，static引用紫色，字段和直接调用绿色，同文件枚举引用红色。Context 与主编辑器共享分类；外观设置与语言服务可改变这些颜色。按完整用例 [COLOR-01～06](ACCEPTANCE-TESTS.md) 记录结果。

## 自动验证

新增15项回归，覆盖真实WASM/Worker、作用域/回调、版本与迟到响应、外部语义优先、用户配置、资源预算、故障冷却和真实在途限流。全量单元测试325项，构建与资源/SHA验证通过。

Linux / VS Code1.142.0 的实际VSIX临时Profile验证：不安装clangd、关闭工程索引，4项离线宿主检查通过；包括主编辑器与Context、自定义颜色、未保存编辑、显式关闭和主题切换，以及用户实际oaioran.c的只读副本。完整宿主18项通过、1项因clangd19缺少outgoing能力跳过。报告见 [离线宿主](validation/host-offline-colors-linux-vsix.json) 和 [完整宿主](validation/host-color-fix-linux-vsix.json)。截图位于本地dist/offline-c-colors.png、offline-oai-colors.png。

实际oaioran.c约29KB，单次本地解析得到1296个分类跨度，含初始化约77毫秒；这是单文件本机测量，非跨平台性能承诺。用户实机验收另行填写，不能由自动结果替代。

复现命令（仅向临时workspace复制输入文件）：

```sh
npm run test:host -- --headless --offline-colors --vsix=dist/wanguo-sourceinsight-reader-1.0.10.vsix
# 可选：设置 SOURCEINSIGHT_READER_COLOR_FIXTURE 为 oaioran.c 的绝对路径，添加实际文件对照；--capture-ui 保存界面截图。
```
