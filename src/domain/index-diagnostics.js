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
    (kinds.unsupported ? `，${kinds.unsupported} 个 C++ 文件需语言服务` : '') +
    (kinds.budget ? `，${kinds.budget} 个文件超预算未收录` : '') +
    (summary.errors ? `，${summary.errors} 个文件解析不完整（已保留可识别符号）` : '') +
    (summary.limitedFiles ? `，${summary.limitedFiles} 个大文件仅收录顶层符号` : '') +
    (summary.warnings ? `，${summary.warnings} 个文件含编码提示` : '') +
    (summary.memoryLimited ? ` · 结果不完整：内存预算，${summary.deferredFiles} 个文件未收录；可调整 indexMemoryLimitMb 或屏蔽范围后重建` : '') +
    (summary.failures?.length || summary.errors || summary.warnings || summary.limitedFiles ? ' · 可运行“查看本地索引问题”定位' : '');
}
module.exports = { failureKind, failureCounts, indexStatus };
