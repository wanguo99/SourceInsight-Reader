'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const state = require('../src/domain/query-state');
const { queryResult } = require('../src/domain/model');
const { Observable } = require('../src/domain/observable');
const { WorkerScheduler } = require('../src/infrastructure/worker-scheduler');
const { JsonIndexRepository } = require('../src/infrastructure/index-repository');
const protocol = require('../shared/protocol');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
test('query state distinguishes loading, refresh, retained errors, actual empty results and stale positions', () => {
  let value = state.begin(state.idle(), 1, 'a'); assert.equal(value.status, 'loading');
  value = state.settle(value, queryResult([1], 'local', 'ready', 'a')); assert.equal(value.status, 'ready'); assert(Object.isFrozen(value.data));
  value = state.begin(value, 2, 'b'); assert.equal(value.status, 'refreshing');
  value = state.settle(value, queryResult([], 'none', 'timeout', 'b')); assert.equal(value.status, 'retained'); assert.deepEqual(value.data, [1]);
  value = state.stale(value, 3); assert.equal(value.status, 'stale');
  const retry = state.settle(state.begin(value, 4, 'c'), queryResult([], 'none', 'timeout', 'c'));
  assert.equal(retry.status, 'failed'); assert.deepEqual(retry.data, []);
  value = state.settle(state.begin(value, 4, 'c'), queryResult([], 'local', 'empty', 'c')); assert.equal(value.status, 'empty'); assert.deepEqual(value.data, []);
});
test('worker foreground queries run between background batches and failed jobs do not stop the scheduler', async () => {
  const scheduler = new WorkerScheduler(), order = [];
  async function* scan() { order.push('scan1'); yield; order.push('scan2'); yield; order.push('scan3'); return 'done'; }
  const background = scheduler.scan(scan());
  const foreground = scheduler.submit(() => { order.push('query'); return 7; });
  const failed = scheduler.submit(() => { throw new Error('failed'); });
  await assert.rejects(failed, /failed/); assert.equal(await foreground, 7); assert.equal(await background, 'done');
  assert(order.indexOf('query') < order.indexOf('scan2'));
  assert.equal(await scheduler.submit(() => 9), 9);
});
test('repository batches atomic snapshots, validates parser version and removes obsolete files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-repository-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'facts.json'), repo = new JsonIndexRepository('parser-v1'); await repo.open(file);
  const fact = n => ({ uri: `file:///${n}.c`, hash: String(n), functions: [], symbols: [], declarations: [], calls: [], includes: [], macros: [] });
  repo.stage(fact(1)); repo.stage(fact(2)); await repo.flush();
  const loaded = new JsonIndexRepository('parser-v1'); await loaded.open(file); assert.equal(loaded.files.size, 2);
  loaded.prune(new Set(['file:///2.c'])); await loaded.flush(); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).files.length, 1);
  const mismatch = new JsonIndexRepository('parser-v2'); await mismatch.open(file); assert.equal(mismatch.files.size, 0);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['facts.json']);
});
test('browser bridge strips absent optional fields, validates sessions and rejects replayed state', async () => {
  let receive; const sent = [], states = [];
  const sandbox = { acquireVsCodeApi: () => ({ postMessage: message => sent.push(message), getState: () => ({}), setState() {} }),
    document: { querySelector: () => ({ content: 'session' }) }, window: { SourceInsightProtocol: protocol, addEventListener: (_, handler) => { receive = handler; } } };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../media/bridge.js'), 'utf8'), sandbox);
  sandbox.window.readerBridge.onMessage(event => states.push(event.data));
  sandbox.window.readerBridge.postMessage({ action: 'relation.refresh', id: undefined });
  assert(protocol.action(sent[0].payload, ['relation.refresh'])); assert.equal('id' in sent[0].payload, false);
  receive({ data: protocol.envelope('wrong', 1, 'state', { n: 0 }) });
  const update = protocol.envelope('session', 1, 'state', { n: 1 }); receive({ data: update }); receive({ data: update });
  assert.equal(states.length, 1); assert.equal(states[0].n, 1);
});
test('combined reading panel delivers index progress independently and restores latest status after reopening', async t => {
  const env = fakeVscode(), events = new Observable(), statusEvents = new Observable(), updates = [];
  const { ReadingPanel } = loadWithVscode('../src/features/reading-panel', env.api);
  let status = { scope: 'index', phase: 'building', busy: true, message: '索引创建中…' };
  const index = { onDidChangeStatus: callback => statusEvents.subscribe(callback), getStatus: () => status };
  const previewActions = [], editorActions = [];
  env.commands.set('workbench.action.navigateBack', () => editorActions.push('back'));
  env.commands.set('workbench.action.navigateForward', () => editorActions.push('forward'));
  const context = { onDidChange: callback => events.subscribe(callback), publish() {}, handleMessage(message) { previewActions.push(message.action); } };
  const relation = { publish: async () => {}, handleMessage() {} }, errors = [];
  const panel = new ReadingPanel(env.context.extensionUri, context, relation, error => errors.push(error), index); t.after(() => panel.dispose());
  const view = () => { const closed = new env.api.EventEmitter(), actions = new env.api.EventEmitter(); return { closed, actions, onDidDispose: closed.event, onDidChangeVisibility: new env.api.EventEmitter().event,
    webview: { cspSource: 'test:', asWebviewUri: uri => uri.toString(), onDidReceiveMessage: actions.event, postMessage: async value => updates.push(value.payload) } }; };
  const first = view(); panel.resolveWebviewView(first); assert.match(first.webview.html, /id="relation-index-status"/); assert.equal(updates.at(-1).message, '索引创建中…');
  assert.match(first.webview.html, /主编辑器位置后退/);
  const session = panel.channel.session;
  for (const [index, action] of ['editorBack', 'editorForward', 'back'].entries()) {
    first.actions.fire(protocol.envelope(session, index + 1, 'action', { action }));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(editorActions, ['back', 'forward']); assert.deepEqual(previewActions, ['back']);
  status = { ...status, operation: 'updating', message: '索引更新中… 16/32 个文件' }; statusEvents.emit(); assert.equal(updates.at(-1).message, status.message);
  first.closed.fire(); const count = updates.length; statusEvents.emit(); assert.equal(updates.length, count);
  status = { ...status, phase: 'ready', busy: false, message: '本地 C 索引：32 个文件' }; panel.resolveWebviewView(view()); assert.equal(updates.at(-1).message, status.message); assert.equal(errors.length, 0);
});
test('local provider keeps raw handles private, relocates old symbols by revision and preserves caller site URI', async t => {
  const env = fakeVscode(), { LocalCProvider } = loadWithVscode('../src/providers/relation-providers', env.api);
  const uri = env.api.Uri.file('/project/api.c'), callerUri = env.api.Uri.file('/project/main.c');
  const raw = line => ({ name: 'api', uri, range: new env.api.Range(line, 0, line + 1, 0), selectionRange: new env.api.Range(line, 4, line, 7), sourceInsightReaderLocal: { id: 'private' + line } });
  let current = raw(0), received;
  const index = { revision: 0, enabled: () => true, supports: () => true, describe: () => ({ state: 'ready', note: 'ready' }), prepare: async () => [current],
    calls: async item => { received = item; return [{ from: { ...raw(1), name: 'main', uri: callerUri }, fromRanges: [new env.api.Range(2, 4, 2, 7)] }]; } };
  const provider = new LocalCProvider(index), first = await provider.prepare({ uri: uri.toString(), range: current.selectionRange, name: 'api' });
  assert.equal('sourceInsightReaderLocal' in first.data[0], false); current = raw(10); index.revision++;
  const calls = await provider.calls(first.data[0], 'incoming'); assert.equal(received, current); assert.equal(calls.data[0].sites[0].uri, callerUri.toString());
  index.revision++; index.prepare = async () => [raw(20), raw(30)];
  assert.equal((await provider.calls(first.data[0], 'incoming')).status, 'ambiguous');
});
