'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser } = require('../src/c-parser');
const { cColorSpans, uncoveredSpans } = require('../src/infrastructure/c-color-spans');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const THEME = 'SourceInsight-Reader Source Insight';
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const turn = () => new Promise(resolve => setImmediate(resolve));
function tagged(source) {
  return cColorSpans(parser, source).map(span => ({ ...span, name: source.split('\n')[span.line].slice(span.start, span.end) }));
}
function environment(source = 'int run(int value) { return value; }') {
  const env = fakeVscode(), document = env.document('colors.c', source); document.languageId = 'c';
  env.settings.set('workbench.colorTheme', THEME);
  return { env, document };
}
function nativeEditor(env, document, from = 0, to = document.lineCount - 1) {
  const calls = new Map(), editor = { document, visibleRanges: [new env.api.Range(from, 0, to, 0)],
    setDecorations(type, ranges) { calls.set(type, ranges); } };
  env.api.window.visibleTextEditors.push(editor); return { editor, calls };
}

test('offline C colors distinguish definitions, parameters, variables, fields and direct calls', () => {
  const source = 'struct R { int field; };\nint leaf(int p) { int local = p; return local; }\nint run(struct R *r) { return leaf(r->field); }';
  const tokens = tagged(source), named = name => tokens.filter(token => token.name === name);
  assert.equal(named('leaf')[0].type, 'function'); assert.deepEqual(named('leaf')[0].modifiers, ['declaration']);
  assert.deepEqual(named('leaf')[1].modifiers, []);
  assert(named('p').every(token => token.type === 'parameter'));
  assert(named('local').every(token => token.type === 'variable'));
  assert(named('field').every(token => token.type === 'property'));
  assert(named('R').every(token => token.type === 'struct'));
});

test('local syntax colors preserve scoped shadowing, static references and function pointer calls', () => {
  const source = 'enum E { READY }; static int count; int leaf(void);\n' +
    'int run(int (*callback)(int)) { int x = READY + count; { int READY = 0; x += READY; } return READY + callback(x) + leaf(); }';
  const tokens = tagged(source);
  assert.deepEqual(tokens.filter(token => token.name === 'READY').map(token => token.type), ['enumMember', 'enumMember', 'variable', 'variable', 'enumMember']);
  assert(tokens.filter(token => token.name === 'count').every(token => token.modifiers.includes('static')));
  assert(tokens.filter(token => token.name === 'callback').every(token => token.type === 'parameter'));
  assert(tokens.filter(token => token.name === 'leaf').every(token => token.type === 'function'));
});

test('C colors exclude strings, comments, include paths and labels while preserving UTF-16 and CRLF positions', () => {
  const source = '#include "missing/header.h"\r\n#define lower 1\r\nint run(void) { /* 😀 */ int local = lower; const char *s = "fake->field"; goto done; done: return local; }';
  const tokens = tagged(source);
  assert(!tokens.some(token => ['missing', 'header', 'fake', 'field'].includes(token.name)));
  assert(tokens.filter(token => token.name === 'lower').every(token => token.type === 'macro'));
  assert(tokens.filter(token => token.name === 'done').every(token => token.type === 'label'));
  const local = tokens.find(token => token.name === 'local');
  assert.equal(local.line, 2); assert.equal(local.start, source.split('\n')[2].indexOf('local'));
});

test('semantic precedence excludes all overlapping fallback spans including partial coverage', () => {
  const local = [{ line: 1, start: 4, end: 10, type: 'variable' }, { line: 2, start: 0, end: 3, type: 'function' }];
  assert.deepEqual(uncoveredSpans(local, [{ line: 1, start: 6, end: 8 }]), [local[1]]);
  assert.equal(uncoveredSpans(local, [{ line: 1, start: 10, end: 12 }]).length, 2);
  const semantic = [{ line: 1, start: 7, end: 8 }, { line: 1, start: 0, end: 20 }, { line: 1, start: 5, end: 6 }];
  const before = structuredClone(semantic);
  assert.deepEqual(uncoveredSpans(local, semantic), [local[1]]);
  assert.deepEqual(semantic, before);
  const dense = Array.from({ length: 10000 }, (_, index) => ({ line: 0, start: index * 4, end: index * 4 + 2 }));
  assert.equal(uncoveredSpans(dense, dense).length, 0);
});

