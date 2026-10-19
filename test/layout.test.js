'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup(mode = 'sourceInsight', explicit) {
  const env = fakeVscode(), state = new Map(), commands = [];
  env.context.workspaceState = { get(key) { return state.get(key); }, async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); } };
  env.settings.set('sourceInsightInspired.layout', mode);
  if (explicit) env.settings.set('workbench.sideBar.location', explicit);
  const getConfig = env.api.workspace.getConfiguration;
  env.api.workspace.getConfiguration = section => {
    const config = getConfig(section);
    config.inspect = key => ({ workspaceValue: env.settings.get(`${section}.${key}`) });
    config.update = async (key, value) => { if (value === undefined) env.settings.delete(`${section}.${key}`); else env.settings.set(`${section}.${key}`, value); };
    return config;
  };
  const execute = env.api.commands.executeCommand;
  env.api.commands.executeCommand = async (command, ...args) => { commands.push(command); return execute(command, ...args); };
  const { ReadingLayout } = loadWithVscode('../src/layout', env.api);
  return { env, state, commands, layout: new ReadingLayout(env.context) };
}

test('screenshot layout puts native Explorer on right and symbols on opposite side without losing previous sidebar settings', async () => {
  const s = setup(); await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'right');
  assert.ok(s.commands.includes('workbench.files.action.focusFilesExplorer'));
  assert.ok(s.commands.includes('sourceInsightInspired.symbols.focus'));
  assert.ok(s.commands.includes('workbench.action.positionPanelBottom'));
  assert.ok(s.commands.includes('workbench.action.alignPanelJustify'));
  assert.ok(s.commands.includes('sourceInsightInspired.context.focus'));
  assert.ok(!s.commands.includes('sourceInsightInspired.relations.focus'));
  await s.layout.apply(); await s.layout.restore();
  assert.equal(s.env.settings.has('workbench.sideBar.location'), false);
  assert.equal(s.env.settings.get('sourceInsightInspired.layout'), 'preserve');
});

test('layout migration runs once and keeps a newer manual sidebar position across reload', async () => {
  const s = setup('sourceInsight', 'left'); await s.layout.initialize();
  s.env.settings.set('workbench.sideBar.location', 'left');
  await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
  await s.layout.restore(); assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
});

test('preserve layout never changes sidebar placement and retains current editor focus', async () => {
  const s = setup('preserve', 'left');
  s.env.api.window.activeTextEditor = { viewColumn: 1 };
  await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
  assert.ok(!s.commands.includes('workbench.action.positionPanelBottom'));
  assert.equal(s.commands.at(-1), 'workbench.action.focusActiveEditorGroup');
});
