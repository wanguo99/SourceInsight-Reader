'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const textmate = require(path.join(__dirname, '../../vendor/textmate/textmate'));
const oniguruma = require(path.join(__dirname, '../../vendor/textmate/oniguruma'));
let initialization;

function onigLib() {
  if (!initialization) initialization = fs.readFile(path.join(__dirname, '../../vendor/textmate/onig.wasm')).then(async buffer => {
    await oniguruma.loadWASM(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    return { createOnigScanner: patterns => new oniguruma.OnigScanner(patterns), createOnigString: value => new oniguruma.OnigString(value) };
  }).catch(error => { initialization = undefined; throw error; });
  return initialization;
}

class TextmateEngine {
  constructor() { this.documents = new Map(); }
  async colorize(message, cancelled = () => false) {
    const key = JSON.stringify([message.grammars, message.theme]);
    if (key !== this.registryKey) {
      this.registry?.dispose(); this.documents.clear();
      const definitions = new Map(message.grammars.map(grammar => [grammar.scopeName, grammar]));
      this.registry = new textmate.Registry({ theme: message.theme, onigLib: onigLib(),
        loadGrammar: async scope => {
          const grammar = definitions.get(scope);
          return grammar ? textmate.parseRawGrammar(await fs.readFile(grammar.path, 'utf8'), grammar.path) : null;
        },
        getInjections: scope => message.grammars.filter(grammar => grammar.injectTo?.includes(scope)).map(grammar => grammar.scopeName)
      });
      this.registryKey = key;
    }
    const definition = [...message.grammars].reverse().find(grammar => grammar.language === message.language);
    if (!definition) return [];
    const grammar = await this.registry.loadGrammar(definition.scopeName);
    if (!grammar || cancelled()) return [];
    let cached = this.documents.get(message.uri);
    if (!cached || cached.text !== message.text || cached.language !== message.language || cached.maxLine !== message.maxLine) {
      cached = { text: message.text, language: message.language, maxLine: message.maxLine,
        lines: message.text.split(/\r?\n/), checkpoints: new Map([[0, textmate.INITIAL]]) };
      this.documents.delete(message.uri); this.documents.set(message.uri, cached);
      while (this.documents.size > 4) this.documents.delete(this.documents.keys().next().value);
    }
    let from = 0;
    for (const line of cached.checkpoints.keys()) if (line <= message.start && line > from) from = line;
    let state = cached.checkpoints.get(from);
    const spans = [], colors = this.registry.getColorMap();
    for (let line = from; line <= Math.min(message.end, cached.lines.length - 1); line++) {
      if (cancelled()) return [];
      const text = cached.lines[line];
      if (text.length <= (message.maxLine || 20000)) {
        const tokens = grammar.tokenizeLine2(text, state, 100);
        if (!tokens.stoppedEarly) {
          state = tokens.ruleStack;
          if (line >= message.start) for (let index = 0; index < tokens.tokens.length; index += 2) {
            const start = tokens.tokens[index], end = index + 2 < tokens.tokens.length ? tokens.tokens[index + 2] : text.length;
            const foreground = colors[(tokens.tokens[index + 1] >>> 15) & 511];
            if (end > start && foreground) {
              const style = (tokens.tokens[index + 1] >>> 11) & 15;
              spans.push({ line, start, end, foreground, defaultText: foreground.toLowerCase() === message.theme.settings[0]?.settings.foreground?.toLowerCase(),
                italic: Boolean(style & 1), bold: Boolean(style & 2), underline: Boolean(style & 4), strikethrough: Boolean(style & 8) });
            }
          }
        }
      }
      if ((line + 1) % 64 === 0) {
        cached.checkpoints.set(line + 1, state);
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    return spans;
  }
  dispose() { this.registry?.dispose(); this.documents.clear(); }
}
module.exports = { TextmateEngine };
