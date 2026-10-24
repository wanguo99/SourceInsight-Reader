'use strict';
const vscode = require('vscode');
const messages = require('../media/messages.en.json');
function english() { return !String(vscode.env?.language || 'zh-cn').toLowerCase().startsWith('zh'); }
const patterns = Object.entries(messages).filter(([key]) => key.includes('{0}')).map(([key, value]) => ({
  pattern: new RegExp('^' + key.split(/\{\d+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(\\d+)') + '$'), value
}));
function t(value) {
  if (!english() || typeof value !== 'string') return value;
  if (messages[value]) return messages[value];
  for (const { pattern, value: translated } of patterns) {
    const match = pattern.exec(value);
    if (match) return translated.replace(/\{(\d+)\}/g, (_, index) => match[Number(index) + 1]);
  }
  return value;
}
function markup(value) {
  if (!english()) return value;
  return value.replace(/(aria-label|title|placeholder)="([^"]*)"/g, (all, key, text) => `${key}="${t(text)}"`)
    .replace(/>([^<>]+)</g, (all, text) => `>${t(text.trim()) === text.trim() ? text : text.replace(text.trim(), t(text.trim()))}<`);
}
module.exports = { t, markup, english };
