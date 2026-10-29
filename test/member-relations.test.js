'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const sources = {
  'ops.h': 'struct ops { union { int (*xfer)(int); int (*master_xfer)(int); }; int state; };\nstruct dev { struct ops *algo; };\nstruct other { int (*master_xfer)(int); int state; };',
  'core.c': '#include "ops.h"\nint transfer(struct dev *adap) { adap->algo->state++; return adap->algo->master_xfer(1); }\nint again(struct dev *adap) { return adap->algo->xfer(2); }\nint unrelated(struct other *obj) { return obj->master_xfer(obj->state); }',
  'driver.c': '#include "ops.h"\nstatic int chip_xfer(int n) { return n; }\nstatic int replaced(int n) { return n + 1; }\nstruct ops controller = { .xfer = chip_xfer, .state = 3 };\nvoid install(struct dev *adap) { adap->algo->master_xfer = &replaced; }',
  'foreign.c': '#include "ops.h"\nstatic int unrelated_impl(int n) { return n; }\nstruct other foreign = { .master_xfer = unrelated_impl };'
};
async function fixture(t, persistent = false, extra = {}) {
  const allSources = { ...sources, ...extra };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-members-'));
  const project = pathToFileURL(directory).toString(), parser = await createParser();
  const facts = Object.entries(allSources).map(([name, source]) => {
    const file = path.join(directory, name); return { ...parseC(parser, source, pathToFileURL(file).toString(), file), project };
  }); parser.delete();
  const repository = persistent ? new SqliteIndexRepository(path.join(directory, 'cache'), 'member-test') : undefined;
  const descriptors = facts.map(file => ({ uri: file.uri, path: file.path, project }));
  if (repository) { await repository.open(undefined, false, { descriptors }); for (const file of facts) repository.stage(file); }
  const index = new CIndex(repository); index.replace(repository ? [...repository.files.values()] : facts);
  t.after(async () => { repository?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const at = (file, text, occurrence = 0) => {
    const source = allSources[file]; let offset = -1;
    for (let n = 0; n <= occurrence; n++) offset = source.indexOf(text, offset + 1);
    assert(offset >= 0); const prefix = source.slice(0, offset).split('\n');
    return { uri: facts.find(value => value.path.endsWith(file)).uri, point: { line: prefix.length - 1, character: prefix.at(-1).length } };
  };
  return { index, facts, repository, descriptors, at };
}
function root(f, file = 'core.c', text = 'master_xfer') {
  const source = f.at(file, text), values = f.index.prepare(source.uri, source.point, text);
  assert.equal(values.length, 1, 'The selected typed member must be a relation root');
  return f.index.item(values[0]);
}
test('typed function-pointer members expose callers, union alias initializers and assignment candidates', async t => {
  const f = await fixture(t), member = root(f);
  assert.equal(member.kind, 7);
  assert.deepEqual(f.index.calls(member, 'incoming').map(call => call.from.name).sort(), ['again', 'transfer']);
  const candidates = f.index.calls(member, 'outgoing');
  assert.deepEqual(candidates.map(call => call.to.name).sort(), ['chip_xfer', 'replaced']);
  assert(candidates.every(call => /候选/.test(call.to.detail)));
  assert(candidates.every(call => call.siteLocations.every(site => site.uri.endsWith('/driver.c'))));
  const fn = [...f.index.functions.values()].find(value => value.name === 'transfer');
  assert(f.index.calls(f.index.item(fn), 'outgoing').some(call => call.to.name === 'master_xfer' && call.to.kind === 7));
});
test('ordinary structure members expose bound references and containing functions without unrelated same-name members', async t => {
  const f = await fixture(t), member = root(f, 'core.c', 'state');
  assert.deepEqual(f.index.calls(member, 'incoming').map(call => call.from.name), ['transfer']);
  assert.deepEqual(f.index.calls(member, 'outgoing'), []);
  const source = f.at('core.c', 'state');
  const references = [...f.index.referenceSites(source.uri, source.point)].filter(Boolean);
  assert(references.some(site => site.uri.endsWith('/driver.c')));
  assert(!references.some(site => site.uri.endsWith('/foreign.c')));
  assert(!references.some(site => site.uri.endsWith('/core.c') && site.range.start.line === 3));
});
test('member relations survive SQLite reopen and discard removed assignments after an index update', async t => {
  const f = await fixture(t, true);
  await f.repository.open(undefined, false, { descriptors: f.descriptors }); f.index.replace([...f.repository.files.values()]);
  assert.deepEqual(f.index.calls(root(f), 'outgoing').map(call => call.to.name).sort(), ['chip_xfer', 'replaced']);
  const previous = f.facts.find(file => file.uri.endsWith('/driver.c')), parser = await createParser();
  const changed = { ...parseC(parser, '#include "ops.h"\n', previous.uri, previous.path), project: previous.project }; parser.delete();
  f.repository.stage(changed); f.index.update(f.repository.get(changed.uri));
  assert.deepEqual(f.index.calls(root(f), 'outgoing'), []);
});


test('typedef callbacks and function-pointer arrays retain typed uses and assignment candidates', async t => {
  const f = await fixture(t, false, { 'typed.c': '#include "ops.h"\ntypedef int (*callback_t)(int);\nstruct typed_ops { callback_t work; int (*batch[2])(int); };\nstatic int typed_impl(int v) { return v; }\nstruct typed_ops table = { .work = typed_impl };\nint typed_run(struct typed_ops *p) { p->batch[0] = typed_impl; return p->work(1) + p->batch[0](2); }' });
  for (const name of ['work', 'batch']) {
    const member = root(f, 'typed.c', name);
    assert.deepEqual(f.index.calls(member, 'incoming').map(call => call.from.name), ['typed_run']);
    assert.deepEqual(f.index.calls(member, 'outgoing').map(call => call.to.name), ['typed_impl']);
  }
});

test('identical member names and declarations in an independent project do not mix relations', async t => {
  const f = await fixture(t), parser = await createParser(), other = [];
  for (const [name, text] of Object.entries({ 'ops.h': sources['ops.h'], 'driver.c': '#include "ops.h"\nint foreign_callback(int n) { return n; }\nstruct ops foreign_ops = { .xfer = foreign_callback };\nint foreign_call(struct dev *p) { return p->algo->master_xfer(3); }' })) {
    const file = path.join(path.dirname(f.facts[0].path), 'other', name);
    other.push({ ...parseC(parser, text, pathToFileURL(file).toString(), file), project: 'other-project' });
  }
  parser.delete(); f.index.replace([...f.facts, ...other]);
  const member = root(f);
  assert.deepEqual(f.index.calls(member, 'incoming').map(call => call.from.name).sort(), ['again', 'transfer']);
  assert.deepEqual(f.index.calls(member, 'outgoing').map(call => call.to.name).sort(), ['chip_xfer', 'replaced']);
});

test('stale or missing member handles return a retryable explanation', async t => {
  const f = await fixture(t);
  const missing = { sourceInsightReaderLocal: { id: 'missing', member: { uri: f.facts[0].uri, position: { line: 999, character: 0 } } } };
  assert.deepEqual(f.index.calls(missing, 'incoming'), []);
  assert.match(f.index.callDiagnostics(missing, 'incoming').join(''), /已变化/);
});


test('automatic Relation follows a member variable instead of replacing it with the enclosing function', () => {
  const { fakeVscode, loadWithVscode } = require('./fake-vscode');
  const env = fakeVscode(), document = env.document('member-follow.c', 'int use(struct dev *p) { p->algo->state++; return p->algo->master_xfer(1); }');
  const { FollowController } = loadWithVscode('../src/application/follow-controller', env.api);
  const follow = new FollowController({ session: { editor: { document } } });
  const fn = { name: 'use', uri: document.uri, kind: 11, range: new env.api.Range(0, 0, 0, 80), selectionRange: new env.api.Range(0, 4, 0, 7) };
  try {
    for (const name of ['state', 'master_xfer']) {
      const start = document.text.indexOf(name), source = { uri: document.uri, range: new env.api.Range(0, start, 0, start), name };
      const selected = follow.relationSource(fn, source);
      assert.equal(selected.name, name);
      assert.equal(selected.range.start.character, start);
    }
  } finally { follow.dispose(); }
});


test('ordinary callback definitions expose their registration slot and potential slot callers in both index stores', async t => {
  for (const persistent of [false, true]) {
    const f = await fixture(t, persistent, {
      'file-ops.h': 'struct file; struct file_operations { int (*read)(struct file *); }; struct file { const struct file_operations *f_op; };',
      'i2cdev.c': '#include "file-ops.h"\nstatic int receive(void) { return 1; }\nstatic int i2cdev_read(struct file *file) { return receive(); }\nstatic const struct file_operations fops = { .read = i2cdev_read };',
      'vfs.c': '#include "file-ops.h"\nint vfs_read(struct file *file) { return file->f_op->read(file); }',
      'other-i2cdev.c': '#include "file-ops.h"\nstatic int i2cdev_read(struct file *file) { return 2; }\nstruct file_operations other_fops = { .read = i2cdev_read };'
    });
    const fn = [...f.index.functions.values()].find(value => value.name === 'i2cdev_read');
    const item = f.index.item(fn), incoming = f.index.calls(item, 'incoming');
    const registration = incoming.find(call => call.from.kind === 7 && call.from.name === 'read'); assert(registration);
    assert(registration.siteLocations.every(site => site.uri.endsWith('/i2cdev.c')), 'Same-name static callbacks must retain their own registrations');
    const caller = incoming.find(call => call.from.name === 'vfs_read'); assert(caller);
    assert.match(caller.from.detail, /候选/);
    assert(caller.siteLocations.every(site => site.uri.endsWith('/vfs.c')));
    assert.deepEqual(f.index.calls(item, 'outgoing').map(call => call.to.name), ['receive']);
    if (persistent) {
      await f.repository.open(undefined, false, { descriptors: f.descriptors }); f.index.replace([...f.repository.files.values()]);
      assert(f.index.calls(f.index.item(fn), 'incoming').some(call => call.from.name === 'vfs_read'));
    }
  }
});


test('nested SQLite occurrence queries preserve the suspended outer iterator and callback aliases', async t => {
  const f = await fixture(t, true), repository = f.repository;
  const project = f.facts[0].project;
  const expected = [...repository.occurrences('chip_xfer', project)];
  const actual = [];
  for (const token of repository.occurrences('chip_xfer', project)) {
    actual.push(token);
    assert([...repository.occurrences('xfer', project)].length > 0);
  }
  assert.deepEqual(actual, expected);
  const fn = [...f.index.functions.values()].find(value => value.name === 'chip_xfer');
  assert.deepEqual(f.index.calls(f.index.item(fn), 'incoming').filter(call => call.from.kind !== 7).map(call => call.from.name).sort(), ['again', 'transfer']);
});
