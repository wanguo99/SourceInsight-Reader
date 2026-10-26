'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { featureOptions, describeFeature, parseFeatureChanges } = require('../src/feature-options');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('the feature tab covers all contributed functional settings and uses their existing defaults', () => {
  const schemas = require('../package.json').contributes.configuration.properties;
  const expected = Object.keys(schemas).filter(key => key !== 'sourceInsightReader.appearance.panes').map(key => key.slice('sourceInsightReader.'.length)).sort();
  assert.deepEqual(featureOptions.map(option => option.key).sort(), expected);
  const defaults = Object.fromEntries(featureOptions.map(option => [option.id, describeFeature(option, option.schema.default).default]));
  const parsed = parseFeatureChanges(defaults);
  for (const option of featureOptions) assert.deepEqual(parsed.get(option.key), option.schema.default, option.key);
});

test('feature inputs validate types and bounds and preserve commas and Windows paths in line lists', () => {
  const changes = parseFeatureChanges({ 'feature.contextLines': '35', 'feature.autoPreview': 'false', 'feature.relationView': 'outline',
    'feature.files.exclude': '**/{build,dist}/**\r\n**/out/**\r\n', 'feature.excludedDirectories': 'C:\\src folder\\build\nremote/path' });
  assert.equal(changes.get('contextLines'), 35); assert.equal(changes.get('autoPreview'), false);
  assert.deepEqual(changes.get('files.exclude'), ['**/{build,dist}/**', '**/out/**']);
  assert.deepEqual(changes.get('excludedDirectories'), ['C:\\src folder\\build', 'remote/path']);
  assert.deepEqual(parseFeatureChanges({ 'feature.files.include': '' }).get('files.include'), []);
  assert.equal(parseFeatureChanges({ 'feature.contextLines': '' }).get('contextLines'), undefined);
  for (const [key, value] of [['contextLines', '5.5'], ['contextLines', '101'], ['relationTimeoutMs', 'NaN'], ['relationView', 'invalid'], ['autoPreview', 'yes'], ['unknown', 'true']]) {
    assert.throws(() => parseFeatureChanges({ [`feature.${key}`]: value }));
  }
});

test('save and reload validates both tabs before writing and reloads only after all changes are saved', async () => {
  const env = fakeVscode(), replies = [], writes = []; let failWrite = false;
  const original = env.api.workspace.getConfiguration;
  env.api.workspace.getConfiguration = section => {
    const config = original(section), update = config.update;
    config.update = async (key, value, target) => {
      if (failWrite && section === 'sourceInsightReader' && key === 'contextLines') throw new Error('disk write failed');
      writes.push({ section, key, target }); await update(key, value);
    };
    return config;
  };
  let reloads = 0;
  env.commands.set('workbench.action.reloadWindow', () => {
    assert.equal(env.settings.get('sourceInsightReader.contextLines'), 35);
    assert.equal(env.settings.get('sourceInsightReader.autoPreview'), true);
    assert.equal(env.settings.get('editor.semanticTokenColorCustomizations')['[SourceInsight-Reader Source Insight]'].rules.macro.foreground, '#dd1122');
    reloads++;
  });
  const { AppearancePanel } = loadWithVscode('../src/appearance-panel', env.api);
  const panel = new AppearancePanel(env.context.extensionUri, error => { throw error; });
  panel.channel = { postMessage: async value => replies.push(value), dispose() {} };
  const request = changes => panel.handle({ action: 'settingsSaveReload', mode: 'workspace', query: JSON.stringify(changes) });
  await request({ 'macro.reference': '#dd1122', 'feature.contextLines': '101' });
  assert.equal(writes.length, 0); assert.equal(reloads, 0); assert.equal(replies.at(-1).scope, 'appearanceError');
  await request({ 'macro.reference': 'invalid', 'feature.contextLines': '35' });
  assert.equal(writes.length, 0); assert.equal(reloads, 0);
  await request({ 'macro.reference': '#dd1122', 'feature.contextLines': '35', 'feature.autoPreview': 'true' });
  assert.equal(reloads, 1); assert(writes.every(write => write.target === env.api.ConfigurationTarget.Workspace));
  assert.equal(replies.at(-1).options.filter(option => option.tab === 'features').length, featureOptions.length);
  const previous = writes.length;
  await panel.handle({ action: 'settingsSave', mode: 'workspace', query: '{}' });
  assert.equal(writes.length, previous); assert.equal(reloads, 1);
  failWrite = true;
  await request({ 'feature.contextLines': '36' });
  assert.equal(reloads, 1); assert.equal(env.settings.get('sourceInsightReader.contextLines'), 35);
  assert.match(replies.at(-1).status, /disk write failed/);
  panel.dispose();
});

