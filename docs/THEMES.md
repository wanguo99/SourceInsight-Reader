# Source Insight 阅读主题

## 来源与映射

基于用户提供的 `SourceInsight_Configuration.xml`，AppVer 4.00.0084。文件实际包含 Markdown 标题与 XML 代码块；本版本人工映射其中的 DisplayColors、Styles 及 ParentStyle 继承，不在运行时解析或加载任意 XML，也不打包该文件中的其他个人配置。

源文件 SHA-256：`f658502aac985c1ff72a48212681011d4a56893e582220144a4697e82371a372`。

| XML 项目 | 值 | VS Code 映射 |
| --- | --- | --- |
| WindowBackground / ContextWindow.BackColor | #e6ffe3 | editor.background、panel.background、Context |
| DefaultText | #000000 | editor.foreground |
| FrameBackground | #dbe2ea | 标题栏、侧栏分节标题、标签栏 |
| SymbolPane.BackColor / 截图 | #c5d2de | 0.7 起 Explorer 与文件符号列表灰蓝背景 |
| DefaultPanelFontAndColor.BackColor | #ffffff | 输入框背景 |
| Selection（可读性调整） | #fff2cc / #000000 | 编辑器暖黄选中；列表使用浅蓝底深色字 |
| Comment | #800080 | 注释 TextMate/语义/Context 词法 |
| Number / Ref to Const（可读性调整） | #c00000 | 数值、只读变量、枚举值 |
| Keyword / Reference | #008000 | 普通关键字和类型引用 |
| Control / Preprocessor | #000080，粗体 | 控制关键字、预处理 |
| Declaration | #000080，粗体 | 声明/定义语义修饰符 |
| Ref to Func | #008000，粗体 | 函数引用 |
| Ref To Local / Ref to Parameter（可读性调整） | #006b6b | 普通变量/参数 |
| String | #000080 | 字符串前景 |
| String.BackColor | #ffffbb | 仅 Context 字符串浅黄背景 |

0.7 按截图进一步校准：标题栏、编辑器标签栏、侧栏分节标题和工具栏使用浅灰 `#dbe2ea`，与灰蓝列表、浅绿代码区明确区分；底部空白区域灰色。Context 将导航、打开、浏览、锁定、刷新与模式按钮放到底部，文件符号原生树视图保留精简标题操作与菜单。0.8 起 Relation 改为与 Context 共用一个 Webview，独立右栏和底部按钮由插件控制，不再依赖原生视图拖放。原生 Explorer 无法通过颜色主题增加 SI 的多列交替条纹或把原生按钮任意移到底部；自定义 Context 可以实现底部工具栏。第三方文件图标主题的内嵌 SVG 颜色由图标主题控制。

主编辑器依赖语言的 TextMate/语义支持，语义服务未就绪时声明与引用可能不能精确区分。Context 使用词法着色，0.10.5 增强类型、宏、成员、预处理及多行内容的分类，并按文档版本缓存词法状态；不声称具备同等语义分类。工程文件视图复用当前文件图标主题的字体 / 图片资源及明暗变体，主题缺失或无法读取时回退通用图标。

## 使用

统一使用 VS Code **首选项：颜色主题**（Ctrl+K，再 Ctrl+T），在与其他主题同级的列表中选择 **SourceInsight-Reader Source Insight**，也可在该列表切换到任意其他主题。VS Code 自行管理 `workbench.colorTheme` 的作用域和保存。

0.10.16 移除自动切换、插件专用 `appearance` 配置及主题选择 / 恢复命令，旧配置和旧快照不再参与任何行为。升级保留当前主题；插件功能设置通过各主视图标题栏齿轮进入，只包含阅读、索引、布局等功能。

可通过标准颜色定制继续调整：

```json
{
  "workbench.colorCustomizations": {
    "[SourceInsight-Reader Source Insight]": {
      "editor.background": "#e6ffe3",
      "sourceInsightInspired.preview.commentForeground": "#800080"
    }
  }
}
```

当前版本不导入其他 XML，不改字体、字号、行高、缩进或快捷键。SI 的混合字号、文字阴影、全编辑器逐词字符串背景无法用 VS Code 颜色主题完整复刻；Context 可单独提供词法字符串背景。引用页使用编辑器主题变量自动跟随。

参考：[VS Code 颜色主题 API](https://code.visualstudio.com/api/extension-guides/color-theme)、[语义高亮](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)。

## 0.10.12 选中与匹配可读性

编辑器选中背景改为浅暖黄 `#fff2cc`，避免语法前景未被替换时宏、声明、字符串与深蓝底重叠。非活动选中、同名符号及当前行使用浅色背景；同名符号增加边框区分。数字红色和变量青色略微加深，主题内 TextMate、语义与 Context 配色同步调整。自动检查主题语法前景在普通代码、活动/非活动选中、同名符号、当前行和查找背景上的对比度，均至少 4.5:1。

Context 和字符检索匹配使用成对的黑字 / 暖黄底，可通过 `sourceInsightInspired.preview.matchForeground`、`sourceInsightInspired.preview.matchBackground` 自定义。Webview 的鼠标文本选择统一设置前景与背景；引用、字符检索、Relation 图节点选中也同步采用列表选中前景，避免第三方深色主题下仅换背景而保留旧文字色。原生列表的选中改为浅蓝底深色字，文件图标和名称命中高亮也避免深蓝底深蓝字。

## 0.10.15 原生同名黄色高亮

内置主题的 `editor.selectionHighlightBackground`、`editor.wordHighlightBackground`、`editor.wordHighlightStrongBackground`、`editor.wordHighlightTextBackground` 统一为半透明黄色 `#ffff0080`，对应边框为 `#b08a26`，保留语法前景。透明度避免覆盖底层装饰；对比度检查按编辑器背景进行透明合成计算。固定高亮使用同一黄色背景 / 边框并指定黑字，F2 将目标保存至 workspaceState，重载后恢复；取消 / 清除删除该工作区记录。
