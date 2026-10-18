'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestGate, NavigationHistory, normalizeLocation, normalizeSymbols, filterSymbols,
  enclosingFunction, uniqueLocations, normalizeCalls, locationKey, globRegex } = require('../src/core');

const uri = name => ({ toString: () => `file:///${name}` });
const range = (line, start = 0, end = start + 4) => ({ start: { line, character: start }, end: { line, character: end } });
const location = (name, line, start = 0) => ({ uri: uri(name), range: range(line, start) });

test('request gate rejects late results, invalidated requests and disposed callbacks', async () => {
  const gate = new RequestGate();
  const a = gate.next();
  const b = gate.next();
  assert.equal(gate.current(a), false);
  assert.equal(gate.current(b), true);
  gate.invalidate(); assert.equal(gate.current(b), false);
  const c = gate.next(); gate.dispose(); assert.equal(gate.current(c), false);
});

test('references deduplicate full ranges without losing two matches on the same line', () => {
  const a = location('a.cpp', 1, 3);
  const b = location('a.cpp', 1, 15);
  const c = location('b.cpp', 1, 3);
  assert.deepEqual(uniqueLocations([a, a, b, c]), [a, b, c]);
});

test('definition links use selection range and preserve actual target URI', () => {
  const selection = range(3, 4);
  const targetUri = uri('target.cpp');
  assert.deepEqual(normalizeLocation({ targetUri, targetRange: range(2), targetSelectionRange: selection }),
    { uri: targetUri, range: selection });
});

test('hierarchical function filtering retains containing types with correct displayed parents', () => {
  const nodes = normalizeSymbols([{ name: 'Worker', kind: 4, range: {
    start: { line: 0, character: 0 }, end: { line: 20, character: 0 }
  }, selectionRange: range(0), children: [
    { name: 'zeta', kind: 5, range: range(3), selectionRange: range(3) },
    { name: 'alpha', kind: 5, range: range(5), selectionRange: range(5) },
    { name: 'member', kind: 7, range: range(7), selectionRange: range(7) }
  ] }], uri('a.cpp'));
  const filtered = filterSymbols(nodes, '', 'name');
  assert.deepEqual(filtered[0].children.map(node => node.name), ['alpha', 'zeta']);
  assert.equal(filtered[0].children[0].parent, filtered[0]);
  assert.deepEqual(filterSymbols(nodes, 'zEt')[0].children.map(node => node.name), ['zeta']);
  assert.equal(enclosingFunction(nodes, { line: 3, character: 1 }).name, 'zeta');
  assert.equal(enclosingFunction(nodes, { line: 4, character: 0 }), undefined);
});

test('flat symbol information supports overloads and file-scoped symbols', () => {
  const file = uri('a.cpp');
  const nodes = normalizeSymbols([
    { name: 'run', kind: 11, location: { uri: file, range: range(1) } },
    { name: 'run', kind: 11, location: { uri: file, range: range(5) } }
  ], file);
  assert.equal(filterSymbols(nodes).length, 2);
  assert.notEqual(locationKey(nodes[0]), locationKey(nodes[1]));
});

test('incoming and outgoing call sites belong to caller files', () => {
  const caller = { uri: uri('caller.cpp'), selectionRange: range(1), name: 'caller' };
  const callee = { uri: uri('callee.cpp'), selectionRange: range(2), name: 'callee' };
  const fromRanges = [range(3), range(4), range(4)];
  const incoming = normalizeCalls(callee, [{ from: caller, fromRanges }], 'incoming');
  const outgoing = normalizeCalls(caller, [{ to: callee, fromRanges }], 'outgoing');
  for (const edge of [incoming[0], outgoing[0]]) {
    assert.equal(edge.sites.length, 2);
    assert.equal(edge.sites[0].uri.toString(), caller.uri.toString());
  }
  assert.equal(outgoing[0].uri.toString(), callee.uri.toString());
});

test('path-local cycle detection preserves separate branches', () => {
  const a = { uri: uri('a.cpp'), selectionRange: range(1), name: 'a' };
  const b = { uri: uri('b.cpp'), selectionRange: range(1), name: 'b' };
  const keyA = locationKey({ uri: a.uri, range: a.selectionRange });
  const child = normalizeCalls(a, [{ to: b, fromRanges: [range(3)] }], 'outgoing', [keyA])[0];
  assert.equal(child.cycle, false);
  const cycle = normalizeCalls(b, [{ to: a, fromRanges: [range(4)] }], 'outgoing', child.ancestors)[0];
  assert.equal(cycle.cycle, true);
  assert.equal(normalizeCalls(a, [{ to: b, fromRanges: [] }], 'outgoing', [keyA])[0].cycle, false);
});

test('history truncates forward branch and enforces bounded memory', () => {
  const history = new NavigationHistory(3);
  const a = location('a.cpp', 1), b = location('b.cpp', 1), c = location('c.cpp', 1), d = location('d.cpp', 1);
  history.push(a); history.push(a); history.push(b); history.push(c);
  assert.equal(history.back(), b);
  assert.equal(history.forward(), c);
  history.back(); history.push(d);
  assert.equal(history.forward(), undefined);
  history.push(c);
  assert.equal(history.entries.length, 3);
  assert.equal(history.back(), d);
});

test('file glob subset supports root and nested matches without treating dots as wildcards', () => {
  assert.equal(globRegex('**/.git').test('.git'), true);
  assert.equal(globRegex('**/.git').test('sub/.git'), true);
  assert.equal(globRegex('**/*.cpp').test('reader.cpp'), true);
  assert.equal(globRegex('**/*.cpp').test('src/reader.cpp'), true);
  assert.equal(globRegex('src/*.cpp').test('src/sub/file.cpp'), false);
  assert.equal(globRegex('**/*.cpp').test('readerXcpp'), false);
  assert.equal(globRegex('src/?.h').test('src/a.h'), true);
});
