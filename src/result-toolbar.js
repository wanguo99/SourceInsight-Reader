'use strict';

// Inline vector icons keep toolbar controls independent of platform icon fonts.
const icons = {
  refresh: '<path d="M13 6a5 5 0 1 0 0 4M13 2v4H9"/>',
  history: '<path d="M2 7a5.5 5.5 0 1 1 1 4M2 3v4h4M8 4v4l3 2"/>',
  previous: '<path d="m10 3-5 5 5 5"/>',
  next: '<path d="m6 3 5 5-5 5"/>',
  clear: '<path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M7 6v6M9 6v6"/>',
  search: '<circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/>',
  cancel: '<path d="m4 4 8 8M12 4l-8 8"/>'
};
function resultButton(id, label, shortcut = '') {
  return `<button id="${id}" class="result-tool" type="button" title="${label}${shortcut ? `（${shortcut}）` : ''}" aria-label="${label}"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[id]}</svg></button>`;
}
module.exports = { resultButton };
