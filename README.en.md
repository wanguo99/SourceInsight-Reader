# SourceInsight-Reader

[中文](README.md) · [Commands](docs/COMMAND-REFERENCE.md) · [Capabilities](docs/SUPPORT-MATRIX.md)

A Source Insight style code reader for VS Code: preview definitions beside the current reading position, explore callers and call sites, find references and save reading tasks. Basic C indexing works offline. Full C++, Java and Python semantics require a compatible language extension.

This is an optimized **1.1.0 local release build**. Engineering phases and local automated results are recorded in the delivery report. Cross-platform, real Java/Pylance, accessibility and long-running acceptance remain separate gates.

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

Use Node 22. Run `npm ci`, `npm run check`, `npm run test:unit`, `npm run package` and `npm run verify:package`. Real VS Code validation uses `npm run test:host -- --headless --vsix=dist/wanguo-sourceinsight-reader-1.1.0.vsix`; Linux requires Xvfb. Packaging emits a SHA-256 sidecar, package validation report and vendored-asset CycloneDX inventory.

The [acceptance document](docs/ACCEPTANCE-TESTS.md) contains 154 cases covering existing and new features; copy the [results template](docs/ACCEPTANCE-RESULTS-TEMPLATE.csv) before recording results. See [quality gates](docs/QUALITY-GATES.md), [data/privacy](PRIVACY.md), [support](SUPPORT.md) and the [delivery report](docs/FINAL-DELIVERY.md). User-facing reference material is primarily Chinese; core commands, settings and controls have English resources.

Version 1.0.10 recovers C declarations in C/C++ compatibility headers, GNU attributes and conditional parameter/initializer lists. Invalid UTF-8 exclusively in comments can retain editor positions with a warning. C files from 8 to 16MiB use an explicit top-level-only mode; larger files remain outside the resource budget. Use **Show Local Index Issues** to inspect incomplete parsing, encoding notes, skipped files and backend requirements. General build conditions and macros still require a language service; see [OAI index validation](docs/INDEX-COVERAGE-FIX.md).

The Source Insight theme provides bounded, single-file C syntax colors in both the editor and Context when semantic tokens are missing. Existing semantic tokens take precedence; explicit semantic-highlighting opt-out is respected. This works with project indexing disabled, with a 2MiB source limit and a separate 128MiB JS heap Worker. It does not expand macros or replace compiler semantics. See [C color validation](docs/C-COLOR-FIX.md).


The current development build uses per-folder SQLite indexes under extension global storage (`indexes/<URI hash>/index.sqlite`). Set `sourceInsightReader.indexCacheDirectory` to an absolute cache root if needed. In remote sessions this is a path on the extension host. Existing indexes restore metadata and persisted call graphs before incremental file checks. Function/dependency maps and bounded hot caches stay in memory; dirty facts and dirty graphs are never written to disk. C++ now has an offline syntax outline, with compiler binding supplied by the language service. Local facts and semantic observations share one snapshot publishing API and retain separate provenance. Only hash/configuration-matched document symbols are replayed as fallback; cross-file semantic observations require live queries. See [design and validation](docs/UNIFIED-INDEX-DESIGN.md) and acceptance cases DB-01–DB-20.


Version 1.1.0 adds grammar-independent preprocessor indexing, macro parameter/continuation navigation, explicit cast/designated-initializer field resolution and bounded header-includer contexts. See the [OAI release audit](docs/OAI-RELEASE-AUDIT-1.1.0.md). External SDK definitions still require the appropriate SDK sources or a correctly configured language service.


Each workspace folder is an independent project. Local binding and this extension’s language-service results do not borrow another opened project’s SDK, definitions or call edges. SDK directories within the current project remain supported; explicitly configured system headers are handled by the language service.


Opening a parent or child folder can reuse syntax facts for the same files from related projects in the same cache directory. Every inherited file is checked against its current content hash before writing the new project database; bindings and call graphs are recomputed. Semantic snapshots and old call graphs are never inherited. Changed/new files are parsed, deleted/excluded files are omitted, and forced rebuild bypasses inheritance.


Local syntax indexing uses bounded parallel parsing. indexCpuLimitPercent defaults to and is capped at 25%, including the coordinator. With 12 available CPUs and the default memory allowance, at most two parser workers and one coordinator run. indexMemoryLimitMb is shared, default 1024MiB and further reduced by available memory. Small workspaces (fewer than 32 files) and constrained systems use serial parsing; pressure releases the pool and falls back to serial work. Native parsing/GC can cause short bursts; these are cooperative budgets, not OS hard quotas. clangd has its own resource settings.
