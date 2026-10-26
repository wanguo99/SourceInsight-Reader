'use strict';
function failureKind(message) {
  return /C\+\+ 头文件/.test(message) ? 'unsupported' : /超过.*(?:MiB|资源预算)|内存预算/.test(message) ? 'budget'
    : /解码|编码|NUL/.test(message) ? 'encoding' : 'error';
}
function failureCounts(summary) {
  const kinds = { unsupported: 0, budget: 0, encoding: 0, error: 0 };
  for (const failure of summary.failures || []) kinds[Object.hasOwn(kinds, failure.kind) ? failure.kind : failureKind(failure.message)]++;
  return kinds;
}
function indexStatus(summary) {
  const kinds = failureCounts(summary);
  return `本地 C 索引：${summary.files} 个文件，${summary.functions} 个函数，${summary.calls} 处调用` +
    (kinds.error + kinds.encoding ? `，${kinds.error + kinds.encoding} 个文件处理失败` : '') +
    (summary.outlineFiles ? `，${summary.outlineFiles} 个 C++ 文件已收录大纲，绑定需语言服务` : '') +
    (kinds.unsupported ? `，${kinds.unsupported} 个 C++ 文件需语言服务` : '') +
    (kinds.budget ? `，${kinds.budget} 个文件超预算未收录` : '') +
    (summary.errors ? `，${summary.errors} 个文件解析不完整（已保留可识别符号）` : '') +
    (summary.limitedFiles ? `，${summary.limitedFiles} 个大文件仅收录顶层符号` : '') +
    (summary.warnings ? `，${summary.warnings} 个文件含编码提示` : '') +
    (summary.inheritedFiles ? ` · 已校验复用父/子目录缓存 ${summary.inheritedFiles} 个文件` : '') +
    (summary.database?.volatileProjects ? ' · 缓存目录不可写，当前工程使用临时内存索引' : '') +
    (summary.memoryLimited ? ` · 结果不完整：内存预算，${summary.deferredFiles} 个文件未收录；可调整 indexMemoryLimitMb 或屏蔽范围后重建` : '') +
    (summary.failures?.length || summary.errors || summary.warnings || summary.limitedFiles ? ' · 可运行“查看本地索引问题”定位' : '');
}
/**
 * @param {Iterable<any>} files
 * @param {Iterable<[string, string]>} failures
 * @param {Iterable<string>} budgetUris
 */
function collectIndexIssues(files, failures = [], budgetUris = [], limit = 5000) {
  const urgent = [], limited = [], warnings = [], recovered = [], outlines = [], seen = new Set();
  const add = (bucket, value) => { if (bucket.length < limit) bucket.push(value); };
  for (const [uri, message] of failures) { seen.add(uri); add(urgent, { uri, message, kind: failureKind(message) }); }
  for (const uri of budgetUris) if (!seen.has(uri)) add(urgent, { uri, kind: 'budget', message: '当前文件因内存预算未收录；可调整范围或预算后重建' });
  for (const file of files) {
    const symbols = () => file.symbolCount ?? file.symbols.length, functions = () => file.functionCount ?? file.functions.length;
    if (file.declarationsOnly) add(limited, { uri: file.uri, kind: 'limited', message: '大文件已收录顶层定义/声明；函数体、局部变量与调用关系需要语言服务补充', symbols: symbols(), functions: functions() });
    if (file.symbolListLimited || file.symbolCount > 5000) add(limited, { uri: file.uri, kind: 'limited', message: `全部符号已写入索引；当前文件列表显示前 ${file.symbolListLimited || 5000} 项，其余可用全局符号搜索或定义导航`, symbols: file.symbolCount, functions: functions() });
    for (const message of file.warnings || []) add(warnings, { uri: file.uri, kind: 'warning', message });
    if (file.hasErrors && recovered.length < limit) add(recovered, { uri: file.uri, kind: 'parseRecovery', range: file.parseIssues?.[0]?.range,
      message: '已收录可识别符号；宏、扩展语法或不完整声明需要语言服务复查', symbols: symbols(), functions: functions() });
    if (file.requiresSemantic && outlines.length < limit) add(outlines, { uri: file.uri, kind: 'outline', message: 'C++ 语法大纲已收录；类型绑定和调用关系由语言服务提供', symbols: symbols(), functions: 0 });
  }
  return [...urgent, ...limited, ...warnings, ...recovered, ...outlines].slice(0, limit);
}
module.exports = { failureKind, failureCounts, indexStatus, collectIndexIssues };
