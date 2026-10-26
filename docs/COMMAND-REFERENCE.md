# 命令与验收索引

由 `npm run docs:update` 从 manifest 和用例登记生成。命令面板按当前 VS Code 语言显示；可以搜索命令 ID。

| 命令 ID | 中文标题 | English | 验收入口 |
| --- | --- | --- | --- |
| sourceInsightReader.open | SourceInsight-Reader: 打开阅读工作台 | SourceInsight-Reader: Open Reading Workbench | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.filterSymbols | 筛选文件符号 | Filter File Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.sortSymbols | 切换函数排序 | Toggle Symbol Sort Order | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.refreshSymbols | 刷新函数列表 | Refresh Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.previewDefinition | SourceInsight-Reader: 预览定义 | SourceInsight-Reader: Preview Definition | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.previewType | SourceInsight-Reader: 预览类型定义 | SourceInsight-Reader: Preview Type Definition | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.previewFile | 在 Context 预览文件 | Preview File in Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.openTarget | 在主编辑器打开 | Open in Main Editor | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.toggleContextLock | 锁定/解锁 Context | Lock / Unlock Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.refreshContext | 刷新 Context | Refresh Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.incoming | SourceInsight-Reader: 谁调用它 | SourceInsight-Reader: Incoming Calls | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.outgoing | SourceInsight-Reader: 它调用谁 | SourceInsight-Reader: Outgoing Calls | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.setRoot | 设为 Relation 根节点 | Set Relation Root | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.toggleRelationLock | 锁定/解锁 Relation | Lock / Unlock Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.refreshRelations | 刷新 Relation | Refresh Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.lookupReferences | SourceInsight-Reader: Lookup References | SourceInsight-Reader: Lookup References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.refreshReferences | 刷新引用 | Refresh References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.clearReferences | 清除引用 | Clear References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.back | SourceInsight-Reader: 阅读位置后退 | SourceInsight-Reader: Previous Reading Position | NAV-09 / QUERY-01 |
| sourceInsightReader.forward | SourceInsight-Reader: 阅读位置前进 | SourceInsight-Reader: Next Reading Position | NAV-09 / QUERY-01 |
| sourceInsightReader.findFile | SourceInsight-Reader: 查找工程文件 | SourceInsight-Reader: Find Project File | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.browseSymbols | SourceInsight-Reader: 查找全局符号 | SourceInsight-Reader: Find Workspace Symbol | SYM-07 / SYM-08 |
| sourceInsightReader.jumpToDefinition | SourceInsight-Reader: 跳转到定义 | SourceInsight-Reader: Go to Definition | NAV-09 / QUERY-01 |
| sourceInsightReader.openSelection | SourceInsight-Reader: 打开选中位置 | SourceInsight-Reader: Open Selection | NAV-09 / QUERY-01 |
| sourceInsightReader.contextMode | Context 跟随模式 | Context Follow Mode | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.filterReferences | 筛选引用 | Filter References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.referenceHistory | 引用查询历史 | Reference History | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.nextReference | SourceInsight-Reader: 下一个引用 | SourceInsight-Reader: Next Reference | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.previousReference | SourceInsight-Reader: 上一个引用 | SourceInsight-Reader: Previous Reference | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.toggleSymbolKinds | 切换全部符号/仅函数 | Toggle All Symbols / Functions | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.focusSymbols | SourceInsight-Reader: 聚焦文件符号 | SourceInsight-Reader: Focus File Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.focusContext | SourceInsight-Reader: 聚焦 Context | SourceInsight-Reader: Focus Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.focusRelations | SourceInsight-Reader: 聚焦 Relation | SourceInsight-Reader: Focus Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.focusReferences | SourceInsight-Reader: 聚焦引用结果 | SourceInsight-Reader: Focus Reference Results | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.applyLayout | SourceInsight-Reader: 应用 Source Insight 布局 | SourceInsight-Reader: Apply Source Insight Layout | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.restoreSidebar | SourceInsight-Reader: 恢复原侧栏位置 | SourceInsight-Reader: Restore Previous Sidebar | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.rebuildIndex | SourceInsight-Reader: 重建本地 C 调用索引 | SourceInsight-Reader: Rebuild Local C Index | IDX-01 / IDX-02 / IDX-07 / IDX-08 / IDX-09 |
| sourceInsightReader.indexIssues | 查看本地索引问题 | Show Local Index Issues | IDX-10 / IDX-11 / IDX-12 / IDX-13 / IDX-14 |
| sourceInsightReader.chooseRelationView | SourceInsight-Reader: 选择 Relation 显示方式 | SourceInsight-Reader: Choose Relation View | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.focusFileSearch | SourceInsight-Reader: 聚焦工程文件 | SourceInsight-Reader: Focus Project Files | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.refreshFileSearch | 刷新工程文件 | Refresh Project Files | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.lookupText | SourceInsight-Reader: Lookup Text（文件夹字符检索） | SourceInsight-Reader: Lookup Text | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.focusTextLookup | SourceInsight-Reader: 聚焦字符检索结果 | SourceInsight-Reader: Focus Text Results | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.nextTextMatch | SourceInsight-Reader: 下一处字符匹配 | SourceInsight-Reader: Next Text Match | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.previousTextMatch | SourceInsight-Reader: 上一处字符匹配 | SourceInsight-Reader: Previous Text Match | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.toggleSymbolHighlight | SourceInsight-Reader: 固定 / 取消同名符号高亮 | SourceInsight-Reader: Toggle Same-name Text Highlight | KEY-01 / KEY-03 / CTX-09 |
| sourceInsightReader.clearSymbolHighlight | SourceInsight-Reader: 清除固定符号高亮 | SourceInsight-Reader: Clear Same-name Text Highlight | KEY-01 / KEY-03 / CTX-09 |
| sourceInsightReader.openSettings | SourceInsight-Reader: 设置 | SourceInsight-Reader: Settings | SET-01 / SET-02 / SET-03 / SET-04 / SET-05 / SET-06 |
| sourceInsightReader.verifyRelations | SourceInsight-Reader: 使用语言服务复查调用关系 | SourceInsight-Reader: Verify Calls with Language Service | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.manageReadingDirectories | SourceInsight-Reader: 管理屏蔽项 | SourceInsight-Reader: Manage Exclusions | SCOPE-01 / SCOPE-04 / SCOPE-05 / FILE-08 |
| sourceInsightReader.excludeDirectory | 屏蔽所选文件 / 目录 | Exclude Selected Files / Directories | SCOPE-01 / SCOPE-04 / SCOPE-05 / FILE-08 |
| sourceInsightReader.configureAppearance | SourceInsight-Reader: 外观配置（颜色、字体、背景） | SourceInsight-Reader: Appearance (Colors, Fonts, Background) | SET-01 / SET-02 / SET-03 / SET-04 / SET-05 / SET-06 |
| sourceInsightReader.diagnostics | 能力与工程诊断 | Diagnose Workspace Capabilities | ENV-02 / ENV-03 |
| sourceInsightReader.exportDiagnostics | 导出脱敏诊断 | Export Redacted Diagnostics | ENV-02 / ENV-03 |
| sourceInsightReader.keyboardPreset | 选择键位预设 | Choose Keyboard Preset | KEY-01 / KEY-03 / CTX-09 |
| sourceInsightReader.configureClangd | 预览并启用 clangd 范围配置 | Preview and Enable clangd Scope Configuration | CLANGD-03 / CLANGD-04 |
| sourceInsightReader.restoreClangd | 预览并移除 clangd 范围配置 | Preview and Remove clangd Scope Configuration | CLANGD-03 / CLANGD-04 |
| sourceInsightReader.addBookmark | 添加书签和笔记 | Add Bookmark and Note | READ-04 / READ-05 |
| sourceInsightReader.bookmarks | 管理书签和笔记 | Manage Bookmarks and Notes | READ-04 / READ-05 |
| sourceInsightReader.saveReadingTask | 保存阅读任务 | Save Reading Task | READ-06 |
| sourceInsightReader.restoreReadingTask | 恢复阅读任务 | Restore Reading Task | READ-06 |
| sourceInsightReader.saveSearch | 保存当前检索 | Save Current Search | SEARCH-11 |
| sourceInsightReader.savedSearches | 打开保存的检索 | Open Saved Search | SEARCH-11 |
| sourceInsightReader.exploreRelations | 探索实现、成员和文件依赖 | Explore Implementations, Members and Includes | REL-12 / REL-13 |
| sourceInsightReader.pinContext | 固定预览到旁侧编辑器 | Pin Preview in Side Editor | READ-03 |
| sourceInsightReader.welcome | 入门指南 | Getting Started | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.clearReadingData | 清除工作区阅读数据 | Clear Workspace Reading Data | READ-07 |
| sourceInsightReader.manageCache | SourceInsight-Reader: 管理本地缓存 | SourceInsight-Reader: Manage Local Cache | CACHE-01 / CACHE-02 / CACHE-03 / CACHE-04 / CACHE-05 / CACHE-06 / CACHE-07 / CACHE-08 |
