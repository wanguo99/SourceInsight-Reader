'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { options, applyChanges, readValue, paneCss } = require('../src/appearance-options');
const { semanticColor } = require('../src/preview-colors');
const { scopedSettings, textmateTheme } = require('../src/editor-color-settings');
const { THEME_ID } = require('../src/theme');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

const settings = () => ({ semantic: { rules: { 'variable:c': '#123456' } }, textmate: { textMateRules: [{ scope: 'comment', settings: { foreground: '#445566', fontStyle: 'italic' } }] }, colors: { 'editorRuler.foreground': '#123456' }, panes: {}, editor: { fontSize: 14 }, icon: 'Default' });

test('macro and enum member definitions are blue and references red, independently configurable', () => {
  for (const type of ['macro', 'enumMember']) {
    assert.equal(semanticColor(type), '#c00000');
    for (const modifier of ['definition', 'declaration']) assert.equal(semanticColor(type, [modifier]), '#000080');
  }
  const before = settings();
  const after = applyChanges(before, { 'macro.reference': '#cc1111', 'macro.definition': '#1122aa', 'enumMember.definition': '#2233bb' });
  const overrides = scopedSettings(after.semantic).map(layer => layer.rules || {});
  assert.equal(semanticColor('macro', [], 'c', overrides), '#cc1111');
  assert.equal(semanticColor('macro', ['definition'], 'c', overrides), '#1122aa');
  assert.equal(semanticColor('macro', ['declaration'], 'c', overrides), '#1122aa');
  assert.equal(semanticColor('enumMember', [], 'c', overrides), '#c00000');
  assert.equal(semanticColor('enumMember', ['definition'], 'c', overrides), '#2233bb');
  assert.deepEqual(before, settings());
  assert.equal(after.semantic.rules['variable:c'], '#123456');
});

test('appearance changes retain unrelated theme rules, font styles and background overrides', () => {
  const before = settings();
  before.semantic[`[${THEME_ID}]`] = { enabled: true, rules: { macro: { bold: true, foreground: '#112233' } } };
  const after = applyChanges(before, { 'macro.reference': '#dd0000', 'syntax.Comment': '#662266', 'workbench.sourceInsightReader.relation.edgeForeground': '#ee3311' });
  assert.equal(after.semantic[`[${THEME_ID}]`].rules.macro.bold, true);
  assert.equal(after.semantic[`[${THEME_ID}]`].enabled, true);
  assert.deepEqual(after.textmate.textMateRules, before.textmate.textMateRules);
  assert.equal(after.colors['editorRuler.foreground'], '#123456');
  assert.equal(after.colors[`[${THEME_ID}]`]['sourceInsightReader.relation.edgeForeground'], '#ee3311');
  const resetMacro = applyChanges(after, { 'macro.reference': '' });
  assert.equal(resetMacro.semantic[`[${THEME_ID}]`].rules.macro.bold, true);
  assert.equal(resetMacro.semantic[`[${THEME_ID}]`].rules.macro.foreground, undefined);
  assert.equal(readValue(options.find(option => option.id === 'syntax.Comment'), after), '#662266');
  const reset = applyChanges(after, { 'syntax.Comment': '' });
  assert.equal(readValue(options.find(option => option.id === 'syntax.Comment'), reset), '#445566');
});

test('theme wildcard groups and combined theme selectors retain semantic specificity', () => {
  const config = { rules: { macro: '#111111' }, '[SourceInsight*]': { rules: { macro: '#222222' } },
    '[Unrelated][SourceInsight-Reader Source Insight]': { rules: { 'macro.definition': '#333333' } } };
  const layers = scopedSettings(config).map(layer => layer.rules || {});
  assert.equal(semanticColor('macro', [], 'c', layers), '#222222');
  assert.equal(semanticColor('macro', ['definition'], 'c', layers), '#333333');
  assert.equal(textmateTheme({ '[SourceInsight*]': { comments: '#654321' } }).settings.at(-1).settings.foreground, '#654321');
});

test('editor background covers the gutter and default foreground is shared by syntax and semantic fallback', () => {
  const after = applyChanges(settings(), { 'workbench.editor.background': '#eeffee', 'workbench.editor.foreground': '#222233' });
  assert.equal(after.colors[`[${THEME_ID}]`]['editorGutter.background'], '#eeffee');
  assert.equal(after.colors[`[${THEME_ID}]`]['breadcrumb.background'], '#eeffee');
  assert.equal(readValue(options.find(option => option.id === 'syntax.Default text and identifiers'), after), '#222233');
  const layers = scopedSettings(after.semantic).map(layer => layer.rules || {});
  assert.equal(semanticColor('unknown', [], 'c', layers), '#222233');
  assert.equal(semanticColor('macro', [], 'c', layers), '#c00000');
});