test('native editor corrects export argument roles while leaving ordinary semantic definitions covered', async t => {
  const source = 'int exported(void){return 1;}\nEXPORT_SYMBOL(exported);\nint count;\nEXPORT_SYMBOL(count);\nint use(void){return count;}\n';
  const { env, document } = environment(source), { editor, calls } = nativeEditor(env, document);
  const createDecoration = env.api.window.createTextEditorDecorationType;
  env.api.window.createTextEditorDecorationType = options => { const value = createDecoration(options); value.options = options; return value; };
  env.settings.set('editor.fontWeight', '500');
  env.commands.set('vscode.provideDocumentSemanticTokensLegend', () => ({ tokenTypes: ['function', 'variable'], tokenModifiers: ['declaration', 'definition'] }));
  env.commands.set('vscode.provideDocumentSemanticTokens', () => ({ data: new Uint32Array([
    0, 4, 8, 0, 3, 1, 14, 8, 0, 1, 1, 4, 5, 1, 3, 1, 14, 5, 1, 1
  ]) }));
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), language = new LanguageAdapter();
  language.localColorTokens = async doc => cColorSpans(parser, doc.getText());
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api), colors = new EditorCColors(language);
  t.after(() => { colors.dispose(); language.dispose(); });
  await colors.update();
  const applied = colors.applied.get(editor).spans;
  for (const line of [1, 3]) {
    const value = applied.find(value => value.line === line && value.start === 14);
    assert(value); assert(!value.modifiers.includes('declaration')); assert(!value.modifiers.includes('definition'));
    assert.equal(value.type, line === 1 ? 'function' : 'variable');
  }
  assert(!applied.some(value => value.line === 0 && value.start === 4));
  assert(!applied.some(value => value.line === 2 && value.start === 4));
  const [decoration] = [...calls].find(([, ranges]) => ranges.some(value => value.start.line === 3 && value.start.character === 14));
  assert.equal(decoration.options.fontWeight, '500'); assert.equal(decoration.options.fontStyle, 'normal');
  document.text = source.replace('EXPORT_SYMBOL(exported);', 'int another;'); document.version++;
  await colors.update();
  assert(!colors.applied.get(editor).spans.some(value => value.line === 1 && value.sourceReference));
});

test('local color Worker runs with indexing absent and reuses only the current document version', async () => {
  const { env, document } = environment();
  const { LocalCColors } = loadWithVscode('../src/local-c-colors', env.api), colors = new LocalCColors();
  try {
    const first = colors.colorize(document);
    assert.equal(colors.colorize(document), first);
    const spans = await first; assert(spans.some(span => span.type === 'parameter'));
    document.text = 'int changed;'; document.version++;
    assert.notEqual(colors.colorize(document), first);
    const changed = await colors.colorize(document);
    assert.equal(changed.length, 1); assert.equal(changed[0].end - changed[0].start, 7);
    assert.equal(colors.worker.resourceLimits.maxOldGenerationSizeMb, 128);
  } finally { colors.dispose(); }
});

test('C colors honor semantic opt-out, theme, language and per-file source budget without creating a Worker', async () => {
  const { env, document } = environment();
  const { LocalCColors, MAX_SOURCE } = loadWithVscode('../src/local-c-colors', env.api), colors = new LocalCColors();
  try {
    for (const [key, value] of [['editor.semanticHighlighting.enabled', false], ['editor.semanticHighlighting.enabled', 'configuredByTheme']]) {
      env.settings.set(key, value);
      if (value !== false) env.settings.set('editor.semanticTokenColorCustomizations', { [`[${THEME}]`]: { enabled: false } });
      assert.deepEqual(await colors.colorize(document), []);
    }
    env.settings.delete('editor.semanticTokenColorCustomizations'); env.settings.set('workbench.colorTheme', 'Other');
    assert.deepEqual(await colors.colorize(document), []);
    env.settings.set('workbench.colorTheme', THEME); document.languageId = 'cpp';
    assert.deepEqual(await colors.colorize(document), []);
    document.languageId = 'c'; document.text = 'a'.repeat(MAX_SOURCE + 1);
    assert.deepEqual(await colors.colorize(document), []); assert.equal(colors.worker, undefined);
  } finally { colors.dispose(); }
});

