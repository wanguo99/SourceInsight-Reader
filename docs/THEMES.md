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
| String.BackColor（对齐主编辑器） | 透明 | Context 不额外设置字符串底色 |

0.7 按截图进一步校准：标题栏、编辑器标签栏、侧栏分节标题和工具栏使用浅灰 `#dbe2ea`，与灰蓝列表、浅绿代码区明确区分；底部空白区域灰色。Context 将导航、打开、浏览、锁定、刷新与模式按钮放到底部，文件符号原生树视图保留精简标题操作与菜单。0.8 起 Relation 改为与 Context 共用一个 Webview，独立右栏和底部按钮由插件控制，不再依赖原生视图拖放。原生 Explorer 无法通过颜色主题增加 SI 的多列交替条纹或把原生按钮任意移到底部；自定义 Context 可以实现底部工具栏。第三方文件图标主题的内嵌 SVG 颜色由图标主题控制。

主编辑器依赖语言的 TextMate/语义支持，语义服务未就绪时声明与引用可能不能精确区分。Context 使用语言扩展的 TextMate 语法和同一语义 token 提供者，缺失时采用基础词法回退；不自行推断完整语义。工程文件视图复用当前文件图标主题的字体 / 图片资源及明暗变体，主题缺失或无法读取时回退通用图标。

## 使用

Source Insight 主题按符号范围区分函数定义和声明中的返回类型、函数名和参数。主编辑器保留现有颜色，返回类型加粗，函数名采用 900 字重及 0.5px 字距，参数恢复常规字重；原生装饰 API 不支持给单个符号设置字号。Context 中函数名使用 116% 字号及 900 字重，参数使用 94% 字号及常规字重。函数体和调用处不套用定义名称的强调，多行返回类型同样生效。

Context 的颜色直接复用主题的 TextMate 和语义配色规则，不维护另一套变量或函数颜色。语言服务可用时，使用主编辑器同一个语义 token 提供者区分函数、变量、参数、静态变量、成员和枚举值，并沿用语义颜色自定义规则；不可用或关闭语义高亮时使用主题已有的词法配色，不阻塞预览。其他主题仍使用原有的主题变量回退。

主编辑器强调随符号列表更新，不额外发起索引扫描；源码修改后清除过期范围，符号刷新后恢复。切换到其他主题会取消该强调。Context 的函数头强调在符号可用后补充，不阻塞源码预览；不完整的符号范围不会用于加粗整个函数体。

统一使用 VS Code **首选项：颜色主题**（Ctrl+K，再 Ctrl+T），在与其他主题同级的列表中选择 **SourceInsight-Reader Source Insight**，也可在该列表切换到任意其他主题。VS Code 自行管理 `workbench.colorTheme` 的作用域和保存。

0.10.16 移除自动切换、插件专用 `appearance` 配置及主题选择 / 恢复命令，旧配置和旧快照不再参与任何行为。升级保留当前主题；功能设置和外观设置统一从各主视图标题栏的设置齿轮进入。

可通过标准颜色定制继续调整：

```json
{
  "workbench.colorCustomizations": {
    "[SourceInsight-Reader Source Insight]": {
      "editor.background": "#e6ffe3",
      "sourceInsightReader.preview.commentForeground": "#800080"
    }
  }
}
```

安装和激活不会自动修改字体或颜色主题；只有在外观页保存修改后才写入所选作用域。原生编辑器不使用非公开 CSS 注入设置混合字号；Context 支持函数名和参数的局部字号。引用页使用编辑器主题变量自动跟随。

