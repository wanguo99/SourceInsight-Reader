# SourceInsight-Reader

[English](README.en.md)

Source Insight 风格的 VS Code 代码阅读插件。通过工程文件、符号列表、定义预览和调用关系面板，在当前位置理解代码、追踪调用并保存阅读进度。

## 功能介绍

| 功能 | 说明 |
| --- | --- |
| 工程浏览 | 浏览多文件夹工程，按文件名或路径查找文件，批量屏蔽不需要的目录和文件。 |
| 符号导航 | 查看当前文件的函数、变量、宏、枚举和类型，跟随当前函数，搜索工程符号。 |
| 定义预览 | 在 Context 面板查看定义和声明，保留主编辑器位置；支持锁定、历史记录、预览内查找和旁侧打开。 |
| 调用关系 | 在 Relation 图或大纲中浏览调用者、被调用者，查看并跳转到具体调用位置。 |
| 引用与搜索 | 查找符号引用并查看源码片段；支持全文、正则和多行搜索，保存查询记录。 |
| 阅读记录 | 保存书签、笔记和阅读任务，重新打开工程后继续阅读。 |
| 本地索引 | 内置离线 C 索引与 C++ 语法大纲；索引持久化、增量更新，可复用父子目录缓存，支持受 CPU 和内存预算约束的并行解析。缓存管理菜单显示大小，支持单项和批量清理，保护使用中的缓存。 |
| 阅读外观 | 提供 Source Insight 主题、C 语法补色，以及字体、颜色、背景和可选快捷键预设。 |

C 基础阅读无需编译或安装语言服务。本地索引不执行完整的宏展开和条件编译求值；完整语义分析由对应语言扩展提供。每个工作区文件夹独立索引。

## 安装与使用

需要 **VS Code 1.106.0 或以上版本**。

1. 准备发布包 `wanguo-sourceinsight-reader-1.1.2.vsix`。
2. 在 VS Code 中打开扩展视图，点击右上角 **… → 从 VSIX 安装…**，选择该文件。
3. 打开源码文件夹，在命令面板运行 **SourceInsight-Reader: 打开阅读工作台**。
4. 打开源码文件并选择符号，在 Context 中查看定义，在 Relation 中浏览调用关系。

也可以使用命令行安装：

```sh
code --install-extension ./wanguo-sourceinsight-reader-1.1.2.vsix
```

按工程语言配置语义能力：

| 语言 | 配置说明 |
| --- | --- |
| C | 可直接使用内置索引；需要准确反映编译选项和条件编译时，配置 clangd 与 `compile_commands.json`。 |
| C++ | 内置符号大纲和宏导航；完整定义、引用及调用关系需配置 clangd 与 `compile_commands.json`，语义 outgoing 调用需 clangd 20+。 |
| Java | 安装 Red Hat Java 扩展，使用标准模式并正确加载工程。 |
| Python | 安装 Python 和 Pylance 扩展，选择工程解释器。 |

首次使用可运行 **SourceInsight-Reader: 入门指南**；结果缺失时运行 **能力与工程诊断**。外观和功能选项通过 **SourceInsight-Reader: 设置** 调整。

[配置说明](docs/CONFIGURATION.md) · [功能与环境支持](docs/SUPPORT-MATRIX.md) · [测试用例](docs/ACCEPTANCE-TESTS.md) · [问题反馈](SUPPORT.md)

固定 / 取消同名符号高亮：主编辑器及 Context 使用 **F8**，也可使用 **Ctrl+Alt+H**（macOS：Cmd+Alt+H）。F2 默认保留重命名，可在插件设置中启用 F2 高亮。F8 在主编辑器内覆盖 VS Code 的“下一个问题”；可通过“键盘快捷方式”自行调整。启用 Source Insight 快捷键后，主编辑器使用 **Alt+F8 / Alt+Shift+F8** 浏览查询结果；结果列表内仍使用 F8 / Shift+F8。
