# SourceInsight-Reader

[中文](README.md)

A Source Insight style code reader for VS Code. Browse project files and symbols, preview definitions, explore call relationships and save your reading progress without losing your place in the editor.

## Features

| Feature | What it provides |
| --- | --- |
| Project browsing | Browse workspace folders, find files by name or path, and exclude files and directories in batches. |
| Symbol navigation | Browse functions, variables, macros, enums and types, follow the current function, and search project symbols. |
| Definition preview | Read definitions and declarations in Context, with locking, history, find and side-editor navigation. |
| Call relationships | Explore callers and callees in the Relation graph or outline, then navigate to individual call sites. |
| References and search | Find symbol references with source snippets; search literal text, regular expressions and multiline patterns, and save queries. |
| Reading progress | Save bookmarks, notes and reading tasks, then resume when you reopen the workspace. |
| Local indexing | Offline C indexing and C++ syntax outlines, persistent caches, incremental updates, parent/child cache reuse, and parallel parsing with CPU and memory budgets. View cache sizes and delete idle caches individually or in batches; caches in use are protected. |
| Reading appearance | A Source Insight theme, fallback C syntax colors, configurable fonts and colors, and optional keyboard presets. |

Basic C reading works without compiling or installing a language service. The local index does not fully expand macros or evaluate conditional compilation. Full compiler semantics come from the appropriate language extension. Each workspace folder has an independent index.

## Installation and use

Requires **VS Code 1.106.0 or later**.

1. Obtain `wanguo-sourceinsight-reader-1.1.1.vsix`.
2. Open the Extensions view in VS Code, select **… → Install from VSIX…**, and choose the file.
3. Open a source folder and run **SourceInsight-Reader: Open Reading Workbench** from the Command Palette.
4. Open a source file and select a symbol to preview its definition in Context and explore calls in Relation.

You can also install from the command line:

```sh
code --install-extension ./wanguo-sourceinsight-reader-1.1.1.vsix
```

Configure language support for your project:

| Language | Setup |
| --- | --- |
| C | Use the built-in index immediately. Configure clangd and `compile_commands.json` when results need to reflect build flags and conditional compilation. |
| C++ | Syntax outlines and macro navigation work offline. Full definitions, references and calls require clangd and `compile_commands.json`; semantic outgoing calls require clangd 20+. |
| Java | Install the Red Hat Java extension, use standard mode and load the project. |
| Python | Install the Python and Pylance extensions and select the project interpreter. |

Run **SourceInsight-Reader: Getting Started** for guidance, **Diagnose Workspace Capabilities** for missing results, or **SourceInsight-Reader: Settings** to adjust features and appearance.

[Configuration](docs/CONFIGURATION.md) · [Supported capabilities](docs/SUPPORT-MATRIX.md) · [Test cases](docs/ACCEPTANCE-TESTS.md) · [Support](SUPPORT.md)