test('a stale Worker response and disposal cannot return colors for changed source', async () => {
  const { env, document } = environment();
  const { LocalCColors } = loadWithVscode('../src/local-c-colors', env.api), colors = new LocalCColors();
  const request = colors.colorize(document); document.version++;
  assert.deepEqual(await request, []);
  const next = colors.colorize(document); colors.dispose();
  assert.deepEqual(await next, []); assert.equal(colors.pending.size, 0); assert.equal(colors.cache.size, 0);
});

test('Worker failure backs off then recovers the same unchanged document version', async () => {
  const { env, document } = environment();
  const { LocalCColors } = loadWithVscode('../src/local-c-colors', env.api), colors = new LocalCColors();
  try {
    const pending = colors.colorize(document); colors.worker.emit('error', new Error('simulated memory limit'));
    assert.deepEqual(await pending, []); assert.equal(colors.worker, undefined);
    assert.deepEqual(await colors.colorize(document), []); assert.equal(colors.worker, undefined);
    colors.cooldown = 0;
    assert.deepEqual(await colors.colorize(document), []); assert.equal(colors.worker, undefined);
    colors.failed.get(document).retryAt = 0;
    assert((await colors.colorize(document)).length > 0);
    assert.equal(colors.failed.get(document), undefined);
  } finally { colors.dispose(); }
});

test('native editor decorates visible syntax gaps, preserves semantic providers and shares split-editor work', async () => {
  const { env, document } = environment('int run(int value) { return value + external(); }\nint hidden;');
  const first = nativeEditor(env, document, 0, 0), second = nativeEditor(env, document, 0, 0);
  let parses = 0, queries = 0;
  const local = cColorSpans(parser, document.text), external = local.find(span => document.lineAt(span.line).text.slice(span.start, span.end) === 'external');
  const language = { allowed: () => true, localCColors: { enabled: () => true },
    async localColorTokens() { parses++; return local; }, async semanticTokens() { queries++; return [external]; } };
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api), colors = new EditorCColors(language);
  try {
    await colors.update(); assert.equal(parses, 1); assert.equal(queries, 1);
    for (const { editor, calls } of [first, second]) {
      const applied = colors.applied.get(editor).spans;
      assert(applied.length > 0); assert(applied.every(span => span.line === 0 && span.start !== external.start));
      assert([...calls.values()].some(ranges => ranges.length));
    }
    language.semanticTokens = async () => local; await colors.update();
    assert.deepEqual(colors.applied.get(first.editor).spans, []);
    assert([...first.calls.values()].every(ranges => !ranges.length));
    language.localCColors.enabled = () => false; await colors.update();
    assert([...first.calls.values()].every(ranges => !ranges.length));
  } finally { colors.dispose(); }
});

