'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('bundled light theme maps the provided XML colors and declares Context palette colors', () => {
  const root = path.join(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const preset = manifest.contributes.themes.find(theme => theme.id === 'SourceInsight-Reader Source Insight');
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
  assert.equal(theme.colors['sourceInsightReader.preview.commentForeground'], '#800080');
  assert.equal(theme.semanticTokenColors.number, '#c00000');
  assert.equal(theme.semanticTokenColors['*.definition'].foreground, '#000080');
  const registered = new Set(manifest.contributes.colors.map(color => color.id));
  for (const key of Object.keys(theme.colors).filter(key => key.startsWith('sourceInsightReader.'))) assert.ok(registered.has(key), `Missing color contribution ${key}`);
  assert.equal(theme.semanticHighlighting, true);
});

test('syntax palette stays readable on code, selection and occurrence backgrounds without selection foreground support', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '../themes/sourceinsight-reader-color-theme.json'), 'utf8'));
  const luminance = hex => {
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const readable = (foreground, background, label) => {
    if (background.length === 9) {
      const alpha = parseInt(background.slice(7), 16) / 255;
      const base = theme.colors['editor.background'];
      background = '#' + [1, 3, 5].map(offset => Math.round(parseInt(background.slice(offset, offset + 2), 16) * alpha
        + parseInt(base.slice(offset, offset + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    }
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    const ratio = (values[1] + .05) / (values[0] + .05);
    assert.ok(ratio >= 4.5, `${label}: ${foreground} on ${background} = ${ratio.toFixed(2)}`);
  };
  const foregrounds = new Set([
    ...theme.tokenColors.map(token => token.settings.foreground),
    ...Object.values(theme.semanticTokenColors).map(token => typeof token === 'string' ? token : token.foreground),
    ...Object.entries(theme.colors).filter(([key]) => key.startsWith('sourceInsightReader.preview.') && key.endsWith('Foreground')).map(([, value]) => value)
  ]);
  for (const key of ['editor.background', 'editor.selectionBackground', 'editor.inactiveSelectionBackground',
    'editor.selectionHighlightBackground', 'editor.wordHighlightBackground', 'editor.wordHighlightStrongBackground', 'editor.wordHighlightTextBackground', 'editor.lineHighlightBackground', 'editor.findMatchBackground']) {
    for (const foreground of foregrounds) readable(foreground, theme.colors[key], key);
  }
  for (const state of ['activeSelection', 'inactiveSelection', 'focus', 'hover']) {
    readable(theme.colors[`list.${state}Foreground`], theme.colors[`list.${state}Background`], `list.${state}`);
  }
  readable(theme.colors['list.highlightForeground'], theme.colors['list.activeSelectionBackground'], 'selected filename match');
  readable(theme.colors['sourceInsightReader.preview.matchForeground'], theme.colors['sourceInsightReader.preview.matchBackground'], 'Context and Search Results match');
});

 test('native selection and occurrence highlights share the pinned yellow palette', () => {
  const theme = JSON.parse(fs.readFileSync(path.join(__dirname, '../themes/sourceinsight-reader-color-theme.json'), 'utf8'));
  for (const key of ['selectionHighlight', 'wordHighlight', 'wordHighlightStrong', 'wordHighlightText']) {
    assert.equal(theme.colors[`editor.${key}Background`], '#ffff0080');
    assert.equal(theme.colors[`editor.${key}Background`], theme.colors['sourceInsightReader.symbolHighlight.background']);
    assert.equal(theme.colors[`editor.${key}Border`], theme.colors['sourceInsightReader.symbolHighlight.border']);
  }
});

 test('native theme selection is preserved on activation even with legacy appearance preferences', async () => {
  const env = fakeVscode(), writes = [], requests = [];
  env.settings.set('sourceInsightReader.appearance', 'sourceInsight');
  env.settings.set('workbench.colorTheme', 'My Existing Theme');
  const configuration = env.api.workspace.getConfiguration;
  env.api.workspace.getConfiguration = section => {
    const config = configuration(section), update = config.update;
    config.update = async (key, value, target) => { writes.push(`${section}.${key}`); return update(key, value, target); };
    return config;
  };
  env.api.commands.registerCommand('workbench.action.openSettings', query => requests.push(query));
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  try {
    await Promise.resolve();
    assert.equal(env.settings.get('workbench.colorTheme'), 'My Existing Theme');
    assert.equal(writes.includes('workbench.colorTheme'), false);
    await env.api.commands.executeCommand('sourceInsightReader.openSettings');
    assert.equal(requests.at(-1), '@ext:wanguo.wanguo-sourceinsight-reader');
    assert.equal(env.commands.has('sourceInsightReader.restoreAppearance'), false);
    assert.equal(env.commands.has('sourceInsightReader.chooseAppearance'), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.equal('sourceInsightReader.appearance' in manifest.contributes.configuration.properties, false);
    assert.equal(manifest.contributes.commands.some(item => /restoreAppearance|chooseAppearance/.test(item.command)), false);
    assert.equal(manifest.contributes.themes.length, 1);
  } finally { controller.dispose(); }
});
