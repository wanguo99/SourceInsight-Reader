# SourceInsight-Reader


Under the Source Insight theme, the editor and Context share C identifier roles. Confirmed bindings use indexed types; function-pointer member calls use function colors and EXPORT_SYMBOL arguments use reference colors. Unbound identifiers, including unconfirmed Relation candidates, use the default foreground (black in this theme). C-compatible headers receive these corrections even when VS Code labels them C++; actual C++ headers remain handled by the language service. Colors refresh after index updates.
[中文](README.md) · [Configuration](docs/CONFIGURATION.md) · [Commands](docs/COMMAND-REFERENCE.md) · [Support](SUPPORT.md)

A Source Insight style code reader for VS Code. Browse project files and symbols, preview definitions, follow calls and save your reading progress without losing your place in the editor. Use it for C, embedded and kernel projects, or pair it with language extensions for C++, Java and Python.

**Current version: 1.1.7. Requires VS Code 1.106.0 or later.** Basic C reading uses an offline index without compiling the project or installing clangd. Full compiler semantics come from the appropriate language extension.

## Features

| Feature | What it provides |
| --- | --- |
| Project files | Browse a directory tree, find files by name or path, import selected directories or files, and exclude unrelated content. |
| File and project symbols | Browse functions, variables, macros, enums, types and members; filter file symbols and search project symbols. |
| Context preview | Preview definitions, declarations and enclosing functions with locking, history, find, full-function reading and side-editor navigation. |
| Relation view | Explore callers, callees and individual call sites in a horizontal graph or outline. |
| References and text search | Lookup References for symbols; Lookup Text for literal, regex or multiline searches, with filtering, pagination, history and saved queries. |
| Reading progress | Save bookmarks, notes and reading tasks, then resume when you reopen the workspace. |
| Local indexing | Explicit source selection, incremental updates, persistent caches, parent/child cache reuse and parallel parsing within CPU and memory budgets. |
| Appearance | A Source Insight theme, fallback C syntax colors, fonts and colors, and optional keyboard and layout presets. |

## Installation

Obtain `wanguo-sourceinsight-reader-1.1.7.vsix`. In the VS Code Extensions view, select **… → Install from VSIX…**, choose the file and reload when prompted.

Alternatively, run this in the package directory:

```sh
code --install-extension ./wanguo-sourceinsight-reader-1.1.7.vsix
```

For a rebuilt package with the same version, append `--force` to replace the installed copy, then reload the window. Identify same-version rebuilds by the accompanying SHA-256 checksum.

In Remote SSH, WSL or Dev Container windows, install the extension on the workspace extension host. Source files, compilation databases, language services and custom cache paths must be accessible in that environment. There is no browser entry point for `vscode.dev`. See the [support matrix](docs/SUPPORT-MATRIX.md) for environment and validation boundaries.

## First run

1. Open a source folder or workspace in VS Code.
2. Run **SourceInsight-Reader: Open Reading Workbench** from the Command Palette.
3. On first use, open **Manage Project Files** from the project-file context menu or Command Palette, choose an indexing mode and scope, and save the configuration.
4. Click **Start indexing** in Context to use that saved configuration. Once indexed, the same button becomes **Refresh index** to rescan without opening the configuration page. The manager can also save and start indexing.
5. Follow the indexing status. Open a source file and move the cursor to a function or symbol to preview its definition in Context and explore calls in Relation.

Some project-manager controls currently use Chinese labels, included above so you can identify them.

Refresh index reuses the saved mode, imported scope, compilation database and path mappings, rereads the database, and reuses valid cached facts. Unsaved manager drafts are ignored. The index button is disabled while indexing and becomes available for retry after failure. Use Manage Project Files to change the configuration.

**Opening a folder does not automatically start the project index.** Switching files, querying a definition or saving the configuration does not start it either. Source selection is saved in workspace settings; reopening a workspace or changing its mode or scope requires an explicit start. Normal source edits and saves update incrementally after startup, reusing valid caches.

### Choose an indexing mode

| Mode | When to use it | What to select |
| --- | --- | --- |
| `compile_commands.json` | You have a compilation database and want to restrict indexing to build inputs | Choose the database; the index includes listed source files and resolvable in-project header dependencies. |
| Imported files — 已导入文件 | You are reading a module or have no database | Check directories or files in the left pane; uncheck entries in the right pane to remove them. Shift supports range selection and removal. |
| Entire project — 整个工程 | The workspace is small or you need its full supported scope | Index supported files in the workspace, still respecting exclusions. |

Keep adding any directories or individual files as before. Within an imported directory, uncheck or restore individual children; parents show partial selection. The right pane lists imports and exclusions, with unchecked exclusions available to restore. You can also restore a specific file inside an excluded subtree. Saving preserves these choices without changing other imports or deleting source files. Independent exclusion settings still take priority. Import and exclusion management are also available from the project-file view's context menu.