test('native fallback reads window color settings and resource highlighting without stale edits', async () => {
  const { env, document } = environment('int local;'); const { editor, calls } = nativeEditor(env, document);
  const original = env.api.workspace.getConfiguration;
  let scoped = false, windowColors = false;
  env.api.workspace.getConfiguration = (section, scope) => {
    const config = original(section, scope);
    if (section !== 'editor') return config;
    return { ...config, get: (key, fallback) => {
      if (key === 'semanticTokenColorCustomizations') { assert.equal(scope, undefined); windowColors = true; }
      if (key === 'semanticHighlighting.enabled') { assert.equal(scope.uri, document.uri); assert.equal(scope.languageId, 'c'); scoped = true; }
      return config.get(key, fallback);
    } };
  };
  env.settings.set('editor.semanticTokenColorCustomizations', { rules: { 'variable.declaration:c': { foreground: '#123456', bold: false } } });
  const { semanticColoringEnabled } = loadWithVscode('../src/local-c-colors', env.api);
  let resolve;
  const local = cColorSpans(parser, document.text), language = { allowed: () => true, localCColors: { enabled: semanticColoringEnabled },
    localColorTokens: async () => local, semanticTokens: async () => [] };
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api), colors = new EditorCColors(language);
  try {
    await colors.update(); assert(scoped); assert(windowColors);
    assert.equal(colors.applied.get(editor).spans[0].style.foreground, '#123456');
    assert.equal(colors.applied.get(editor).spans[0].style.bold, false);
    language.localColorTokens = () => new Promise(done => { resolve = done; });
    const pending = colors.update(); document.version++;
    env.events.document.fire({ document }); resolve(local); await pending;
    assert.equal(colors.applied.get(editor), undefined); assert([...calls.values()].every(ranges => !ranges.length));
  } finally { colors.dispose(); }
});

test('Context shares offline C classification and keeps external semantics above fallback and grammar', async () => {
  const { env, document } = environment('int run(int value) { int local = value; return local; }');
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const local = cColorSpans(parser, document.text), reference = local.at(-1);
  env.settings.set('editor.semanticTokenColorCustomizations', { rules: { 'enumMember:c': '#123456' } });
  const view = new ContextView({ localColorTokens: async () => local,
    semanticTokens: async () => [{ ...reference, type: 'enumMember', modifiers: [] }],
    textmateTokens: async () => [{ line: 0, start: 0, end: document.text.length, foreground: '#000000' }] }, () => {});
  try {
    await view.show({ uri: document.uri, range: new env.api.Range(0, 0, 0, 0) }); await turn();
    const tokens = view.state.lines[0].tokens;
    assert.equal(tokens.map(token => token.text).join(''), document.text);
    assert.equal(tokens.find(token => token.text === 'value').foreground, '#000080');
    assert.equal(tokens.filter(token => token.text === 'local').at(-1).foreground, '#123456');
    assert.equal(tokens.filter(token => token.text === 'local')[0].foreground, '#000080');
  } finally { view.dispose(); }
});

test('a late local color response cannot recolor a replaced Context preview', async () => {
  const { env, document } = environment('int first;'), next = env.document('next.c', 'int second;'); next.languageId = 'c';
  const { ContextView } = loadWithVscode('../src/context', env.api);
  let resolve;
  const view = new ContextView({ localColorTokens: doc => doc === document ? new Promise(done => { resolve = done; }) : Promise.resolve([]) }, () => {});
  try {
    await view.show({ uri: document.uri, range: new env.api.Range(0, 0, 0, 0) }); await turn();
    await view.show({ uri: next.uri, range: new env.api.Range(0, 0, 0, 0) });
    resolve(cColorSpans(parser, document.text)); await turn();
    assert.equal(view.state.lines[0].tokens.find(token => token.text === 'second').foreground, '#000000');
  } finally { view.dispose(); }
});

test('semantic color queries share in-flight work and retain the slot until the real provider completes', async () => {
  const { env, document } = environment();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), language = new LanguageAdapter();
  let queries = 0, resolve;
  env.commands.set('vscode.provideDocumentSemanticTokensLegend', () => ({ tokenTypes: ['variable'], tokenModifiers: [] }));
  env.commands.set('vscode.provideDocumentSemanticTokens', () => { queries++; return new Promise(done => { resolve = done; }); });
  try {
    const first = language.semanticTokens(document.uri), second = language.semanticTokens(document.uri); await turn();
    assert.equal(queries, 1); assert.equal(language.semanticColorInflight.size, 1);
    document.version++; language.semanticColorRequests.delete(document);
    assert.deepEqual(await language.semanticTokens(document.uri), []); assert.equal(queries, 1);
    resolve({ data: new Uint32Array([0, 4, 3, 0, 0]) });
    assert.deepEqual(await first, []); assert.deepEqual(await second, []); assert.equal(language.semanticColorInflight.size, 0);
    env.commands.set('vscode.provideDocumentSemanticTokens', () => { queries++; return { data: new Uint32Array([0, 4, 3, 0, 0]) }; });
    language.semanticColorRequests.delete(document);
    assert.equal((await language.semanticTokens(document.uri)).length, 1); assert.equal(queries, 2);
  } finally { language.dispose(); }
});

