# 0.7 验证报告

日期：2026-10-19；环境：Debian、Node.js 22、clangd 19.1.7。

- JavaScript、命令清单和 TypeScript checkJs 通过。
- 自动测试：62 项，61 通过、1 跳过、0 失败；跳过为 clangd 19 outgoing calls。
- 新增布局测试验证右侧主侧栏、原生 Explorer 与相对侧符号视图显示、底部全宽面板命令、配置恢复及不覆盖后续手动位置。
- 主题检查更新为灰蓝侧栏与浅绿编辑区区分、灰色标题区域一致和蓝白选中配色。
- 保留主题恢复、鼠标侧键、Context 跳转与实际 clangd 的既有回归。
- 安装目录只读检查了 35 个文件；主题和片段 XML 可解析，CHM 选择性提取至临时目录，PE 只读取版本与资源清单。未运行 Windows 程序，未打包原始帮助或图标。

当前受限环境不能启动 Electron，未完成实际 Windows/Linux UI 验收。Context 自有按钮可置底；原生 Explorer 和 TreeView 工具栏位置、视图尺寸、渐变与表格条纹不能完整复刻，底部两个视图宽度可手动调整。