test('reopening a settings tab reuses the page without replacing unsaved fields', () => {
  const env = fakeVscode(), messages = [];
  const { AppearancePanel } = loadWithVscode('../src/appearance-panel', env.api);
  const panel = new AppearancePanel(env.context.extensionUri, () => {});
  panel.panel = { reveal() {}, dispose() {} }; panel.channel = { postMessage: message => messages.push(message), dispose() {} };
  panel.show('appearance'); panel.show('features');
  assert.deepEqual(messages, [{ scope: 'settingsTab', tab: 'appearance' }, { scope: 'settingsTab', tab: 'features' }]);
  panel.dispose();
});

test('settings tabs retain dirty fields, restore only current-tab defaults and save both tabs together', () => {
  const nodes = [], elements = new Map(), messages = []; let receive;
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.attributes = {}; this.value = ''; nodes.push(this); }
    set id(value) { this._id = value; elements.set(value, this); } get id() { return this._id; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, listener) { this.handlers[event] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() {}
  }
  const get = id => { if (!elements.has(id)) { const element = new Element('div'); element.id = id; } return elements.get(id); };
  get('target').value = 'workspace';
  for (const id of ['save', 'save-reload', 'defaults', 'reload', 'tab-features', 'tab-appearance']) get(id).tag = 'button';
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/appearance-panel.js'), 'utf8'), {
    document: { getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => nodes.filter(node => ['input', 'textarea', 'select', 'button'].includes(node.tag)) },
    window: { readerBridge: { postMessage: message => messages.push(message), onMessage: listener => { receive = listener; } } }
  });
  const options = [describeFeature(featureOptions.find(option => option.key === 'autoPreview'), false),
    describeFeature(featureOptions.find(option => option.key === 'contextLines'), 20),
    { ...describeFeature(featureOptions.find(option => option.key === 'cacheDirectory'), ''), placeholder: '/default/indexes', pathHint: '当前生效目录：/default/indexes' },
    { id: 'macro.reference', tab: 'appearance', label: '宏引用', group: '符号颜色', type: 'color', value: '#c00000', default: '#c00000' }];
  receive({ data: { scope: 'appearanceOptions', tab: 'features', options, status: '', hasWorkspace: true } });
  get('feature.autoPreview').checked = true; get('feature.autoPreview').handlers.change();
  get('feature.contextLines').value = '35'; get('feature.contextLines').handlers.input();
  get('tab-appearance').handlers.click();
  get('macro.reference').value = '#dd1122'; get('macro.reference').handlers.input();
  get('tab-features').handlers.click();
  assert.equal(get('feature.contextLines').value, '35'); assert.equal(get('feature.autoPreview').checked, true);
  receive({ data: { scope: 'settingsPaths', paths: { 'feature.cacheDirectory': { placeholder: '/default/indexes', pathHint: '当前生效目录：/changed/indexes' } } } });
  assert.equal(get('feature.cacheDirectory.path').textContent, '当前生效目录：/changed/indexes');
  assert.equal(get('feature.contextLines').value, '35');
  get('save-reload').handlers.click();
  assert.equal(messages.at(-1).action, 'settingsSaveReload');
  assert.deepEqual(JSON.parse(messages.at(-1).query), { 'feature.autoPreview': 'true', 'feature.contextLines': '35', 'macro.reference': '#dd1122' });
  assert.equal(get('save').disabled, true);
  receive({ data: { scope: 'appearanceError', status: '保存失败' } });
  assert.equal(get('save').disabled, false); assert.equal(get('macro.reference').value, '#dd1122');
  get('defaults').handlers.click();
  assert.equal(get('feature.contextLines').value, '20'); assert.equal(get('macro.reference').value, '#dd1122');
  receive({ data: { scope: 'settingsTab', tab: 'appearance' } });
  assert.equal(get('feature.autoPreview').checked, true);
  get('save').handlers.click();
  assert.deepEqual(JSON.parse(messages.at(-1).query), { 'feature.autoPreview': 'true', 'macro.reference': '#dd1122' });
  assert.equal(messages.at(-1).action, 'settingsSave');
  const protocol = require('../shared/protocol');
  assert(protocol.action(messages.at(-1), ['settingsSave']));
  receive({ data: { scope: 'appearanceError', status: 'test complete' } });
  get('tab-features').handlers.click();
  get('feature.cacheDirectory.browse').handlers.click();
  const request = messages.at(-1);
  assert(protocol.action(request, ['settingsChooseDirectory']));
  const selected = 'C:\\用户目录\\Index Cache';
  receive({ data: { scope: 'settingsDirectory', id: request.id, snapshot: request.snapshot, folder: selected } });
  assert.equal(get(request.id).value, selected);
  assert.equal(get('macro.reference').value, '#dd1122');
  get('feature.cacheDirectory.browse').handlers.click();
  const cancelled = messages.at(-1);
  receive({ data: { scope: 'settingsDirectory', id: cancelled.id, snapshot: cancelled.snapshot, cancelled: true } });
  assert.equal(get(request.id).value, selected);
  get('feature.cacheDirectory.browse').handlers.click();
  const stale = messages.at(-1);
  get(request.id).value = 'manual change'; get(request.id).handlers.input();
  receive({ data: { scope: 'settingsDirectory', id: stale.id, snapshot: stale.snapshot, folder: 'C:\\old' } });
  assert.equal(get(request.id).value, 'manual change');

});