Local indexing and the extension's definitions, types, declarations, references, workspace symbols, Relation and semantic cache results all obey the saved project selection. Language-service results in `/usr/include`, host SDKs or other unimported paths are filtered as well. SDK source must belong to the current project and be included explicitly; another workspace root is not an implicit SDK. Clangd still parses dependencies according to the compilation configuration, and this extension does not override other extensions' native navigation.

### Compilation databases and path mapping

Database mode **never executes compiler commands** and does not silently fall back to a full workspace scan. It reads `arguments` / `command`, relative `directory/file`, `-I` / `-iquote` / `-isystem` / `-idirafter`, forced includes and resolvable literal includes. Databases over 64 MiB require a module-sized database.

For Buildroot or out-of-tree kernel builds, select **添加构建目录 → 源码目录映射** in the project manager. Choose the build directory recorded in the database, then its corresponding source directory inside the current workspace, and start indexing. For example:

```text
Recorded build directory: /work/buildroot/output/build/linux-custom
Current source directory: /work/linux/linux-7.0
```

Multiple mappings use longest-prefix matching. Paths are resolved against each command's `directory` before mapping source paths, include paths and forced includes. The extension reads current source files without rewriting the original database or clangd configuration. Ordinary `make O=...` records already pointing to original sources need no mapping.

Generated files existing only in an external build directory are reported as missing rather than imported. Macro-expanded includes, response files, compiler built-in header paths and full conditional compilation still require a language service. Assembly is outside the local C index scope.

## Reading workflow

- **Find files and symbols:** use the project-file search box, Find Project File or Find Workspace Symbol. File symbols support filtering and sorting.
- **Read definitions:** preview them in Context. Lock Context to retain a target, or pin the preview in a side editor for comparison.
- **Follow calls:** set a function as the Relation root, choose callers or callees, and navigate to a specific call site. Context and Relation locks are independent.
- **Search references or text:** symbol references and literal text searches are separate operations. View results in Search Results; refresh stale results after source or scope changes before navigating.
- **Save progress:** use Add Bookmark and Note, Save Reading Task or Save Current Search, then restore from their corresponding commands.

Indexing or resource limits can leave partial results. Check result sources, index status and Show Local Index Issues before treating an empty result as proof that a definition, call or reference does not exist.

## Language support

| Language | Built-in support and setup |
| --- | --- |
| C | Offline indexing works immediately after an explicit start. Configure clangd and `compile_commands.json` when results must reflect build flags, macro expansion and conditional compilation. |
| C++ | Offline syntax outlines and macro navigation; full definitions, references and calls require clangd and project build configuration. Semantic outgoing calls require clangd 20+. |
| Java | Use the Red Hat Java extension in standard mode with a correctly loaded project. |
| Python | Use Python / Pylance and select the project interpreter. Dynamic-call coverage depends on the language service. |

Both `navigationBackend` and `relationBackend` default to `auto`: prefer available language services for ordinary queries, then try supported local C fallbacks. Non-function symbol uses, structure-member references and callback implementation callers prefer local type-bound results to include static callback assignment candidates. Choose `local` or `languageService` separately to inspect their results. Selecting a language-service Relation backend does not disable the local index.

The local index does not fully preprocess source, precisely evaluate conditional compilation or infer runtime function-pointer targets. Project symbols are isolated by workspace root rather than borrowing another project's SDK. See the [support matrix](docs/SUPPORT-MATRIX.md) for details.

### Structure members and function pointers

Place the cursor on a member such as `adap->algo->master_xfer(...)` in Relation. The left side lists indexed callers of that typed member slot; the right side lists functions assigned by initializers or assignments. Site previews open the assignment; double-click a function node to open its definition. Unrelated same-name fields stay separate.

Direct pointer members, typedef callbacks, pointer arrays and direct callback aliases within an anonymous union are supported. Kernel `master_xfer` / `xfer` aliases can link to `.xfer = omap_i2c_xfer_irq`. Ordinary fields expose their containing user functions and type-bound read, write and initializer references. Callback implementations also expose registration members and potential callers of those members. Empty semantic call lists are checked against the local index.

Include the declarations, callers and implementations in the selected scope. For `i2cdev_read`, include `drivers/i2c/i2c-dev.c`, `include/linux/fs.h`, `include/linux/i2c.h` and `fs/read_write.c` to see potential VFS callers, then click Refresh Index. Assignments are static candidates, not confirmed runtime dispatch. Macro-generated targets, pointer copies, runtime object binding and conditional branches require language-service or manual inspection. Start or refresh indexing to rebuild old-format local caches.

### Macro, structure-variable and enum uses

Place the cursor on the definition or use of a macro, local/global variable, struct/enum type, enumerator or typedef. Relation lists declaration-bound uses, grouped by containing function, initializer, macro or exact file location. It excludes the selected definition and separates shadowed names. Non-function symbols have no function-call callees. Function-like macros are supported without inferring runtime calls by expanding them.

Missing generated `asm/...` headers can leave kernel include chains incomplete. If the current project has exactly one definition of a macro, Relation can show otherwise unbound same-name occurrences as candidate uses, with an incomplete-chain diagnostic, from either the definition or use. Existing bindings, fields, local shadows, duplicate macro definitions, explicit undef and occurrences without dependency evidence are excluded. Ordinary definition navigation and References still require confirmed binding.