test('semantic color requests respect the actual document language settings and bound stuck documents globally', async () => {
  const { env, document } = environment();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), language = new LanguageAdapter();
  const original = env.api.workspace.getConfiguration;
  env.api.workspace.getConfiguration = (section, scope) => section === 'editor' && scope?.languageId === 'c'
    ? { get: (key, fallback) => key === 'semanticHighlighting.enabled' ? false : fallback } : original(section, scope);
  try {
    assert.deepEqual(await language.semanticTokens(document.uri), []); assert.equal(language.semanticColorInflight.size, 0);
    env.api.workspace.getConfiguration = original;
    let resolve;
    const stuck = new Promise(done => { resolve = done; });
    env.commands.set('vscode.provideDocumentSemanticTokens', () => stuck);
    const requests = Array.from({ length: 5 }, (_, i) => {
      const doc = env.document(`stuck${i}.c`); doc.languageId = 'c'; return language.semanticTokens(doc.uri);
    });
    await turn(); assert.equal(language.semanticColorInflight.size, 4); assert.deepEqual(await requests[4], []);
    resolve(undefined); await Promise.all(requests);
  } finally { language.dispose(); }
});

test('semantic colors arriving after the display timeout can reclaim fallback on the next refresh', async () => {
  const { env, document } = environment();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), language = new LanguageAdapter();
  let resolve;
  env.commands.set('vscode.provideDocumentSemanticTokensLegend', () => ({ tokenTypes: ['variable'], tokenModifiers: [] }));
  env.commands.set('vscode.provideDocumentSemanticTokens', () => new Promise(done => { resolve = done; }));
  try {
    assert.deepEqual(await language.semanticTokens(document.uri), []);
    assert.equal(language.semanticColorInflight.size, 1);
    resolve({ data: new Uint32Array([0, 4, 3, 0, 0]) }); await turn();
    language.semanticColorRequests.delete(document);
    assert.equal((await language.semanticTokens(document.uri)).length, 1);
    assert.equal(language.semanticColorInflight.size, 1);
    language.queries.invalidate(); language.semanticColorRequests.delete(document);
    resolve(undefined); await turn();
    env.commands.set('vscode.provideDocumentSemanticTokens', () => undefined);
    assert.deepEqual(await language.semanticTokens(document.uri), []);
  } finally { language.dispose(); }
});

test('unbound identifiers stay neutral while scoped definitions retain their colors', async t => {
  const source = 'int known; int run(int p) { return known + p + MISSING + absent(); }';
  const tokens = tagged(source);
  assert(tokens.filter(token => ['MISSING', 'absent'].includes(token.name)).every(token => token.unresolved));
  assert(tokens.filter(token => ['known', 'p', 'run'].includes(token.name)).every(token => !token.unresolved));
  const { env, document } = environment(source), { editor } = nativeEditor(env, document);
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api);
  const colors = new EditorCColors({ allowed: () => true, localCColors: { enabled: () => true },
    localColorTokens: async () => tokens, semanticTokens: async () => [] });
  t.after(() => colors.dispose()); await colors.update();
  for (const span of colors.applied.get(editor).spans.filter(span => span.unresolved)) {
    assert.equal(span.style.foreground.id, 'editor.foreground'); assert.equal(span.style.bold, false);
  }
  const { colorTokens } = require('../src/preview-colors');
  const preview = colorTokens([{ text: source, kind: 'plain' }], 0, tokens, 'c', { 'function': '#ff0000' });
  for (const name of ['MISSING', 'absent']) {
    const token = preview.find(token => token.text === name);
    assert.equal(token.foreground, '#000000'); assert.equal(token.defaultText, true); assert.equal(token.bold, false);
  }
});

