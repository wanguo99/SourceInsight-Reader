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
| Selection | #000080 / #ffffff | 编辑器及列表选中背景/前景 |
| Comment | #800080 | 注释 TextMate/语义/Context 词法 |
| Number / Ref to Const | #ff0000 | 数值、只读变量、枚举值 |
| Keyword / Reference | #008000 | 普通关键字和类型引用 |
| Control / Preprocessor | #000080，粗体 | 控制关键字、预处理 |
| Declaration | #000080，粗体 | 声明/定义语义修饰符 |
| Ref to Func | #008000，粗体 | 函数引用 |
| Ref To Local / Ref to Parameter | #008080 | 普通变量/参数 |
| String | #000080 | 字符串前景 |
| String.BackColor | #ffffbb | 仅 Context 字符串浅黄背景 |

0.7 按截图进一步校准：标题栏、编辑器标签栏、侧栏分节标题和工具栏使用浅灰 `#dbe2ea`，与灰蓝列表、浅绿代码区明确区分；底部空白区域灰色。Context 将导航、打开、浏览、锁定、刷新与模式按钮放到底部，文件符号原生树视图保留精简标题操作与菜单。0.8 起 Relation 改为与 Context 共用一个 Webview，独立右栏和底部按钮由插件控制，不再依赖原生视图拖放。原生 Explorer 无法通过颜色主题增加 SI 的多列交替条纹或把原生按钮任意移到底部；自定义 Context 可以实现底部工具栏。第三方文件图标主题的内嵌 SVG 颜色由图标主题控制。

主编辑器依赖语言的 TextMate/语义支持，语义服务未就绪时声明与引用可能不能精确区分。Context 使用基础词法，不声称具备同等语义分类。

## 使用与恢复

运行“Source Reader: 选择阅读主题”，选择 VS Code 或 Source Insight。默认 `sourceReader.appearance = vscode` 不改动主题。有工作区时写工作区 `workbench.colorTheme`；没有工作区时写用户级设置。首次切换保存对应层级的原值：原来没有工作区覆盖值时，恢复会删除临时覆盖，继续继承当时的用户主题，而不是硬编码一个旧主题。

快照保存在扩展的 workspaceState，重载后仍可恢复。通过 VS Code 原生主题选择器选到其他主题，会退出 Source Insight 模式并保留新选择。停用/卸载插件前建议先切回 VS Code 主题；停用不会自动撤回用户保存的主题设置。

可通过标准颜色定制继续调整：

```json
{
  "workbench.colorCustomizations": {
    "[Source Reader Source Insight]": {
      "editor.background": "#e6ffe3",
      "sourceReader.preview.commentForeground": "#800080"
    }
  }
}
```

当前版本不导入其他 XML，不改字体、字号、行高、缩进或快捷键。SI 的混合字号、文字阴影、全编辑器逐词字符串背景无法用 VS Code 颜色主题完整复刻；Context 可单独提供词法字符串背景。引用页使用编辑器主题变量自动跟随。

参考：[VS Code 颜色主题 API](https://code.visualstudio.com/api/extension-guides/color-theme)、[语义高亮](https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide)。
