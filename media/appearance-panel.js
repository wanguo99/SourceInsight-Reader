'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id);
  let options = [], activeTab = 'features';
  const dirty = new Map(), fields = new Map(), sections = [], queries = { features: '', appearance: '' };
  const setBusy = busy => { for (const input of document.querySelectorAll('input, textarea, select, button')) input.disabled = busy; };
  const status = () => { get('status').textContent = dirty.size ? `${dirty.size} 项待保存（包含两个标签页）` : '没有待保存修改'; };
  const read = record => record.option.type === 'checkbox' ? String(record.input.checked) : record.input.value;
  const write = (record, value) => {
    if (record.option.type === 'checkbox') record.input.checked = value === 'true'; else record.input.value = value;
    if (record.color) record.color.value = /^#[\da-f]{6}$/i.test(value) ? value : '#000000';
  };
  const update = record => {
    const value = read(record);
    if (value === record.option.value) dirty.delete(record.option.id); else dirty.set(record.option.id, value);
    if (record.color && /^#[\da-f]{6}$/i.test(value)) record.color.value = value;
    status();
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
      ? '配置阅读、符号、调用关系、索引、屏蔽、布局与快捷键。列表规则每行一项，逗号保留在规则内。'
      : '配置颜色、字体、字号和窗口背景。宏与枚举成员默认定义蓝色、引用红色；语义颜色优先于语法颜色。';
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
    if (data.scope === 'appearanceError') { get('status').textContent = data.status; setBusy(false); return; }
    if (data.scope === 'settingsTab') { activate(data.tab, false); return; }
    if (data.scope !== 'appearanceOptions') return;
    setBusy(false); options = data.options; dirty.clear(); fields.clear(); sections.length = 0;
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
      const row = document.createElement('div'); row.className = 'setting';
      const label = document.createElement('label'), title = document.createElement('span'); title.textContent = option.label; label.append(title);
      const input = document.createElement(option.type === 'select' ? 'select' : option.type === 'textarea' ? 'textarea' : 'input'); input.id = option.id;
      if (option.type === 'select') {
        for (const choice of new Set(['', ...option.choices, option.value])) {
          const item = document.createElement('option'), index = option.choices.indexOf(choice);
          item.value = choice; item.textContent = choice ? option.choiceLabels?.[index] || choice : '跟随默认设置'; input.append(item);
        }
      } else if (option.type === 'textarea') {
        input.rows = 3; input.placeholder = '每行一项；清空表示空列表';
      } else {
        input.type = option.type === 'color' ? 'text' : option.type; input.placeholder = '留空跟随默认';
        if (option.type === 'number') { input.min = String(option.minimum ?? 6); input.max = String(option.maximum ?? 100); input.step = String(option.step ?? 'any'); }
      }
      const record = { option, input, row, search: `${option.group} ${option.label} ${option.id} ${option.description || ''}`.toLowerCase(), color: undefined };
      fields.set(option.id, record); section.records.push(record); label.append(input);
      if (option.type === 'color') {
        const color = document.createElement('input'); color.type = 'color'; color.setAttribute('aria-label', option.label + '颜色选择器'); record.color = color;
        color.addEventListener('input', () => { input.value = color.value; update(record); }); label.append(color);
      }
      write(record, option.value);
      input.addEventListener('input', () => update(record)); input.addEventListener('change', () => update(record));
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '默认';
      reset.addEventListener('click', () => { write(record, option.default); update(record); }); label.append(reset); row.append(label);
      if (option.description) { const description = document.createElement('p'); description.className = 'setting-description'; description.textContent = option.description; row.append(description); }
      section.element.append(row);
    }
    activate(data.tab || activeTab, false);
  });
  const save = action => {
    const query = JSON.stringify(Object.fromEntries(dirty));
    if (query.length > 32768) { get('status').textContent = '修改内容过长，请减少列表内容后保存'; return; }
    setBusy(true); get('status').textContent = '正在保存…';
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
