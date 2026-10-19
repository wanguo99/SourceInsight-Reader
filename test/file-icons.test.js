'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('file icon themes reuse installed font/image resources, language associations and light overrides', async () => {
  const env = fakeVscode();
  const { loadFileIcons, parseTheme, glyph } = loadWithVscode('../src/file-icons', env.api);
  assert.deepEqual(parseTheme('{"url":"https://a/*b*/",/*comment*/"x":[1,],}'), { url: 'https://a/*b*/', x: [1] });
  assert.equal(glyph('\\E001'), '\ue001');
  env.api.window.activeColorTheme = { kind: 1 };
  env.settings.set('workbench.iconTheme', 'test-icons');
  env.api.extensions = { all: [{ extensionUri: env.api.Uri.file('/icons'), packageJSON: {
    contributes: { iconThemes: [{ id: 'test-icons', path: 'theme/theme.json' }] }
  } }] };
  env.api.workspace.fs.readFile = async () => Buffer.from(JSON.stringify({
    fonts: [{ id: 'icon', size: '150%', src: [{ path: 'files.woff', format: 'woff' }] }],
    iconDefinitions: { c: { fontCharacter: '\\E001', fontColor: '#aabbcc' }, lightc: { fontCharacter: '\\E002', fontColor: '#445566' },
      image: { iconPath: 'folder.svg' } }, languageIds: { c: 'c' }, folderNames: { src: 'image' },
    light: { languageIds: { c: 'lightc' } }
  }));
  const icons = await loadFileIcons({ asWebviewUri: uri => uri });
  const icon = icons.iconFor('main.c', 'file', false);
  assert.equal(icon.glyph, '\ue002'); assert.equal(icon.color, '#445566');
  assert.match(icons.css, /files\.woff/); assert.match(icons.css, /@font-face/);
  assert.equal(icons.iconFor('src', 'directory', true).uri, 'file:///icons/theme/folder.svg');
  assert.equal(icons.root.toString(), 'file:///icons');
  env.settings.set('workbench.iconTheme', null); assert.equal(await loadFileIcons({}), undefined);
});