参考：[VS Code 颜色主题 API](https://code.visualstudio.com/api/extension-guides/color-theme)、[语义高亮](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)。

## 0.10.12 选中与匹配可读性

编辑器选中背景改为浅暖黄 `#fff2cc`，避免语法前景未被替换时宏、声明、字符串与深蓝底重叠。非活动选中、同名符号及当前行使用浅色背景；同名符号增加边框区分。数字红色和变量青色略微加深，主题内 TextMate、语义与 Context 配色同步调整。自动检查主题语法前景在普通代码、活动/非活动选中、同名符号、当前行和查找背景上的对比度，均至少 4.5:1。

Context 和字符检索匹配使用成对的黑字 / 暖黄底，可通过 `sourceInsightReader.preview.matchForeground`、`sourceInsightReader.preview.matchBackground` 自定义。Webview 的鼠标文本选择统一设置前景与背景；引用、字符检索、Relation 图节点选中也同步采用列表选中前景，避免第三方深色主题下仅换背景而保留旧文字色。原生列表的选中改为浅蓝底深色字，文件图标和名称命中高亮也避免深蓝底深蓝字。

## 0.10.15 原生同名黄色高亮

内置主题的 `editor.selectionHighlightBackground`、`editor.wordHighlightBackground`、`editor.wordHighlightStrongBackground`、`editor.wordHighlightTextBackground` 统一为半透明黄色 `#ffff0080`，对应边框为 `#b08a26`，保留语法前景。透明度避免覆盖底层装饰；对比度检查按编辑器背景进行透明合成计算。固定高亮使用同一黄色背景 / 边框并指定黑字，F2 将目标保存至 workspaceState，重载后恢复；取消 / 清除删除该工作区记录。

## 外观配置菜单与截图对照

以 `resource/SourceInsight_layout_1.png` 为界面参考：保留浅绿代码区、灰蓝文件列表、灰色 Relation 区域；Relation 使用紧凑方角卡片、细边框、红色连线和符号图标。前 3 处调用行号直接列在卡片下方，可点击预览；更多位置通过“全部调用点”选择。卡片高度随调用点数量和字号调整。

统一入口为各阅读视图标题栏的设置齿轮，或命令 **SourceInsight-Reader: 设置**；直接打开同一配置页的 **功能设置 / 外观设置** 两个标签。原有单独的外观按钮已移除。支持分类跳转、筛选、颜色选择器、字体输入、默认值回填和作用域选择。切换标签保留输入，默认值仅影响当前标签；两页共用“保存并应用”和“保存并重载窗口”，校验或保存失败时不执行重载。功能配置仍保存到原来的 `sourceInsightReader.*` 配置键，保持现有工程和用户配置兼容。

| 配置类别 | 保存位置 | 生效范围 |
| --- | --- | --- |
| 符号定义 / 引用颜色 | `editor.semanticTokenColorCustomizations` 中的主题规则 | 主编辑器和 Context；依赖语言服务提供正确分类 |
| 语法颜色 | `editor.tokenColorCustomizations` 中的主题 TextMate 规则 | 主编辑器和 Context |
| 窗口 / Relation 卡片颜色 | `workbench.colorCustomizations` 中的主题颜色 | Source Insight 主题 |
| 主编辑器字体 | `editor.fontFamily`、`fontSize`、`fontWeight` | 原生编辑器及继承其字体的预览 |
| 各面板字体、默认文字和背景 | `sourceInsightReader.appearance.panes` | 对应阅读面板；空值继承 |
| 折叠按钮显示方式 | `editor.showFoldingControls` | 原生编辑器左侧折叠栏 |
| 方框加减图标 | `workbench.productIconTheme` | 仅替换原生折叠相关图标，其余图标继承默认 |

宏和枚举成员的默认定义 / 声明颜色为 `#000080`，引用为 `#c00000`，不将此规则推广到其他符号。没有语义分类时，基础词法的宏形式分类仅为启发式，不能准确区分宏、枚举成员和普通大写变量，也不保证定义 / 引用区分。Context 的字符串不再叠加独立浅黄底，运算符、标点、作用域限定和自定义加粗 / 斜体采用原生语法规则。

VS Code 的括号配对层级色、诊断、活动括号和内嵌提示属于编辑器装饰，不由 TextMate / 语义主题提供，Context 不复刻这些装饰。主编辑器的函数独立字号及把原生折叠按钮插入源码文字前不受公开 API 支持；采用独立函数名字重和代码左侧常驻折叠栏。