test('pane styles are independent, live-safe and reject CSS injection and invalid sizes', () => {
  const after = applyChanges(settings(), { 'context.fontFamily': "Consolas, 'Courier New', monospace", 'context.fontSize': '18', 'context.background': '#eeffee', 'relation.background': '#cccccc', 'relation.fontSize': '22' });
  const css = paneCss(after.panes);
  assert.match(css.context, /font-size: 18px/);
  assert.match(css.context, /background-color: #eeffee/);
  assert.match(css.relation, /font-size: 22px/);
  assert.equal(css.files, '');
  for (const changes of [{ 'context.fontSize': '1000' }, { 'context.background': 'red;display:none' }, { 'context.fontFamily': '</style><script>' }, { 'unknown': '#112233' }]) {
    assert.throws(() => applyChanges(settings(), changes), /无效外观设置/);
  }
  assert(!paneCss({ context: { fontFamily: 'serif; color:red' } }).context);
});

test('appearance saves to the selected configuration scope without copying workspace overrides into user settings', async () => {
  const env = fakeVscode(); env.api.ConfigurationTarget.Global = 1;
  const user = new Map([['editor.semanticTokenColorCustomizations', { rules: { variable: '#334455' } }]]);
  const workspace = new Map([['editor.semanticTokenColorCustomizations', { rules: { function: '#abcdef' } }]]);
  env.api.workspace.getConfiguration = section => ({
    get: (key, fallback) => workspace.get(`${section}.${key}`) ?? user.get(`${section}.${key}`) ?? fallback,
    inspect: key => ({ globalValue: user.get(`${section}.${key}`), workspaceValue: workspace.get(`${section}.${key}`) }),
    update: async (key, value, target) => (target === 1 ? user : workspace).set(`${section}.${key}`, value)
  });
  const { AppearancePanel } = loadWithVscode('../src/appearance-panel', env.api);
  const panel = new AppearancePanel(env.context.extensionUri, error => { throw error; });
  const replies = []; panel.channel = { postMessage: async value => replies.push(value), dispose() {} };
  await panel.handle({ action: 'appearanceSave', mode: 'user', query: JSON.stringify({ 'macro.reference': '#ee0000', 'context.fontSize': '18' }) });
  const saved = user.get('editor.semanticTokenColorCustomizations');
  assert.equal(saved.rules.variable, '#334455');
  assert.equal(saved.rules.function, undefined);
  assert.equal(saved[`[${THEME_ID}]`].rules.macro.foreground, '#ee0000');
  assert.equal(workspace.get('editor.semanticTokenColorCustomizations').rules.function, '#abcdef');
  assert.equal(user.get('sourceInsightReader.appearance.panes').context.fontSize, 18);
  assert.match(replies.at(-1).status, /^已保存/);
  const size = user.size;
  await panel.handle({ action: 'appearanceSave', mode: 'user', query: '{"context.fontSize":"500"}' });
  assert.equal(user.size, size); assert.equal(replies.at(-1).scope, 'appearanceError');
  panel.dispose();
});

test('appearance action protocol permits a full settings form while retaining search query bounds', () => {
  const protocol = require('../shared/protocol');
  const query = JSON.stringify(Object.fromEntries(options.map(option => [option.id, ''])));
  assert(query.length > 1000);
  assert(protocol.action({ action: 'appearanceSave', mode: 'workspace', query }, ['appearanceSave']));
  assert(!protocol.action({ action: 'search', query }, ['search']));
});

test('native folding buttons use always-visible box plus and minus glyphs', () => {
  const fs = require('node:fs'), path = require('node:path');
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.configurationDefaults, undefined);
  const contribution = manifest.contributes.productIconThemes.find(theme => theme.id === 'sourceinsight-reader-folding');
  const icons = require(path.resolve(__dirname, '..', contribution.path));
  assert.notEqual(icons.iconDefinitions['folding-expanded'].fontCharacter, icons.iconDefinitions['folding-collapsed'].fontCharacter);
  const file = fs.readFileSync(path.resolve(__dirname, '..', path.dirname(contribution.path), icons.fonts[0].src[0].path));
  assert.equal(file.subarray(0, 4).toString(), 'wOFF');
  assert.deepEqual(Object.keys(icons.iconDefinitions).sort(), ['folding-collapsed', 'folding-expanded', 'folding-manual-collapsed', 'folding-manual-expanded']);
});
