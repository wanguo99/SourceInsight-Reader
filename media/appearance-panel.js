'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id);
  let options = [], activeTab = 'features', directorySequence = 0;
  for (const [id, action] of [['manage-project', 'settingsProject'], ['manage-cache', 'settingsCache'], ['native-settings', 'settingsNative']]) get(id).addEventListener('click', () => api.postMessage({ action }));
  const directoryRequests = new Map();
  const dirty = new Map(), fields = new Map(), sections = [], queries = { features: '', appearance: '' };
  const setBusy = busy => { for (const input of document.querySelectorAll('input, textarea, select, button')) input.disabled = busy; };
  const status = () => { get('status').textContent = dirty.size ? `${dirty.size} 项待保存（包含两个标签页）` : (window.readerBridge?.t?.('没有待保存修改') || '没有待保存修改'); };
  const read = record => record.option.type === 'checkbox' ? String(record.input.checked) : record.input.value;
  const write = (record, value) => {
    if (record.option.type === 'checkbox') record.input.checked = value === 'true'; else record.input.value = value;
    if (record.slider) record.slider.value = value || record.option.default;
    if (record.color) record.color.value = /^#[\da-f]{6}$/i.test(value) ? value : '#000000';
  };
  const syncMemoryMode = () => {
    const mode = fields.get('feature.indexMemoryMode')?.input.value || 'fixed';
    for (const [id, enabled] of [['feature.indexMemoryLimitMb', mode === 'fixed'], ['feature.indexMemoryAvailablePercent', mode === 'availablePercent']]) {
      const field = fields.get(id); if (!field) continue;
      field.input.disabled = !enabled; if (field.slider) field.slider.disabled = !enabled;
    }
  };
  const update = record => {
    const value = read(record);
    if (value === record.option.value) dirty.delete(record.option.id); else dirty.set(record.option.id, value);
    if (record.color && /^#[\da-f]{6}$/i.test(value)) record.color.value = value;
    if (record.slider) record.slider.value = value || record.option.default;
    status(); syncMemoryMode();
    if (/^feature.index(?:CpuLimitPercent|MemoryMode|MemoryAvailablePercent|MemoryLimitMb)$/.test(record.option.id)) previewResources();
  };
  const previewResources = () => {
    const values = Object.fromEntries([...fields].filter(([id]) => /^feature.index(?:CpuLimitPercent|MemoryMode|MemoryAvailablePercent|MemoryLimitMb)$/.test(id)).map(([id, record]) => [id, read(record)]));
    api.postMessage({ action: 'settingsResourcePreview', query: JSON.stringify(values) });
  };
  const filter = () => {
    const query = queries[activeTab].trim().toLowerCase();
    for (const section of sections) {
      let count = 0;
      for (const record of section.records) {
        record.row.hidden = section.tab !== activeTab || !record.search.includes(query);
        if (!record.row.hidden) count++;
      }
      section.element.hidden = section.link.hidden = count === 0;
    }
  };
  const activate = (tab, notify = true) => {
    activeTab = tab === 'appearance' ? 'appearance' : 'features';
    for (const name of ['features', 'appearance']) {
      get(`tab-${name}`).setAttribute('aria-selected', String(name === activeTab));
      get(`tab-${name}`).tabIndex = name === activeTab ? 0 : -1;
    }
    get('settings-content').setAttribute('aria-labelledby', `tab-${activeTab}`);
    get('settings-description').textContent = activeTab === 'features'
      ? (window.readerBridge?.t?.('配置阅读、符号、调用关系、索引、屏蔽、布局与快捷键。列表规则每行一项，逗号保留在规则内。') || '配置阅读、符号、调用关系、索引、屏蔽、布局与快捷键。列表规则每行一项，逗号保留在规则内。')
      : (window.readerBridge?.t?.('配置颜色、字体、字号和窗口背景。宏名称默认红色；枚举成员定义蓝色、引用红色。语义颜色优先于语法颜色。') || '配置颜色、字体、字号和窗口背景。宏名称默认红色；枚举成员定义蓝色、引用红色。语义颜色优先于语法颜色。');
    get('filter').value = queries[activeTab]; filter();
    if (notify) api.postMessage({ action: 'settingsTab', mode: activeTab });
  };
  for (const tab of ['features', 'appearance']) {
    get(`tab-${tab}`).addEventListener('click', () => activate(tab));
    get(`tab-${tab}`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); activate(event.key === 'Home' ? 'features' : event.key === 'End' ? 'appearance' : tab === 'features' ? 'appearance' : 'features');
      get(`tab-${activeTab}`).focus();
    });
  }
  api.onMessage(({ data }) => {
    if (data.scope === 'settingsDirectory') {
      const pending = directoryRequests.get(data.id), record = fields.get(data.id);
      if (!pending || pending.snapshot !== data.snapshot) return;
      directoryRequests.delete(data.id);
      if (!record || record.input.value !== pending.value) return;
      if (data.error) { get('status').textContent = data.error; return; }
      if (data.cancelled || typeof data.folder !== 'string') return;
      write(record, data.folder); update(record);
      if (record.option.tab === activeTab && !record.row.hidden) record.input.focus();
      return;
    }
    if (data.scope === 'resourceBudget') { get('resource-budget').textContent = data.message; return; }
    if (data.scope === 'settingsPaths') {
      for (const [id, info] of Object.entries(data.paths || {})) {
        const record = fields.get(id); if (!record) continue;
        record.input.placeholder = info.placeholder; get(id + '.path').textContent = info.pathHint;
      }
      return;
    }
    if (data.scope === 'appearanceError') { get('status').textContent = data.status; setBusy(false); syncMemoryMode(); return; }
    if (data.scope === 'settingsTab') { activate(data.tab, false); return; }
    if (data.scope !== 'appearanceOptions') return;
    const drafts = data.preserveDraft ? new Map(dirty) : new Map(), focus = document.activeElement?.id;
    setBusy(false); options = data.options; dirty.clear(); fields.clear(); directoryRequests.clear(); sections.length = 0;
    const budget = get('resource-budget'); budget.hidden = true; get('settings-description').after?.(budget);
    get('options').replaceChildren(); get('groups').replaceChildren();
    get('status').textContent = data.status;
    if (!data.hasWorkspace) get('target').value = 'user';
    let group, section;
    for (const option of options) {
      const key = `${option.tab}:${option.group}`;
      if (group !== key) {
        group = key;
        const element = document.createElement('section'); element.id = `group-${sections.length}`;
        const heading = document.createElement('h2'); heading.textContent = option.group; element.append(heading); get('options').append(element);
        const link = document.createElement('a'); link.href = '#' + element.id; link.textContent = option.group.replace(/（.*）/, ''); get('groups').append(link);
        section = { element, link, tab: option.tab, records: [] }; sections.push(section);
      }
      if (option.id === 'feature.indexCpuLimitPercent') { const budget = get('resource-budget'); budget.hidden = false; section.element.append(budget); }
      const row = document.createElement('div'); row.className = 'setting';
      const label = document.createElement('label'), title = document.createElement('span'); title.textContent = option.label; label.append(title);
      const input = document.createElement(option.type === 'select' ? 'select' : option.type === 'textarea' ? 'textarea' : 'input'); input.id = option.id;
      if (option.type === 'select') {
        for (const choice of new Set(['', ...option.choices, option.value])) {
          const item = document.createElement('option'), index = option.choices.indexOf(choice);
          item.value = choice; item.textContent = choice ? option.choiceLabels?.[index] || choice : (window.readerBridge?.t?.('跟随默认设置') || '跟随默认设置'); input.append(item);
        }
      } else if (option.type === 'textarea') {
        input.rows = 3; input.placeholder = (window.readerBridge?.t?.('每行一项；清空表示空列表') || '每行一项；清空表示空列表');
      } else {
        input.type = option.type === 'color' ? 'text' : option.type; input.placeholder = option.placeholder || (window.readerBridge?.t?.('留空跟随默认') || '留空跟随默认');
        if (option.type === 'number') { input.min = String(option.minimum ?? 6); input.max = String(option.maximum ?? 100); input.step = String(option.step ?? 'any'); }
      }
      const record = { option, input, row, search: `${option.group} ${option.label} ${option.id} ${option.description || ''}`.toLowerCase(), color: undefined };
      fields.set(option.id, record); section.records.push(record); label.append(input);
      if (option.slider) {
        const slider = document.createElement('input'); slider.type = 'range'; slider.id = option.id + '.slider';
        slider.min = input.min; slider.max = input.max; slider.step = '1';
        slider.setAttribute('aria-label', option.label); record.slider = slider;
        slider.addEventListener('input', () => { input.value = slider.value; update(record); }); label.append(slider);
      }
      if (option.type === 'color') {
        const color = document.createElement('input'); color.type = 'color'; color.setAttribute('aria-label', option.label + (window.readerBridge?.t?.('颜色选择器') || '颜色选择器')); record.color = color;
        color.addEventListener('input', () => { input.value = color.value; update(record); }); label.append(color);
      }
      if (option.id === 'feature.cacheDirectory') {
        const browse = document.createElement('button'); browse.id = option.id + '.browse'; browse.type = 'button';
        browse.textContent = window.readerBridge?.t?.('选择文件夹…') || '选择文件夹…';
        browse.setAttribute('aria-label', browse.textContent + ' ' + option.label);
        browse.addEventListener('click', () => {
          const snapshot = ++directorySequence, value = input.value;
          directoryRequests.set(option.id, { snapshot, value });
          api.postMessage({ action: 'settingsChooseDirectory', id: option.id, folder: value, snapshot });
        });
        label.append(browse);
      }
      write(record, drafts.has(option.id) ? drafts.get(option.id) : option.value);
      if (drafts.has(option.id) && drafts.get(option.id) !== option.value) dirty.set(option.id, drafts.get(option.id));
      input.addEventListener('input', () => update(record)); input.addEventListener('change', () => update(record));
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = (window.readerBridge?.t?.('默认') || '默认');
      reset.addEventListener('click', () => { write(record, option.default); update(record); }); label.append(reset); row.append(label);
      if (option.origin) { const origin = document.createElement('p'); origin.className = 'setting-description'; origin.textContent = (window.readerBridge?.t?.('当前生效来源：') || '当前生效来源：') + option.origin; row.append(origin); }
      if (option.description) { const description = document.createElement('p'); description.className = 'setting-description'; description.textContent = option.description; row.append(description); }
      if (option.pathHint) {
        const hint = document.createElement('p'); hint.id = option.id + '.path'; hint.className = 'setting-path'; hint.textContent = option.pathHint;
        row.append(hint);
      }
      section.element.append(row);
    }
    activate(data.tab || activeTab, false); syncMemoryMode();
    if (data.preserveDraft && focus) get(focus)?.focus();
    if (fields.has('feature.indexMemoryMode')) previewResources();
  });
  const save = action => {
    const query = JSON.stringify(Object.fromEntries(dirty));
    if (query.length > 32768) { get('status').textContent = (window.readerBridge?.t?.('修改内容过长，请减少列表内容后保存') || '修改内容过长，请减少列表内容后保存'); return; }
    setBusy(true); get('status').textContent = (window.readerBridge?.t?.('正在保存…') || '正在保存…');
    api.postMessage({ action, mode: get('target').value, query });
  };
  get('save').addEventListener('click', () => save('settingsSave'));
  get('save-reload').addEventListener('click', () => save('settingsSaveReload'));
  get('defaults').addEventListener('click', () => {
    for (const option of options.filter(option => option.tab === activeTab)) { const record = fields.get(option.id); write(record, option.default); update(record); }
    get('status').textContent = `已填入当前页默认值，${dirty.size} 项待保存`;
  });
  get('reload').addEventListener('click', () => api.postMessage({ action: 'ready' }));
  get('filter').addEventListener('input', () => { queries[activeTab] = get('filter').value; filter(); });
  api.postMessage({ action: 'ready' });
})();
