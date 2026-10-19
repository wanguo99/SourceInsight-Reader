'use strict';
const { NavigationHistory } = require('../core');
class ReadingSession {
  constructor() {
    this.editor = undefined; this.position = undefined; this.navigationDepth = 0; this.revealingSymbols = 0;
    this.history = new NavigationHistory(); this.previewKey = undefined; this.relationKey = undefined;
    this.currentReference = undefined; this.activeLookup = 'text';
  }
}
module.exports = { ReadingSession };
