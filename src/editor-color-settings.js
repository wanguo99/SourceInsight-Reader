'use strict';
const theme = require('../themes/sourceinsight-reader-color-theme.json');
const { THEME_ID } = require('./theme');

function scopedSettings(settings = {}, themeId = THEME_ID) {
  const values = [settings];
  for (const [key, value] of Object.entries(settings)) {
    if (!value || typeof value !== 'object' || !key.startsWith('[') || !key.endsWith(']')) continue;
    if ([...key.matchAll(/\[([^\]]+)\]/g)].some(match => {
      const pattern = match[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${pattern}$`).test(themeId);
    })) values.push(value);
  }
  return values;
}

function textmateTheme(tokenCustom = {}, colorCustom = {}) {
  const colors = Object.assign({}, theme.colors, ...scopedSettings(colorCustom));
  const settings = [{ settings: { foreground: colors['editor.foreground'], background: colors['editor.background'] } }, ...theme.tokenColors];
  const groups = { comments: ['comment', 'punctuation.definition.comment'], strings: ['string', 'meta.embedded.assembly'],
    keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'], numbers: ['constant.numeric'],
    types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], functions: ['entity.name.function', 'support.function'],
    variables: ['variable', 'entity.name.variable'] };
  for (const custom of scopedSettings(tokenCustom)) {
    for (const [group, scopes] of Object.entries(groups)) {
      const value = custom[group];
      if (value) for (const scope of scopes) settings.push({ scope, settings: typeof value === 'string' ? { foreground: value } : value });
    }
    if (Array.isArray(custom.textMateRules)) settings.push(...custom.textMateRules.filter(rule => rule.scope && rule.settings));
  }
  return { name: THEME_ID, settings };
}

module.exports = { scopedSettings, textmateTheme };
