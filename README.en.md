# SourceInsight-Reader

[中文](README.md) · [Commands](docs/COMMAND-REFERENCE.md) · [Capabilities](docs/SUPPORT-MATRIX.md)

A Source Insight style code reader for VS Code: preview definitions beside the current reading position, explore callers and call sites, find references and save reading tasks. Basic C indexing works offline. Full C++, Java and Python semantics require a compatible language extension.

This is an optimized **1.0.10 local release build**. Engineering phases and local automated results are recorded in the delivery report. Cross-platform, real Java/Pylance, accessibility and long-running acceptance remain separate gates.

## Start

Install the VSIX in VS Code 1.106+, open a source workspace and run **SourceInsight-Reader: Getting Started** and **Diagnose Workspace Capabilities**. Open the Reading Workbench. Configure clangd and compilation commands for C++, Red Hat Java in standard mode for Java, or Python/Pylance and an interpreter for Python.

Existing keys, layout, icon theme and shared `.clangd` are preserved by default. Keyboard presets and managed clangd changes are explicit choices; configuration changes have a diff preview and an original backup.

## Read and resume

- Project files: lazy directory expansion, filename/path filtering, multiple roots, exclusions and continuation.
- Symbols: file/global search, all symbols or functions, sorting and current-function following.
- Context: definition/type/enclosing-function modes, explicit candidate selection, internal navigation/history, lock, find, full function and side-editor pinning.
- Relation: callers/callees, graph or outline, all call sites, recursion guards, continuation and semantic verification. Implementation and type hierarchy depend on provider support; includes use confirmed local C dependencies.
- References: semantic providers or unique local C bindings, snippets, filters, pagination and history. Same-name text highlighting is a separate literal feature.
- Text: literal/regex/multiline search, dirty buffers, cancellation, scopes and saved queries.
- Reading state: bookmarks, notes and tasks stored per workspace. Changed anchors relocate only when unique; ambiguous/deleted anchors are rejected. Data can be cleared by category.
- Diagnostics: explicit redacted export, index/query counters and compiler-configuration presence. No source upload or extension-owned telemetry.

The C index does not expand macros, evaluate preprocessor conditions, infer indirect targets or implement a C++ compiler/type system. Results identify their source and completeness. Full functions are shown in chunks of up to 2000 lines. The C Worker heap ceiling defaults to 1024MiB (indexMemoryLimitMb). Memory pressure produces an explicit partial index; OOM does not trigger automatic restart loops. Text search has explicit file, byte, match and compute budgets; narrow the scope when incomplete. Pinning opens the current file, not an immutable snapshot.

## Verify

Use Node 22. Run `npm ci`, `npm run check`, `npm run test:unit`, `npm run package` and `npm run verify:package`. Real VS Code validation uses `npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.0.10.vsix`; Linux requires Xvfb. Packaging emits a SHA-256 sidecar, package validation report and vendored-asset CycloneDX inventory.

The [acceptance document](docs/ACCEPTANCE-TESTS.md) contains 152 cases covering existing and new features; copy the [results template](docs/ACCEPTANCE-RESULTS-TEMPLATE.csv) before recording results. See [quality gates](docs/QUALITY-GATES.md), [data/privacy](PRIVACY.md), [support](SUPPORT.md) and the [delivery report](docs/FINAL-DELIVERY.md). User-facing reference material is primarily Chinese; core commands, settings and controls have English resources.

Version 1.0.10 recovers C declarations in C/C++ compatibility headers, GNU attributes and conditional parameter/initializer lists. Invalid UTF-8 exclusively in comments can retain editor positions with a warning. C files from 8 to 16MiB use an explicit top-level-only mode; larger files remain outside the resource budget. Use **Show Local Index Issues** to inspect incomplete parsing, encoding notes, skipped files and backend requirements. General build conditions and macros still require a language service; see [OAI index validation](docs/INDEX-COVERAGE-FIX.md).

The Source Insight theme provides bounded, single-file C syntax colors in both the editor and Context when semantic tokens are missing. Existing semantic tokens take precedence; explicit semantic-highlighting opt-out is respected. This works with project indexing disabled, with a 2MiB source limit and a separate 128MiB JS heap Worker. It does not expand macros or replace compiler semantics. See [C color validation](docs/C-COLOR-FIX.md).
