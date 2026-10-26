# ESP32-Satellite 条件头文件导航修复

复现工程：`/home/guohao/Projects/ESP32-Satellite`，入口：`components/runtime/runtime.c`。只读取工程源码；验证缓存和报告写到工程外，没有修改工程的 SDK、编译配置或构建文件。

## 原因与修复

6 个项目头文件均存在。本地索引已保存它们的包含依赖，但符号定义查询没有将 include 字面路径映射为文件目标，文件名也不属于普通 C 标识符。语言服务没有结果时，Context 会错误地进入普通符号的未命中诊断，列出 sdkconfig.h、esp_err.h 等传递依赖，造成“当前项目头文件不存在”的误导。

现在单独解析真实 include 的完整路径，在当前项目已收录的文件中查找：引号包含优先相邻文件，其次工程正式 include 目录，再使用项目内匹配路径。不能确定时直接列候选，不猜测调用依赖。不使用其他工作区根的 SDK，不突破屏蔽规则。

Context、主编辑器 Ctrl+点击/F12 和 Context 内点击均可使用该路径。文件名含目录、连字符、点时保留完整链接；注释、raw 字符串和宏替换文本不会新增 include 跳转。未知条件保留用于阅读，已知未启用分支中的字面路径也可以打开，但不据此推断当前编译配置。

文件未找到时只提示当前头文件及检索/包含配置。此修复不展开任意 include 宏，也不代替当前工程的语言服务编译配置。解析事实仍为 facts-18，已有缓存不需要全量重建。

## 真实源码回归

修复前 6 个文件均复现用户提供的无关 SDK 清单；修复后 Context 与本地定义链接均通过。新进程复用全部 502 个文件、0 重解析、0 硬失败。既有的语法恢复、C++ 大纲及编码提示仍保留，不声称它们已经全部语义解析。

| include | 目标路径 |
| --- | --- |
| wifi_manager.h | components/network/include/wifi_manager.h |
| web_server.h | components/web/include/web_server.h |
| camera_service.h | components/camera/include/camera_service.h |
| storage_service.h | components/storage/include/storage_service.h |
| recording_service.h | components/recording/include/recording_service.h |
| monitor_web.h | components/monitor_web/include/monitor_web.h |

自动回归覆盖条件分支、项目隔离、重名候选、相邻优先、SQLite 恢复、编辑后的范围缓存、精确失败提示及 Context 字符串链接。用户要求删除依赖 clangd 20+ 的 outgoing 测试，Node 与宿主的对应版本跳过用例均已移除；最终结果在重跑后单独归档，不改写此前历史报告。真实 VSIX 宿主结果在安装后单独归档。

删除后重跑：498 项自动测试全部通过，0 失败、0 跳过；源码、清单、文档和类型检查通过。完整人工验收用例为 263 项。

人工步骤见 [完整验收用例](ACCEPTANCE-TESTS.md) 的 INCLUDE-01～06。真实源码证据保存在 `validation/esp32-includes-{before,fixed}-1.1.0-unreleased.json`。复现命令：

```sh
node scripts/validate-esp32-includes.js --root ~/Projects/ESP32-Satellite --cache /tmp/reader-esp32-includes --output /tmp/reader-esp32-fixed.json
```

该脚本通过实际 LocalIndex、索引 Worker、LanguageAdapter 和 Context 运行；VS Code API 使用测试适配，语义提供者返回空结果，以单独验证本地回退。实际编辑器安装测试另外进行。

## 最终安装验收

标准文件名 `dist/wanguo-sourceinsight-reader-1.1.0.vsix`，SHA-256：`b28867516a54b0253100d9e77989c3e27e05cf0871e8b5e28573c52ffe3a77bd`。生成前已归档上一份发布包及其校验记录，归档文件摘要保持一致。

VS Code 1.142.0 实际安装后：25 项宿主检查全部通过、0 跳过，包含 6 个条件头文件的 Context、原生定义链接、预览内导航与精确失败提示；159 个运行文件与最终源码一致。截图已查看，证据见 `validation/host-esp32-includes-1.1.0-unreleased.json`、`validation/runtime-esp32-includes-1.1.0-unreleased.json`。本节及宿主记录在测试后归档，不改变被测 VSIX 的身份。