test('default cache and log paths show their actual locations without turning defaults into explicit settings', async () => {
  const env = fakeVscode(), replies = [];
  env.context.globalStorageUri = env.api.Uri.file('/tmp/reader-settings-test/global');
  const { AppearancePanel } = loadWithVscode('../src/appearance-panel', env.api);
  const panel = new AppearancePanel(env.context.extensionUri, () => {}, env.context);
  panel.channel = { postMessage: async value => replies.push(value), dispose() {} };
  try {
    await panel.publish();
    const option = key => replies.at(-1).options.find(value => value.id === 'feature.' + key);
    assert.equal(option('cacheDirectory').value, '');
    assert.equal(option('cacheDirectory').placeholder, env.context.globalStorageUri.fsPath);
    assert(option('cacheDirectory').pathHint.includes(option('cacheDirectory').placeholder));
    assert(option('cacheDirectory').pathHint.includes('indexes')); assert(option('cacheDirectory').pathHint.includes('logs'));
    assert.equal(env.settings.has('sourceInsightReader.cacheDirectory'), false);
    await panel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({ 'feature.cacheDirectory': '~/reader logs' }) });
    assert(option('cacheDirectory').pathHint.includes(path.join(require('node:os').homedir(), 'reader logs')));
    assert.equal(env.settings.get('sourceInsightReader.cacheDirectory'), '~/reader logs');
    assert.throws(() => parseFeatureChanges({ 'feature.cacheDirectory': 'relative/logs' }), /绝对路径/);
  } finally { panel.dispose(); }
});

test('the unified cache folder picker select filesystem folders without writing settings', async () => {
  const env = fakeVscode(), replies = [], dialogs = [];
  env.context.globalStorageUri = env.api.Uri.file(path.join(require('node:os').tmpdir(), 'reader-picker-storage'));
  const chosen = env.api.Uri.file(path.join(require('node:os').tmpdir(), '日志 folder'));
  env.api.window.showOpenDialog = async options => { dialogs.push(options); return [chosen]; };
  const { AppearancePanel } = loadWithVscode('../src/appearance-panel', env.api);
  const panel = new AppearancePanel(env.context.extensionUri, () => {}, env.context);
  panel.channel = { postMessage: async value => replies.push(value), dispose() {} };
  try {
    for (const [index, key] of ['cacheDirectory'].entries()) {
      await panel.handle({ action: 'settingsChooseDirectory', id: 'feature.' + key, folder: '', snapshot: index });
      assert.equal(dialogs[index].canSelectFiles, false); assert.equal(dialogs[index].canSelectFolders, true);
      assert.equal(dialogs[index].canSelectMany, false);
      assert.equal(dialogs[index].defaultUri.fsPath, env.context.globalStorageUri.fsPath);
      assert.equal(replies.at(-1).folder, chosen.fsPath); assert.equal(replies.at(-1).id, 'feature.' + key);
      assert.equal(env.settings.has('sourceInsightReader.' + key), false);
    }
    env.api.window.showOpenDialog = async () => undefined;
    await panel.handle({ action: 'settingsChooseDirectory', id: 'feature.cacheDirectory', folder: '', snapshot: 3 });
    assert.equal(replies.at(-1).cancelled, true);
    env.api.window.showOpenDialog = async () => [env.api.Uri.parse('memfs:/folder')];
    await panel.handle({ action: 'settingsChooseDirectory', id: 'feature.cacheDirectory', folder: '', snapshot: 4 });
    assert.match(replies.at(-1).error, /文件系统/);
    await panel.handle({ action: 'settingsChooseDirectory', id: '__proto__', folder: '', snapshot: 5 });
    assert.equal(replies.at(-1).snapshot, 4);
    let release;
    env.api.window.showOpenDialog = () => new Promise(resolve => { release = resolve; });
    const pending = panel.handle({ action: 'settingsChooseDirectory', id: 'feature.cacheDirectory', folder: '', snapshot: 6 });
    panel.channel = { postMessage: async () => assert.fail('closed panel result must not reach a new panel'), dispose() {} };
    release([chosen]); await pending;
  } finally { panel.dispose(); }
});