The horizontal graph places reference lines after the name, such as `reader_usage :42,57 +2`. Click a line to preview its exact site, or `+N` to choose more sites. Double-click the name to open the definition. Full names, paths and candidate details remain available on hover. Each node occupies one row and scales with the font size.

These local use relations support C and C headers. Only macros are bound locally for C++; other C++ symbols require a language service. Include definitions and users before starting or refreshing the index. Conditional branches are not evaluated, and query-budget limits are reported as incomplete results.

## Keyboard and layout

The default preserves your layout and leaves Source Insight navigation keys disabled. Run **Choose Keyboard Preset** or **Apply Source Insight Layout** to opt in. Select **SourceInsight-Reader Source Insight** through VS Code's Color Theme picker; the extension does not switch themes automatically.

| Key | Action | Condition |
| --- | --- | --- |
| F8 | Toggle same-name text highlighting | Main editor and Context; overrides VS Code's Next Problem in the main editor |
| Ctrl+Alt+H / macOS Cmd+Alt+H | Toggle same-name text highlighting | Alternate shortcut in the main editor |
| F2 | Toggle same-name text highlighting | Only with `symbolHighlightUseF2`; otherwise remains available for Rename |
| Alt+= | Go to definition | `sourceInsightKeys` enabled, editor focused |
| Alt+, / Alt+. | Previous / next reading position | `sourceInsightKeys` enabled |
| Shift+F12 | Lookup References | `sourceInsightKeys` enabled, editor focused |
| Alt+Shift+S / Alt+Shift+P | Find workspace symbol / project file | `sourceInsightKeys` enabled, editor focused |
| Alt+F8 / Alt+Shift+F8 | Next / previous query result | `sourceInsightKeys` enabled, editor focused, reference or text results available |

With `sourceInsightKeys` enabled, F8 / Shift+F8 navigate results inside Search Results. Same-name highlighting does not establish semantic identity. Resolve conflicts in VS Code's Keyboard Shortcuts editor using command IDs from the [command reference](docs/COMMAND-REFERENCE.md).

## Large projects, budgets and caches

Select the modules you need before expanding scope. **Exclusions take precedence over imports.** File browsing, local indexing and text search have separate glob settings; changing the visible file list does not change every query's scope.

Use the extension's indexing and exclusion settings to adjust resources:

- CPU: 5–100%, default 25%.
- Memory: a fixed limit of 1024 MiB by default, or 5–90% of available memory measured when the worker starts.
- Sliders, numeric inputs and a resource preview are available. Budgets do not reserve memory up front and are not operating-system hard quotas. Language extensions have separate resource usage.

Example settings; see the [configuration reference](docs/CONFIGURATION.md) for all keys and defaults:

```json
{
  "sourceInsightReader.indexCpuLimitPercent": 25,
  "sourceInsightReader.indexMemoryMode": "fixed",
  "sourceInsightReader.indexMemoryLimitMb": 1024
}
```

`sourceInsightReader.cacheDirectory` defaults to extension global storage and accepts absolute paths, `~` and `${userHome}`. Projects use separate name-and-path-hash directories, each containing `indexes` and `logs`. Remote windows use the remote extension host's filesystem.

The settings page shows resolved paths. Changing the cache root does not move or delete old files. Use **Manage Local Cache** to inspect sizes and delete idle caches; caches in use are protected. Windows for the same project coordinate index writes and reuse committed data, while unsaved text remains isolated in each window.

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| No index after opening a project | Click Start Indexing; Save Configuration only saves scope. Check that `indexEnabled` is enabled. |
| Only a few files are indexed | Check mode, selected directories, exclusions, database paths and mappings; inspect skipped-file reasons in index issues and logs. |
| Incomplete definitions, references or calls | Check result source, language-service readiness, unsaved changes and local C limitations; semantic C++ outgoing calls require clangd 20+. |
| Path mapping changes have no effect | Start indexing again. These mappings do not configure clangd. |
| Memory pressure or stopped indexing | Reduce scope or adjust the budget, then use Start / Update Index (Choose Mode). A genuine OOM does not cause endless automatic restarts. |
| Remote files or caches are inaccessible | Check installation side, remote permissions and resolved paths rather than using paths from another machine. |
| Unexpected colors or shortcuts | Check the active theme, explicit user / workspace settings and keyboard presets. F8 highlighting and result-list navigation have different scopes. |

Run **Diagnose Workspace Capabilities** to inspect the backend and project. Use **Export Redacted Diagnostics** for reports and follow the [support instructions](SUPPORT.md). The extension itself does not upload source or send telemetry; local reading records, caches and logs may contain private information. See [Privacy](PRIVACY.md).

## Further reading

[Configuration](docs/CONFIGURATION.md) · [Commands](docs/COMMAND-REFERENCE.md) · [Support matrix](docs/SUPPORT-MATRIX.md) · [Acceptance cases](docs/ACCEPTANCE-TESTS.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
