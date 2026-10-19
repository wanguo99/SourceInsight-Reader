'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup(folder = true, workspaceTheme, mode = 'vscode') {
  const env = fakeVscode(), global = new Map([['workbench.colorTheme', 'Original Dark']]), workspace = new Map(), state = new Map(), writes = [], errors = [];
  if (mode !== undefined && mode !== null) global.set('sourceInsightInspired.appearance', mode);
  if (workspaceTheme) workspace.set('workbench.colorTheme', workspaceTheme);
  if (!folder) env.api.workspace.workspaceFolders = [];
  env.api.ConfigurationTarget.Global = 1;
  env.api.workspace.getConfiguration = section => ({
    get(key, fallback) { const name = `${section}.${key}`; return workspace.has(name) ? workspace.get(name) : global.has(name) ? global.get(name) : fallback; },
    inspect(key) { const name = `${section}.${key}`; return { workspaceValue: workspace.get(name), globalValue: global.get(name) }; },
    async update(key, value, target) {
      const name = `${section}.${key}`, map = target === 2 ? workspace : global;
      if (value === undefined) map.delete(name); else map.set(name, value);
      writes.push({ name, value, target });
      env.events.configuration.fire({ affectsConfiguration: nameToCheck => nameToCheck === name });
    }
  });
  env.context.workspaceState = { get(key) { return state.get(key); }, async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); } };
  const { ReadingAppearance, THEME_ID } = loadWithVscode('../src/appearance', env.api);
  const appearance = new ReadingAppearance(env.context, error => errors.push(error));
  const choose = async value => { env.api.window.showQuickPick = async choices => choices.find(choice => choice.value === value); await appearance.choose(); await appearance.queue; };
  return { env, appearance, THEME_ID, global, workspace, state, writes, errors, choose, ReadingAppearance };
}

test('VS Code mode preserves theme; Source Insight remembers inherited settings and restores without overriding a changed global theme', async () => {
  const s = setup(); await s.appearance.queue;
  assert.equal(s.writes.length, 0);
  s.workspace.set('editor.fontFamily', 'My Font');
  await s.choose('sourceInsight');
  assert.equal(s.workspace.get('workbench.colorTheme'), s.THEME_ID);
  assert.equal(s.global.get('workbench.colorTheme'), 'Original Dark');
  await s.choose('sourceInsight');
  s.global.set('workbench.colorTheme', 'New Global Theme');
  await s.choose('vscode');
  assert.equal(s.workspace.has('workbench.colorTheme'), false);
  assert.equal(s.appearance.theme(), 'New Global Theme');
  assert.equal(s.workspace.get('editor.fontFamily'), 'My Font');
  assert.equal(s.errors.length, 0); s.appearance.dispose();
});

test('theme switching restores an explicit workspace value after restart', async () => {
  const s = setup(true, 'Custom Workspace Theme'); await s.appearance.queue;
  await s.choose('sourceInsight'); s.appearance.dispose();
  s.appearance = new s.ReadingAppearance(s.env.context, error => s.errors.push(error)); await s.appearance.queue;
  s.env.api.window.showQuickPick = async choices => choices.find(choice => choice.value === 'vscode');
  await s.appearance.choose(); await s.appearance.queue;
  assert.equal(s.workspace.get('workbench.colorTheme'), 'Custom Workspace Theme');
  assert.equal(s.state.size, 0); assert.equal(s.errors.length, 0); s.appearance.dispose();
});

test('without a folder the theme can switch globally and be restored', async () => {
  const s = setup(false); await s.appearance.queue;
  await s.choose('sourceInsight'); assert.equal(s.global.get('workbench.colorTheme'), s.THEME_ID);
  await s.choose('vscode'); assert.equal(s.global.get('workbench.colorTheme'), 'Original Dark');
  assert.equal(s.workspace.size, 0); s.appearance.dispose();
});

test('native theme picker choice is respected instead of reapplying Source Insight', async () => {
  const s = setup(); await s.appearance.queue; await s.choose('sourceInsight');
  await s.env.api.workspace.getConfiguration('workbench').update('colorTheme', 'Manual Theme', 2);
  await s.appearance.queue;
  assert.equal(s.appearance.theme(), 'Manual Theme'); assert.equal(s.appearance.mode(), 'vscode');
  assert.equal(s.state.size, 0);
  await s.choose('sourceInsight'); await s.choose('vscode');
  assert.equal(s.appearance.theme(), 'Manual Theme'); assert.equal(s.errors.length, 0); s.appearance.dispose();
});

