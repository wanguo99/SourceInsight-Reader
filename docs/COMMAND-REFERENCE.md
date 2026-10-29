# 命令与验收索引

由 `npm run docs:update` 从 manifest 和用例登记生成。命令面板按当前 VS Code 语言显示；可以搜索命令 ID。

| 命令 ID | 中文标题 | English | 验收入口 |
| --- | --- | --- | --- |
| sourceInsightReader.open | 打开阅读工作台 | Open Reading Workbench | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.filterSymbols | 筛选文件符号 | Filter File Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.sortSymbols | 切换符号排序 | Change Symbol Sorting | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.refreshSymbols | 刷新符号列表 | Refresh Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.previewDefinition | 预览定义 | Preview Definition | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.previewType | 预览类型定义 | Preview Type Definition | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.previewFile | 在 Context 预览文件 | Preview File in Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.openTarget | 在主编辑器打开 | Open in Main Editor | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.toggleContextLock | 锁定/解锁 Context | Lock / Unlock Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.refreshContext | 刷新 Context | Refresh Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.incoming | 谁调用它 | Incoming Calls | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.outgoing | 它调用谁 | Outgoing Calls | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.setRoot | 设为 Relation 根节点 | Set Relation Root | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.toggleRelationLock | 锁定/解锁 Relation | Lock / Unlock Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.refreshRelations | 刷新 Relation | Refresh Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.lookupReferences | Lookup References | Lookup References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.refreshReferences | 刷新引用 | Refresh References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.clearReferences | 清除引用 | Clear References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.back | 阅读位置后退 | Previous Reading Position | NAV-09 / QUERY-01 |
| sourceInsightReader.forward | 阅读位置前进 | Next Reading Position | NAV-09 / QUERY-01 |
| sourceInsightReader.findFile | 查找工程文件 | Find Project File | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.browseSymbols | 查找全局符号 | Find Workspace Symbol | SYM-07 / SYM-08 |
| sourceInsightReader.jumpToDefinition | 跳转到定义 | Go to Definition | NAV-09 / QUERY-01 |
| sourceInsightReader.openSelection | 打开选中位置 | Open Selection | NAV-09 / QUERY-01 |
| sourceInsightReader.contextMode | Context 跟随模式 | Context Follow Mode | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.filterReferences | 筛选引用 | Filter References | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.referenceHistory | 引用查询历史 | Reference History | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.nextReference | 下一个引用 | Next Reference | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.previousReference | 上一个引用 | Previous Reference | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.toggleSymbolKinds | 切换全部符号/仅函数 | Toggle All Symbols / Functions | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.focusSymbols | 聚焦文件符号 | Focus File Symbols | SYM-03 / SYM-04 / SYM-06 |
| sourceInsightReader.focusContext | 聚焦 Context | Focus Context | CTX-01 / CTX-02 / CTX-04 / CTX-05 / CTX-06 / READ-01 / READ-02 |
| sourceInsightReader.focusRelations | 聚焦 Relation | Focus Relation | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.focusReferences | 聚焦引用结果 | Focus Reference Results | REF-01 / REF-04 / REF-05 / REF-06 / REF-08 |
| sourceInsightReader.applyLayout | 应用 Source Insight 布局 | Apply Source Insight Layout | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.restoreSidebar | 恢复原侧栏位置 | Restore Previous Sidebar | FIRST-01 / FIRST-06 / LAYOUT-01 |
| sourceInsightReader.rebuildIndex | 刷新索引（使用已保存配置） | Refresh Index (Saved Configuration) | IDX-01 / IDX-02 / IDX-07 / IDX-08 / IDX-09 / MODE-01 / MODE-02 / MODE-03 / MODE-04 / MODE-05 / MODE-06 / MODE-07 |
| sourceInsightReader.indexIssues | 查看本地索引问题 | Show Local Index Issues | IDX-10 / IDX-11 / IDX-12 / IDX-13 / IDX-14 |
| sourceInsightReader.chooseRelationView | 选择 Relation 显示方式 | Choose Relation View | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.focusFileSearch | 聚焦工程文件 | Focus Project Files | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.refreshFileSearch | 刷新工程文件 | Refresh Project Files | FILE-01 / FILE-02 / FILE-04 |
| sourceInsightReader.lookupText | Lookup Text（文件夹字符检索） | Lookup Text | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.focusTextLookup | 聚焦字符检索结果 | Focus Text Results | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.nextTextMatch | 下一处字符匹配 | Next Text Match | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.previousTextMatch | 上一处字符匹配 | Previous Text Match | SEARCH-01 / SEARCH-05 / SEARCH-09 / SEARCH-10 |
| sourceInsightReader.toggleSymbolHighlight | 固定 / 取消同名符号高亮 | Toggle Same-name Text Highlight | KEY-01 / KEY-03 / KEY-04 / CTX-09 |
| sourceInsightReader.clearSymbolHighlight | 清除固定符号高亮 | Clear Same-name Text Highlight | KEY-01 / KEY-03 / KEY-04 / CTX-09 |
| sourceInsightReader.openSettings | 设置 | Settings | SET-01 / SET-02 / SET-03 / SET-04 / SET-05 / SET-06 |
| sourceInsightReader.reloadWindow | 重载窗口 | Reload Window | SET-07 |
| sourceInsightReader.verifyRelations | 使用语言服务复查调用关系 | Verify Calls with Language Service | REL-01 / REL-03 / REL-05 / REL-08 |
| sourceInsightReader.manageReadingDirectories | 管理屏蔽项 | Manage Exclusions | SCOPE-01 / SCOPE-04 / SCOPE-05 / FILE-08 |
| sourceInsightReader.excludeDirectory | 屏蔽所选文件 / 目录 | Exclude Selected Files / Directories | SCOPE-01 / SCOPE-04 / SCOPE-05 / FILE-08 |
| sourceInsightReader.configureAppearance | 外观配置（颜色、字体、背景） | Appearance (Colors, Fonts, Background) | SET-01 / SET-02 / SET-03 / SET-04 / SET-05 / SET-06 |
| sourceInsightReader.diagnostics | 能力与工程诊断 | Diagnose Workspace Capabilities | ENV-02 / ENV-03 |
| sourceInsightReader.exportDiagnostics | 导出脱敏诊断 | Export Redacted Diagnostics | ENV-02 / ENV-03 |
| sourceInsightReader.keyboardPreset | 选择键位预设 | Choose Keyboard Preset | KEY-01 / KEY-03 / KEY-04 / CTX-09 |
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
| sourceInsightReader.manageCache | 管理本地缓存 | Manage Local Cache | CACHE-01 / CACHE-02 / CACHE-03 / CACHE-04 / CACHE-05 / CACHE-06 / CACHE-07 / CACHE-08 |
| sourceInsightReader.manageProjectSources | 管理工程文件（导入目录 / 文件） | Manage Project Files | IMPORT-01 / IMPORT-02 / IMPORT-03 / IMPORT-04 / IMPORT-05 / IMPORT-06 / IMPORT-07 / IMPORT-08 / IMPORT-09 |
| sourceInsightReader.startIndex | 开始索引（使用已保存配置） | Start Indexing (Saved Configuration) | IDX-01 / IDX-02 / IDX-07 / IDX-08 / IDX-09 / MODE-01 / MODE-02 / MODE-03 / MODE-04 / MODE-05 / MODE-06 / MODE-07 |
