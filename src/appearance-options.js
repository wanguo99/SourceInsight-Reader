'use strict';
const theme = require('../themes/sourceinsight-reader-color-theme.json');
const { semanticColor } = require('./preview-colors');
const { scopedSettings } = require('./editor-color-settings');
const { THEME_ID } = require('./theme');

const panes = { context: 'Context', relation: 'Relation', symbols: '文件符号', files: '工程文件', search: '检索结果' };
const options = [];
const add = (id, label, group, kind, extra) => options.push({ id, label, group, kind, ...extra });
for (const [type, label] of Object.entries({ macro: '宏', enumMember: '枚举成员', enum: '枚举类型', function: '函数', method: '方法',
  variable: '变量', parameter: '参数', property: '结构体字段 / 属性', struct: '结构体', class: '类', interface: '接口',
  type: '类型 / typedef / union', namespace: '命名空间', typeParameter: '类型参数', event: '事件', decorator: '装饰器 / 注解', label: '标签',
  'variable.readonly': '只读变量 / 常量', 'variable.static': '静态变量' })) {
  for (const definition of [true, false]) add(`${type}.${definition ? 'definition' : 'reference'}`, `${label} · ${definition ? '定义 / 声明' : '引用'}`,
    '符号颜色（主编辑器与 Context 共用）', 'semantic', { type: 'color', token: type, definition });
}
for (const [token, label] of Object.entries({ keyword: '关键字', modifier: '修饰符', comment: '注释', string: '字符串', number: '数字', regexp: '正则表达式', operator: '运算符' })) {
  add(`semantic.${token}`, label, '其他语义颜色（优先于语法）', 'semantic', { type: 'color', token, definition: false });
}
const syntaxLabels = { 'Default text and identifiers': '默认文字和标识符', Comment: '注释', Strings: '字符串', Numbers: '数字',
  'Boolean and special constants': '布尔值和特殊常量', 'Keywords and primitive types': '关键字和基础类型', 'Control keywords': '控制关键字',
  Operators: '运算符', Delimiters: '标点和分隔符', Preprocessor: '预处理指令', 'Type references': '类型引用',
  'Function names': '函数名称（语法回退）', Parameters: '参数（语法回退）', Constants: '常量（语法回退）', 'Macro definitions': '宏定义（语法回退）' };
for (const rule of theme.tokenColors) add(`syntax.${rule.name}`, syntaxLabels[rule.name] || rule.name, '语法颜色（主编辑器与 Context 共用）', 'textmate', { type: 'color', rule });
for (const key of ['fontFamily', 'fontSize', 'fontWeight']) add(`editor.${key}`, { fontFamily: '字体类型', fontSize: '字号（px）', fontWeight: '字重（normal / bold / 100–900）' }[key],
  '主编辑器字体', 'editor', { type: key === 'fontSize' ? 'number' : 'text', key });
for (const [id, label] of Object.entries(panes)) {
  for (const [key, name, type] of [['fontFamily', '字体类型', 'text'], ['fontSize', '字号（px）', 'number'], ['foreground', '文字颜色', 'color'], ['background', '背景颜色', 'color']]) {
    add(`${id}.${key}`, id === 'context' && key === 'foreground' ? '默认文字颜色（语法着色优先）' : name, label, 'pane', { type, pane: id, key });
  }
}
for (const [key, label] of Object.entries({ 'editor.background': '主编辑器背景', 'editor.foreground': '主编辑器默认文字',
  'sideBar.background': '原生侧栏背景', 'panel.background': '底部面板背景', 'sideBarTitle.background': '面板标题背景',
  'activityBar.background': '活动栏背景', 'statusBar.background': '状态栏背景', 'titleBar.activeBackground': '标题栏背景',
  'sourceInsightReader.relation.cardBackground': 'Relation 卡片背景', 'sourceInsightReader.relation.cardBorder': 'Relation 卡片边框',
  'sourceInsightReader.relation.edgeForeground': 'Relation 连线', 'sourceInsightReader.relation.selectionBackground': 'Relation 选中卡片',
  'terminal.background': '终端背景', 'terminal.foreground': '终端文字', 'editorGutter.foldingControlForeground': '折叠按钮颜色' })) {
  add(`workbench.${key}`, label, '窗口颜色', 'workbench', { type: 'color', key });
}
add('editor.showFoldingControls', '折叠按钮显示方式', '折叠按钮', 'editor', { type: 'select', key: 'showFoldingControls', choices: ['always', 'mouseover', 'never'] });
add('workbench.productIconTheme', '折叠按钮图标主题', '折叠按钮', 'icon', { type: 'select', choices: ['sourceinsight-reader-folding', 'Default'] });

