'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), manifest = require('../package.json');
const zh = require('../package.nls.zh-cn.json'), en = require('../package.nls.json');
const acceptance = fs.readFileSync(path.join(root, 'docs/ACCEPTANCE-TESTS.md'), 'utf8');
const rows = acceptance.split('\n').filter(line => /^\| [A-Z]+-\d+ \|/.test(line)).map(line => line.split('|').slice(1, -1).map(value => value.trim()));
const ids = new Set();
for (const row of rows) { if (ids.has(row[0])) throw new Error('Duplicate acceptance case: ' + row[0]); ids.add(row[0]); }
const commandGroups = [
  ['FIRST-01,FIRST-06,LAYOUT-01', 'open applyLayout restoreSidebar welcome'],
  ['SYM-03,SYM-04,SYM-06', 'filterSymbols sortSymbols refreshSymbols toggleSymbolKinds focusSymbols'],
  ['CTX-01,CTX-02,CTX-04,CTX-05,CTX-06,READ-01,READ-02', 'previewDefinition previewType previewFile openTarget selectTarget toggleContextLock refreshContext contextMode focusContext'],
  ['REL-01,REL-03,REL-05,REL-08', 'incoming outgoing setRoot toggleRelationLock refreshRelations verifyRelations chooseRelationView focusRelations'],
  ['REF-01,REF-04,REF-05,REF-06,REF-08', 'lookupReferences refreshReferences clearReferences filterReferences referenceHistory nextReference previousReference focusReferences'],
  ['NAV-09,QUERY-01', 'back forward jumpToDefinition openSelection'],
  ['FILE-01,FILE-02,FILE-04', 'findFile focusFileSearch refreshFileSearch'],
  ['SYM-07,SYM-08', 'browseSymbols'],
  ['IDX-01,IDX-02,IDX-07,IDX-08,IDX-09', 'rebuildIndex'],
  ['IDX-10,IDX-11,IDX-12,IDX-13,IDX-14', 'indexIssues'],
  ['SEARCH-01,SEARCH-05,SEARCH-09,SEARCH-10', 'lookupText focusTextLookup nextTextMatch previousTextMatch'],
  ['KEY-01,KEY-03,KEY-04,CTX-09', 'toggleSymbolHighlight clearSymbolHighlight keyboardPreset'],
  ['SET-01,SET-02,SET-03,SET-04,SET-05,SET-06', 'openSettings configureAppearance'],
  ['SCOPE-01,SCOPE-04,SCOPE-05,FILE-08', 'manageReadingDirectories excludeDirectory'],
  ['ENV-02,ENV-03', 'diagnostics exportDiagnostics'],
  ['CLANGD-03,CLANGD-04', 'configureClangd restoreClangd'],
  ['READ-04,READ-05', 'addBookmark bookmarks'],
  ['READ-06', 'saveReadingTask restoreReadingTask'],
  ['SEARCH-11', 'saveSearch savedSearches'],
  ['REL-12,REL-13', 'exploreRelations'],
  ['READ-03', 'pinContext'],
  ['READ-07', 'clearReadingData'],
  ['CACHE-01,CACHE-02,CACHE-03,CACHE-04,CACHE-05,CACHE-06,CACHE-07,CACHE-08', 'manageCache']
];
const cases = new Map();
for (const [related, names] of commandGroups) for (const name of names.split(' ')) {
  for (const id of related.split(',')) if (!ids.has(id)) throw new Error('Unknown case mapping: ' + id);
  cases.set(name, related.split(',').join(' / '));
}
const resolve = (value, messages) => typeof value === 'string' && value.startsWith('%') ? messages[value.slice(1, -1)] : value;
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
let commands = '# 命令与验收索引\n\n由 `npm run docs:update` 从 manifest 和用例登记生成。命令面板按当前 VS Code 语言显示；可以搜索命令 ID。\n\n| 命令 ID | 中文标题 | English | 验收入口 |\n| --- | --- | --- | --- |\n';
for (const command of manifest.contributes.commands) {
  const name = command.command.split('.').at(-1), related = cases.get(name);
  if (!related) throw new Error('Command has no acceptance mapping: ' + name);
  commands += `| ${command.command} | ${cell(resolve(command.title, zh))} | ${cell(resolve(command.title, en))} | ${related} |\n`;
}
let configuration = '# 当前配置参考\n\n由 manifest 生成。工作区设置优先；具体外观字段在插件设置页编辑。默认 F8 固定高亮（覆盖“下一个问题”），F2 保留重命名；布局与共享配置保持原样，升级时已有显式设置仍优先。\n\n| 设置 | 默认值 | 类型 / 范围 | 说明 |\n| --- | --- | --- | --- |\n';
for (const [key, schema] of Object.entries(manifest.contributes.configuration.properties)) {
  const type = schema.enum ? schema.enum.join(' / ') : schema.minimum !== undefined ? `${schema.type} ${schema.minimum}–${schema.maximum}` : schema.type;
  configuration += `| ${key} | ${cell(JSON.stringify(schema.default))} | ${cell(type)} | ${cell(resolve(schema.description || schema.markdownDescription, zh))} |\n`;
}
const csv = values => values.map(value => '"' + String(value ?? '').replace(/"/g, '""') + '"').join(',');
const results = '\uFEFF' + csv(['ID', '前置', '操作', '预期', '状态', '实际结果', '环境/版本/提交', '日期', '证据/问题']) + '\n' + rows.map(row => csv([...row, 'NOT_RUN', '', '', '', ''])).join('\n') + '\n';
const generated = { 'docs/COMMAND-REFERENCE.md': commands, 'docs/CONFIGURATION.md': configuration, 'docs/ACCEPTANCE-RESULTS-TEMPLATE.csv': results };
for (const [name, value] of Object.entries(generated)) {
  const file = path.join(root, name);
  if (process.argv.includes('--check')) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== value) throw new Error('Regenerate documentation: ' + name); }
  else fs.writeFileSync(file, value);
}
console.log(`${manifest.contributes.commands.length} commands and ${ids.size} unique acceptance cases documented.`);
