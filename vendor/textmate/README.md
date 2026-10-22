# Context syntax colors

Unmodified MIT-licensed runtime assets from Microsoft's `vscode-textmate` 9.3.2
and `vscode-oniguruma` 2.0.1. The extension uses these engines with installed
language extensions' grammar contributions to reproduce the editor's TextMate
colors in Context. Tokenization runs in a Worker and requires no installation,
compiler, or network access on the user's machine.

`manifest.json` records npm source URLs, package entries, sizes and SHA-256
digests. `npm run check` verifies the assets. Licenses and Oniguruma notices are
included beside the runtimes. Grammar files are read from installed extensions
and are not redistributed here.
