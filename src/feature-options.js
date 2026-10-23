'use strict';
// Use the contributed settings schema as the source of defaults and validation.
const { properties } = require('../package.json').contributes.configuration;
const groups = {
  '阅读与预览': { autoPreview: '自动预览定义', contextMode: 'Context 跟随模式', contextLines: '预览上下文行数', debounceMs: '查询防抖（毫秒）', navigationBackend: '定义查询后端', queryTimeoutMs: '查询等待上限（毫秒）' },
  '文件与符号': { 'files.include': '工程文件包含规则', 'files.exclude': '工程文件排除规则', symbolKinds: '符号显示类型', symbolSort: '符号排序', workspaceSymbolTimeoutMs: '全局符号等待（毫秒）' },
  '调用关系': { autoRelation: '自动跟随当前函数', relationBackend: '分析后端', relationView: '显示方式', relationTimeoutMs: '语言服务等待（毫秒）', relationLocalTimeoutMs: '本地查询等待（毫秒）', relationRetryDelayMs: '超时重试间隔（毫秒）' },
  '索引与屏蔽': { indexEnabled: '启用本地 C 索引', indexExclude: '索引排除规则', excludedDirectories: '屏蔽目录', excludedFiles: '屏蔽文件', autoConfigureClangd: '自动维护 clangd 屏蔽规则' },
  '布局': { layout: '阅读布局', explorerSide: '主侧栏位置' },
  '检索与快捷键': { textLookupExclude: '字符检索排除规则', sourceInsightKeys: '启用 Source Insight 快捷键', symbolHighlightUseF2: '使用 F2 固定符号高亮' }
};
const labels = { definition: '定义或声明', type: '类型定义', enclosing: '包含函数', all: '全部符号', functions: '仅函数', position: '源码位置', name: '名称',
  auto: '自动', local: '本地索引', languageService: '语言服务', horizontalGraph: '横向关系图', outline: '树形列表',
  sourceInsight: 'Source Insight 布局', preserve: '保留当前设置', left: '左侧', right: '右侧' };
const featureOptions = [];
for (const [group, entries] of Object.entries(groups)) for (const [key, label] of Object.entries(entries)) {
  const schema = properties[`sourceInsightReader.${key}`];
  if (!schema) throw new Error(`Missing feature setting schema: ${key}`);
  featureOptions.push({ id: `feature.${key}`, key, label, group, schema,
    type: schema.enum ? 'select' : schema.type === 'boolean' ? 'checkbox' : schema.type === 'array' ? 'textarea' : ['number', 'integer'].includes(schema.type) ? 'number' : 'text' });
}
function formatFeatureValue(option, value) {
  return option.type === 'textarea' ? (value || []).join('\n') : String(value ?? '');
}
function describeFeature(option, value) {
  return { id: option.id, label: option.label, group: option.group, tab: 'features', type: option.type,
    description: option.schema.description, minimum: option.schema.minimum, maximum: option.schema.maximum,
    step: option.schema.type === 'integer' ? 1 : 'any', choices: option.schema.enum,
    choiceLabels: option.schema.enum?.map((value, index) => option.schema.enumDescriptions?.[index] || labels[value] || value),
    value: formatFeatureValue(option, value), default: formatFeatureValue(option, option.schema.default) };
}
function parseFeatureChanges(changes) {
  const result = new Map();
  for (const [id, raw] of Object.entries(changes)) {
    const option = featureOptions.find(option => option.id === id);
    if (!option || typeof raw !== 'string') throw new Error(`无效功能设置：${id}`);
    const { schema } = option;
    let value;
    if (schema.enum) {
      if (raw && !schema.enum.includes(raw)) throw new Error(`${option.label}：请选择有效选项`);
      value = raw || undefined;
    } else if (schema.type === 'boolean') {
      if (!['true', 'false'].includes(raw)) throw new Error(`${option.label}：必须为开启或关闭`);
      value = raw === 'true';
    } else if (['number', 'integer'].includes(schema.type)) {
      if (raw.trim() === '') value = undefined;
      else {
        value = Number(raw);
        if (!Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < schema.minimum || value > schema.maximum) {
          throw new Error(`${option.label}：请输入 ${schema.minimum}–${schema.maximum}${schema.type === 'integer' ? ' 的整数' : ' 范围内的数字'}`);
        }
      }
    } else if (schema.type === 'array') value = raw.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    else value = raw;
    result.set(option.key, value);
  }
  return result;
}
module.exports = { featureOptions, describeFeature, parseFeatureChanges };
