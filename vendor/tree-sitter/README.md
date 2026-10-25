# Tree-sitter runtime and C/C++ grammars

Unmodified, compatible JavaScript/WASM assets from the official
`tree-sitter/tree-sitter.github.io` repository. Exact source tree, Git blob
hashes and SHA-256 digests are recorded in `manifest.json`.

The runtime and C/C++ grammars use the MIT license; notices are included in
`LICENSE.runtime` and `LICENSE.c` / `LICENSE.cpp`. No assets from third-party forks are shipped.

These resources run in a Node worker with an explicitly supplied WASM binary;
they do not fetch resources from the network or require a compiler on the
user's machine. The JS export uses the separate `Parser` and `Language` APIs.
