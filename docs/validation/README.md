# 验证证据来源

这些 JSON 是本轮实际运行的报告，不是人工验收结果。不同报告记录各自测量时刻：

- `host-linux-vsix.json`：S6 最终应用代码的实际 VSIX 安装回归，Linux / VS Code1.142.0，18通过/1 outgoing跳过；截图位于本地 dist/settings-features.png、appearance-settings.png、reading-appearance.png、reading-folded.png。
- `accuracy-c.json`：S5 的18个标注语料场景，known与unknown单列。
- `benchmark-synthetic-s3.json`：S3合成测量；数据中的 working-tree 为测量时的开发快照，后续S3提交 fbbffc0。不外推真实项目性能。
- `soak-short.json`：S5实际4秒短跑，150轮/3重启；不是八小时验证。

宿主日志复核：插件自身的窗口级配置按资源读取警告已消除；clangd19 的 documentSymbol 取消与 outgoingCalls 不支持仍产生提供者日志，后者在截图期间触发过原生错误提示。outgoing 未计通过，正式门槛要求clangd20+并检查该现象是否消失；不能把18/1理解成零后端错误或完整语义支持。原始临时日志只在本机，不随脱敏诊断自动导出。

最终 VSIX 的 SHA 以 dist/*.vsix.sha256 为准；构建不会把 dist 的日志/截图纳入安装包。验收结果请另填 ACCEPTANCE-RESULTS-TEMPLATE.csv 的副本。
