'use strict';
// The renderer owns acquireVsCodeApi; communicate through its existing message channel.
for (const [id, mode] of [['lookupTextTab', 'text'], ['lookupReferencesTab', 'references']]) {
  document.getElementById(id).addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('switchResults', { detail: mode }));
  });
}
