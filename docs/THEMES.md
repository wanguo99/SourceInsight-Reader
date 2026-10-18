# Source Insight 阅读主题

## 来源与映射

基于用户提供的 `SourceInsight_Configuration.xml`，AppVer 4.00.0084。文件实际包含 Markdown 标题与 XML 代码块；本版本人工映射其中的 DisplayColors、Styles 及 ParentStyle 继承，不在运行时解析或加载任意 XML，也不打包该文件中的其他个人配置。

源文件 SHA-256：`f658502aac985c1ff72a48212681011d4a56893e582220144a4697e82371a372`。

| XML 项目 | 值 | VS Code 映射 |
| --- | --- | --- |
| WindowBackground / ContextWindow.BackColor | #e6ffe3 | editor.background、panel.background、Context |
| DefaultText | #000000 | editor.foreground |
| FrameBackground | #dbe2ea | 标题栏、侧栏分节标题、标签栏 |
| DefaultPanelFontAndColor.BackColor | #ffffff | 侧栏、输入框及列表 |
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

其余工作台悬停、边框、焦点、非活动选择等颜色为适应 VS Code 交互而补充；行号使用更深的灰色改善浅绿背景下可读性。主编辑器依赖语言的 TextMate/语义支持，语义服务未就绪时声明与引用可能不能精确区分。Context 使用基础词法，不声称具备同等语义分类。

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
