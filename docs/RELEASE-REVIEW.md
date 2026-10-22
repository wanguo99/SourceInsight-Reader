# 1.0.8 发布前检查记录

检查日期：2026-10-22。运行环境：Node.js 22.23.3、VS Code 1.142.0、Linux Xvfb、clangd 19。

## 发布内容

- 自定义设置页包含功能 / 外观两个标签，覆盖 25 项功能与 100 项外观配置；切换标签保留输入，保存前校验，只写修改项。
- 支持保存并应用、保存成功后重载窗口；校验或写入失败时保留输入，不执行重载。
- Context 使用已安装语言的 TextMate 语法与编辑器语义样式，宏和枚举成员默认蓝色定义、红色引用；锁定预览仍可完成异步着色。
- Relation 使用紧凑方角卡片、可配置连线及卡片颜色，直接显示可点击的调用行号，并保留过期位置保护。
- 原生折叠按钮默认常驻，展开为方框减号、折叠为方框加号。
- 保留 1.0.7 的本地 C 定义、字段逐层定位、范围过滤、索引和导航修复。

## 验证结果

- `npm run check`：通过，包含 JavaScript 语法、类型、命令注册、版本及 vendored 资源校验和检查。
- `npm test`：227 项测试，226 项通过、1 项跳过、0 失败，包含真实 clangd 集成。
- `env -u DISPLAY npm run test:host`：17 项通过、1 项跳过、0 失败，覆盖真实 VS Code API、同位置配色、自定义设置页及功能 / 外观混合保存。
- 跳过项是 clangd outgoing calls，当前 clangd 19；该能力要求 clangd 20 及以上，本地 C 调用关系另有独立回归。
- 此前使用同一实现运行截图验收：`dist/settings-features.png`、`dist/appearance-settings.png`、`dist/reading-appearance.png`、`dist/reading-folded.png`。
- `package.json`、lockfile 根版本、安装文档、功能清单及更新记录统一为 1.0.8；原有 npm 依赖版本保持不变。

## 发行产物与流程

按用户指示统一提交本轮修改，推送主分支并创建、推送 annotated tag `v1.0.8`。不改写既有标签，也不执行 Marketplace 发布。

运行 `npm run package` 生成 `dist/wanguo-sourceinsight-reader-1.0.8.vsix`。校验 ZIP 完整性、扩展版本、运行时源码、TextMate / Oniguruma 资源、许可证和折叠图标字体；排除开发目录和测试输出。VSIX 与截图位于忽略的 `dist/`，不加入源码提交。

## 验收边界

- 本轮自动化及宿主验收运行于 Linux；不把模拟 Windows URI 回归写成 Windows 或 Remote 实机验收。Remote 安装到工作区所在扩展主机，路径使用该主机的文件系统。
- C 本地索引无需编译或语言服务，不执行宏展开和条件编译求值，也不保证间接调用及复杂类型推导。C++ / Java / Python 的完整语义查询由语言扩展提供。
- 宏和枚举成员的精确定义 / 引用着色依赖语义分类；语法回退不能代替语言服务。
- Context 不复制原生括号层级色、诊断和内嵌提示。公开 API 不支持主编辑器单符号字号或把原生折叠控件任意插入源码。
- 配置逐项写入，写入失败时提示可能已有部分设置生效，可重试；不承诺跨配置键的原子事务。

完整功能及回归入口见 [功能清单](FUNCTIONAL-CHECKLIST.md)。
