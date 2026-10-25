'use strict';
const { createParser, parseC } = require('../c-parser');
const { parseCpp } = require('../cpp-outline');
const { isCppHeader } = require('./source-text');
class SourceParser {
  constructor() { this.c = undefined; this.cpp = undefined; }
  async parse(task, check) {
    const cpp = /\.(?:cc|cpp|cxx|c\+\+|hpp|hh|hxx)$/i.test(task.path) || isCppHeader(task.source, task.path);
    if (cpp) { this.cpp ||= await createParser('cpp'); return parseCpp(this.cpp, task.source, task.uri, task.path, check); }
    this.c ||= await createParser(); return parseC(this.c, task.source, task.uri, task.path, check, { declarationsOnly: task.bytes > 8 * 1024 * 1024 });
  }
  close() { this.c?.delete(); this.cpp?.delete(); }
}
module.exports = { SourceParser };