test('project macro classification reaches editor and Context, with visible references checked first', async t => {
  const { env, document } = environment('int run(void) { return ESP_OK + MISSING; }'), { editor } = nativeEditor(env, document);
  const spans = cColorSpans(parser, document.text), at = document.text.indexOf('ESP_OK');
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const language = new LanguageAdapter({ colorResolutions: async (_doc, candidates) => {
    assert(candidates.some(span => span.start === at));
    assert(candidates.every(span => span.line === 0));
    return [{ line: 0, start: at, type: 'macro' }];
  } });
  language.localCColors.colorize = async () => [...spans, { line: 100, start: 0, end: 7, type: 'variable', modifiers: [], unresolved: true }];
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api), colors = new EditorCColors(language);
  t.after(() => { colors.dispose(); language.dispose(); });
  await colors.update();
  const applied = colors.applied.get(editor).spans;
  assert.equal(applied.find(span => span.start === at).style.foreground, '#c00000');
  assert.equal(applied.find(span => span.start === document.text.indexOf('MISSING')).style.foreground.id, 'editor.foreground');
});

test('provider-confirmed macros explicitly use Context theme rules in the main editor', async t => {
  const { env, document } = environment('#define ESP_OK 0\nint run(void) { return ESP_OK + MISSING; }'), { editor } = nativeEditor(env, document);
  const local = cColorSpans(parser, document.text);
  const semantic = [{ line: 0, start: 8, end: 14, type: 'macro', modifiers: ['declaration'] },
    { line: 1, start: 23, end: 29, type: 'macro', modifiers: [] }];
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api);
  const colors = new EditorCColors({ allowed: () => true, localCColors: { enabled: () => true },
    localColorTokens: async () => local, semanticTokens: async () => semantic });
  t.after(() => colors.dispose());
  await colors.update();
  const macros = () => colors.applied.get(editor).spans.filter(span => span.type === 'macro');
  assert.equal(macros().find(span => span.line === 0).style.foreground, '#c00000');
  assert.equal(macros().find(span => span.line === 1).style.foreground, '#c00000');
  env.settings.set('editor.semanticTokenColorCustomizations', { rules: { 'macro:c': '#123456' } });
  await colors.update(); assert.equal(macros().find(span => span.line === 1).style.foreground, '#123456');
});


test('rendered Source Insight theme enables variable coloring despite stale remote theme configuration', async t => {
  const { env, document } = environment('int value; int run(void) { return value + UNKNOWN; }');
  env.settings.set('workbench.colorTheme', 'Dark 2026');
  const cache = new Map();
  const theme = loadWithVscode('../src/theme', env.api, cache);
  const { LocalCColors } = loadWithVscode('../src/local-c-colors', env.api, cache);
  const local = new LocalCColors(); t.after(() => local.dispose());
  const { editor } = nativeEditor(env, document);
  const { EditorCColors } = loadWithVscode('../src/editor-c-colors', env.api, cache);
  const colors = new EditorCColors({ allowed: () => true, localCColors: local,
    localColorTokens: doc => local.colorize(doc), semanticTokens: async () => [] });
  t.after(() => colors.dispose());
  await colors.update(); assert.equal(colors.applied.get(editor), undefined);
  theme.observeTheme(THEME);
  await colors.update();
  const variable = colors.applied.get(editor).spans.find(span => span.start === document.text.indexOf('value +'));
  assert.equal(variable.style.foreground, '#006b6b');
  assert.equal(env.settings.get('workbench.colorTheme'), 'Dark 2026', 'Never rewrite the user configuration');
  env.settings.set('editor.semanticHighlighting.enabled', false);
  await colors.update(); assert.equal(colors.applied.get(editor), undefined);
  env.settings.set('editor.semanticHighlighting.enabled', true);
  theme.observeTheme('Default Dark Modern');
  await colors.update(); assert.equal(colors.applied.get(editor), undefined, 'Do not force Source Insight colors onto an actual different theme');
});