test('appearance setting changes apply the preset and restore the previous theme', async () => {
  const s = setup(); await s.appearance.queue;
  const config = s.env.api.workspace.getConfiguration('sourceInsightInspired');
  await config.update('appearance', 'sourceInsight', 2); await s.appearance.queue;
  assert.equal(s.appearance.theme(), s.THEME_ID);
  await config.update('appearance', 'vscode', 2); await s.appearance.queue;
  assert.equal(s.appearance.theme(), 'Original Dark'); s.appearance.dispose();
});

test('bundled light theme maps the provided XML colors and declares Context palette colors', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const preset = manifest.contributes.themes.find(theme => theme.id === 'Source Insight Inspired Source Insight');
  assert.equal(preset.uiTheme, 'vs');
  const theme = JSON.parse(fs.readFileSync(path.join(root, preset.path), 'utf8'));
  assert.equal(theme.colors['editor.background'], '#e6ffe3');
  assert.equal(theme.colors['sideBar.background'], '#c5d2de');
  assert.notEqual(theme.colors['sideBar.background'], theme.colors['editor.background']);
  assert.equal(theme.colors['sideBarStickyScroll.background'], theme.colors['sideBar.background']);
  assert.equal(theme.colors['sideBarTitle.background'], theme.colors['sideBarSectionHeader.background']);
  assert.equal(theme.colors['list.activeSelectionForeground'], '#000000');
  assert.equal(theme.colors['list.activeSelectionBackground'], '#d4e8f8');
  assert.equal(theme.colors['symbolIcon.functionForeground'], '#008000');
  assert.equal(theme.colors['editor.selectionBackground'], '#fff2cc');
  assert.equal(theme.colors['sourceInsightInspired.preview.commentForeground'], '#800080');
  assert.equal(theme.semanticTokenColors.number, '#c00000');
  assert.equal(theme.semanticTokenColors['*.definition'].foreground, '#000080');
  const registered = new Set(manifest.contributes.colors.map(color => color.id));
  for (const key of Object.keys(theme.colors).filter(key => key.startsWith('sourceInsightInspired.'))) assert.ok(registered.has(key), `Missing color contribution ${key}`);
  assert.equal(theme.semanticHighlighting, true);
});

 test('default activation saves theme before switching and one-click restore survives reload', async () => {
  const s = setup(true, 'My Original Theme', null); await s.appearance.queue;
  assert.equal(s.appearance.theme(), s.THEME_ID);
  assert.equal(s.state.get('appearance.previousTheme').value, 'My Original Theme');
  s.appearance.dispose();
  s.appearance = new s.ReadingAppearance(s.env.context, error => s.errors.push(error));
  await s.appearance.queue;
  assert.equal(s.state.get('appearance.previousTheme').value, 'My Original Theme');
  await s.appearance.restore();
  assert.equal(s.appearance.theme(), 'My Original Theme');
  assert.equal(s.appearance.mode(), 'vscode');
  s.appearance.dispose();
  s.appearance = new s.ReadingAppearance(s.env.context, error => s.errors.push(error));
  await s.appearance.queue;
  assert.equal(s.appearance.theme(), 'My Original Theme');
  assert.equal(s.errors.length, 0); s.appearance.dispose();
});

test('syntax palette stays readable on code, selection and occurrence backgrounds without selection foreground support', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '../themes/source-insight-color-theme.json'), 'utf8'));
  const luminance = hex => {
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const readable = (foreground, background, label) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    const ratio = (values[1] + .05) / (values[0] + .05);
    assert.ok(ratio >= 4.5, `${label}: ${foreground} on ${background} = ${ratio.toFixed(2)}`);
  };
  const foregrounds = new Set([
    ...theme.tokenColors.map(token => token.settings.foreground),
    ...Object.values(theme.semanticTokenColors).map(token => typeof token === 'string' ? token : token.foreground),
    ...Object.entries(theme.colors).filter(([key]) => key.startsWith('sourceInsightInspired.preview.') && key.endsWith('Foreground')).map(([, value]) => value)
  ]);
  for (const key of ['editor.background', 'editor.selectionBackground', 'editor.inactiveSelectionBackground',
    'editor.wordHighlightBackground', 'editor.wordHighlightStrongBackground', 'editor.wordHighlightTextBackground', 'editor.lineHighlightBackground', 'editor.findMatchBackground']) {
    for (const foreground of foregrounds) readable(foreground, theme.colors[key], key);
  }
  for (const state of ['activeSelection', 'inactiveSelection', 'focus', 'hover']) {
    readable(theme.colors[`list.${state}Foreground`], theme.colors[`list.${state}Background`], `list.${state}`);
  }
  readable(theme.colors['list.highlightForeground'], theme.colors['list.activeSelectionBackground'], 'selected filename match');
  readable(theme.colors['sourceInsightInspired.preview.matchForeground'], theme.colors['sourceInsightInspired.preview.matchBackground'], 'Context and Search Results match');
});