function validValue(option, value) {
  if (value === '') return true;
  if (option.type === 'color') return /^#[\da-f]{6}$/i.test(value);
  if (option.type === 'number') return Number.isFinite(Number(value)) && Number(value) >= 6 && Number(value) <= 100;
  if (option.type === 'select') return option.choices.includes(value);
  if (option.key === 'fontWeight') return /^(normal|bold|[1-9]00)$/.test(value);
  return typeof value === 'string' && value.length <= 200 && !/[;{}<>\r\n]/.test(value);
}
function defaultValue(option) {
  if (option.kind === 'semantic') {
    const [type, ...modifiers] = option.token.split('.');
    return semanticColor(type, [...modifiers, ...(option.definition ? ['definition'] : [])]);
  }
  if (option.kind === 'textmate') return option.rule.settings.foreground;
  if (option.kind === 'workbench') return theme.colors[option.key] || '#000080';
  if (option.kind === 'editor') return { fontFamily: "Consolas, 'Courier New', monospace", fontSize: 14, fontWeight: 'normal', showFoldingControls: 'always' }[option.key];
  if (option.kind === 'icon') return 'sourceinsight-reader-folding';
  return '';
}
function readValue(option, settings) {
  if (option.kind === 'semantic') {
    const [type, ...modifiers] = option.token.split('.');
    return semanticColor(type, [...modifiers, ...(option.definition ? ['definition'] : [])], '', scopedSettings(settings.semantic).map(layer => layer.rules || {}));
  }
  if (option.kind === 'textmate') {
    let color = option.rule.settings.foreground;
    const scopes = Array.isArray(option.rule.scope) ? option.rule.scope : [option.rule.scope];
    const groups = { Comment: 'comments', Strings: 'strings', Numbers: 'numbers', 'Type references': 'types', 'Function names': 'functions', 'Keywords and primitive types': 'keywords', 'Default text and identifiers': 'variables' };
    for (const layer of scopedSettings(settings.textmate)) {
      const group = layer[groups[option.rule.name]];
      color = (typeof group === 'string' ? group : group?.foreground) || color;
      for (const rule of layer.textMateRules || []) {
        const selected = Array.isArray(rule.scope) ? rule.scope : String(rule.scope || '').split(',').map(scope => scope.trim());
        if (selected.some(scope => scopes.includes(scope))) color = rule.settings?.foreground || color;
      }
    }
    return color;
  }
  if (option.kind === 'workbench') return Object.assign({}, theme.colors, ...scopedSettings(settings.colors))[option.key] || defaultValue(option);
  if (option.kind === 'editor') return settings.editor[option.key] ?? defaultValue(option);
  if (option.kind === 'icon') return settings.icon || 'Default';
  return settings.panes[option.pane]?.[option.key] ?? '';
}

