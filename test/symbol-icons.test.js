'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { symbolIcon } = require('../src/symbol-icons');

test('symbol icons distinguish includes, macros, record types, functions, variables and members independently of translated labels', () => {
  const cases = [
    [{ category: 'include', kind: 0 }, 'include'], [{ category: 'macro', kind: 13 }, 'macro'],
    [{ category: 'struct', kind: 4 }, 'struct'], [{ kind: 22 }, 'struct'],
    [{ category: 'union', kind: 22 }, 'union'], [{ category: 'typedef', kind: 25 }, 'typedef'],
    [{ kind: 9 }, 'enum'], [{ kind: 21 }, 'enum-member'], [{ kind: 11 }, 'function'],
    [{ kind: 5 }, 'function'], [{ kind: 8 }, 'function'], [{ kind: 12 }, 'variable'],
    [{ kind: 13 }, 'constant'], [{ kind: 7 }, 'member'], [{ kind: 6 }, 'member'],
    [{ kind: 25 }, 'typedef'], [{ kind: 4 }, 'type'], [{ kind: 2 }, 'namespace'],
    [{ kind: 0 }, 'file'], [{ kind: 999 }, 'symbol']
  ];
  for (const [node, expected] of cases) {
    assert.equal(symbolIcon(node), expected);
    const svg = fs.readFileSync(path.join(__dirname, `../media/symbol-icons/${expected}.svg`), 'utf8');
    assert.match(svg, /viewBox="0 0 16 16"/);
    assert.doesNotMatch(svg, /<script|<text|<image|font-family|https?:\/\/(?!www\.w3\.org)/);
  }
  const unique = ['include', 'macro', 'struct', 'union', 'typedef', 'enum', 'enum-member', 'function', 'variable', 'constant', 'member'];
  assert.equal(new Set(unique.map(icon => fs.readFileSync(path.join(__dirname, `../media/symbol-icons/${icon}.svg`), 'utf8'))).size, unique.length);
});
