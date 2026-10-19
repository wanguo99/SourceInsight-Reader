'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup(mode = 'sourceInsight', explicit, side = 'preserve') {
  const env = fakeVscode(), state = new Map([['layout.independentSymbolsApplied', true]]), commands = [], details = [];
  env.context.workspaceState = { get(key) { return state.get(key); }, async update(key, value) { if (value === undefined) state.delete(key); else state.set(key, value); } };
  env.settings.set('sourceInsightInspired.layout', mode);
  env.settings.set('sourceInsightInspired.explorerSide', side);
  if (explicit) env.settings.set('workbench.sideBar.location', explicit);
  const getConfig = env.api.workspace.getConfiguration;
  env.api.workspace.getConfiguration = section => {
    const config = getConfig(section);
    config.inspect = key => ({ workspaceValue: env.settings.get(`${section}.${key}`) });
    config.update = async (key, value) => { if (value === undefined) env.settings.delete(`${section}.${key}`); else env.settings.set(`${section}.${key}`, value); };
    return config;
  };
  const execute = env.api.commands.executeCommand;
  env.api.commands.executeCommand = async (command, ...args) => { commands.push(command); details.push({ command, args }); return execute(command, ...args); };
  const { ReadingLayout } = loadWithVscode('../src/layout', env.api);
  return { env, state, commands, details, layout: new ReadingLayout(env.context) };
}

test('configured layout puts project files on right and symbols on opposite side without losing previous sidebar settings', async () => {
  const s = setup('sourceInsight', undefined, 'right'); await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'right');
  assert.ok(s.commands.includes('sourceInsightInspired.files.focus'));
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
  const s = setup('sourceInsight', 'left', 'right'); await s.layout.initialize();
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

 test('default layout preserves either sidebar side even when explicitly opening the workbench', async () => {
  for (const side of ['left', 'right']) {
    const s = setup('sourceInsight', side);
    await s.layout.initialize(); await s.layout.apply();
    assert.equal(s.env.settings.get('workbench.sideBar.location'), side);
    assert.equal(s.state.has('layout.previousSidebar'), false);
  }
});
 test('left and right are configurable, preserve stops applying, and restore keeps newer manual choices', async () => {
  const s = setup('sourceInsight', 'right', 'left'); await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
  s.env.settings.set('sourceInsightInspired.explorerSide', 'right'); await s.layout.applySidebar();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'right');
  s.env.settings.set('sourceInsightInspired.explorerSide', 'preserve');
  s.env.settings.set('workbench.sideBar.location', 'left'); await s.layout.applySidebar();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
  await s.layout.restore(); assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
});

 test('new layout puts symbols beside Explorer in the left sidebar and project files on the right only once', async () => {
  const s = setup('sourceInsight', 'right', 'right'); s.state.delete('layout.independentSymbolsApplied');
  await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'left');
  assert.equal(s.env.settings.get('sourceInsightInspired.explorerSide'), 'preserve');
  const moves = s.details.filter(call => call.command === 'vscode.moveViews');
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0].args[0], { viewIds: ['sourceInsightInspired.symbols'], destinationId: 'sourceInsightInspiredSymbols' });
  assert.deepEqual(moves[1].args[0], { viewIds: ['sourceInsightInspired.files'], destinationId: 'sourceInsightInspiredFiles' });
  s.env.settings.set('workbench.sideBar.location', 'right'); await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'right');
  assert.equal(s.details.filter(call => call.command === 'vscode.moveViews').length, 2);
});
 test('preserve mode does not migrate existing view positions', async () => {
  const s = setup('preserve', 'right'); s.state.delete('layout.independentSymbolsApplied');
  await s.layout.initialize();
  assert.equal(s.env.settings.get('workbench.sideBar.location'), 'right');
  assert.equal(s.commands.includes('vscode.moveViews'), false);
});