// Modify only the controls changed in this menu; preserve unrelated native rules.
function applyChanges(settings, changes) {
  // VS Code exposes configuration objects through readonly proxies, which structuredClone cannot copy.
  const result = JSON.parse(JSON.stringify(settings));
  for (const [id, value] of Object.entries(changes)) {
    const option = options.find(option => option.id === id);
    if (!option || typeof value !== 'string' || !validValue(option, value)) throw new Error(`无效外观设置：${id}`);
    if (id === 'workbench.editor.foreground' || id === 'syntax.Default text and identifiers') {
      const colors = result.colors[`[${THEME_ID}]`] ||= {};
      const rules = (result.semantic[`[${THEME_ID}]`] ||= {}).rules ||= {};
      if (value) { colors['editor.foreground'] = value; rules['*'] = { ...(typeof rules['*'] === 'object' ? rules['*'] : {}), foreground: value }; }
      else {
        delete colors['editor.foreground'];
        if (rules['*'] && typeof rules['*'] === 'object') { delete rules['*'].foreground; if (!Object.keys(rules['*']).length) delete rules['*']; }
        else delete rules['*'];
      }
      const layer = result.textmate[`[${THEME_ID}]`] ||= {}, name = 'SourceInsight appearance: syntax.Default text and identifiers';
      layer.textMateRules = (layer.textMateRules || []).filter(rule => rule.name !== name);
      if (value) layer.textMateRules.push({ name, scope: theme.tokenColors[0].scope, settings: { foreground: value } });
      continue;
    }
    if (option.kind === 'pane') {
      const pane = result.panes[option.pane] ||= {};
      if (value === '') delete pane[option.key]; else pane[option.key] = option.type === 'number' ? Number(value) : value;
    } else if (option.kind === 'editor') {
      result.editor[option.key] = value === '' ? undefined : option.type === 'number' ? Number(value) : value;
    } else if (option.kind === 'icon') result.icon = value || undefined;
    else {
      const custom = result[option.kind === 'semantic' ? 'semantic' : option.kind === 'textmate' ? 'textmate' : 'colors'];
      const layer = custom[`[${THEME_ID}]`] ||= {};
      if (option.kind === 'semantic') {
        const rules = layer.rules ||= {};
        for (const selector of option.definition ? [option.token + '.definition', option.token + '.declaration'] : [option.token]) {
          if (value === '') {
            if (rules[selector] && typeof rules[selector] === 'object') { delete rules[selector].foreground; if (!Object.keys(rules[selector]).length) delete rules[selector]; }
            else delete rules[selector];
          }
          else rules[selector] = { ...(typeof rules[selector] === 'object' ? rules[selector] : {}), foreground: value };
        }
      } else if (option.kind === 'textmate') {
        const name = `SourceInsight appearance: ${option.id}`;
        layer.textMateRules = (layer.textMateRules || []).filter(rule => rule.name !== name);
        if (value) layer.textMateRules.push({ name, scope: option.rule.scope, settings: { foreground: value } });
      } else {
        for (const key of option.key === 'editor.background' ? [option.key, 'editorGutter.background', 'breadcrumb.background'] : [option.key]) {
          if (value === '') delete layer[key]; else layer[key] = value;
        }
      }
    }
  }
  return result;
}

function paneCss(panesConfig) {
  const selectors = { context: '#code', relation: '#relation-tree', symbols: 'body', files: 'body', search: 'body, table' };
  const properties = { fontFamily: 'font-family', fontSize: 'font-size', foreground: 'color', background: 'background-color' };
  return Object.fromEntries(Object.keys(panes).map(pane => [pane, Object.entries(panesConfig?.[pane] || {}).flatMap(([key, value]) => {
    const option = options.find(option => option.id === `${pane}.${key}`);
    if (!option || value === '' || !validValue(option, String(value))) return [];
    const selectorsForKey = pane === 'relation' && key === 'foreground' ? '#relation-tree, .relation-row, .relation-graph-node'
      : pane === 'relation' && key === 'fontFamily' ? '#relation-tree, .relation-graph-name' : selectors[pane];
    const extra = pane === 'relation' && key === 'background' ? ', .relation-graph-board, .relation-graph-header' : '';
    const contextColor = pane === 'context' && key === 'foreground' ? ` --reader-context-foreground: ${value};` : '';
    return [`${selectorsForKey}${extra} { ${properties[key]}: ${value}${key === 'fontSize' ? 'px' : ''} !important;${contextColor} }`];
  }).join('\n')]));
}
module.exports = { options, panes, defaultValue, readValue, applyChanges, paneCss };
