# 支持、反馈与商用验收

先运行“SourceInsight-Reader: 能力与工程诊断”。C 基础阅读可选 local；C++/Java/Python 检查配套语言扩展是否就绪，C/C++ 检查 compile_commands.json / compile_flags.txt 及实际编译参数。超时可刷新；工作区范围变化后旧结果会失效；编码/缓存/Worker 故障可尝试重建索引并查看输出。

提交问题时提供：插件版本/提交、VS Code/系统、Remote 类型、语言扩展和服务器版本、后端模式、最小复现步骤、实际与期望位置、是否未保存、排除规则和诊断 JSON。请使用可公开最小样例，勿直接上传私有源码、令牌、原始构建参数或未经检查的日志。

问题分流：错误确定跳转、源码/配置被覆盖、无法恢复的工作区数据丢失优先处理；其次是挂起/崩溃、核心阅读失败；界面和增强需求单独记录。仓库 Issues 地址见 package.json 的 bugs 字段。维护人尚未承诺响应时限、付费支持或商业 SLA；MIT 授权不等于服务合同。

正式商用发布前应完成 [支持矩阵](docs/SUPPORT-MATRIX.md) 中待验环境、干净安装/跨版本升级/回滚、8 小时稳定性与 [Beta 任务](docs/BETA-VALIDATION.md)。当前为用户指定的 1.0.10 本地发布包，未创建远端标签或 Marketplace 发布。

索引内存不足：当前支持 indexMemoryLimitMb（默认1024MiB）。接近预算时显示不完整结果；若发生真正 OOM，不再自动重启。可调整上限或屏蔽范围，再运行“重建本地 C 调用索引”。新版会自动使旧解析缓存失效，无需删除工程文件。见 docs/INDEX-MEMORY-FIX.md。
