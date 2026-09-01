---
name: nushell
description: Use when writing or running Nushell commands, scripts, or pipelines - via Bash (nu -c) or in .nu script files. Also use when working with structured data (JSON, YAML, TOML, CSV, Parquet, SQLite), doing ad-hoc data analysis or exploration, or when the user's shell is Nushell.
---

# Using Nushell

Nushell is a structured-data shell. Commands pass **tables, records, and lists** through pipelines - not text.

## pi-plan-mode Tool Contract

When plan mode is enabled, use the custom `nushell` tool with direct Nushell source. Do not write `nu -c`; the tool runs Nushell internally.

### Brainstorming

Brainstorming permits only simple, top-level, read-only pipelines.

```nu
open package.json | get scripts
ls | where type == file | select name
^kubectl get pods -o json | from json | get items
```

Do not use closures, lists, records, parenthesized command expressions, interpolation, aliases, definitions, imports, overlays, redirects, nested execution, or file and infrastructure mutations.

Each nushell tool call runs in a separate process. Do not rely on `cd` from an earlier call; use explicit paths instead.

Use these Nushell-native patterns instead of blocked Unix commands:

```nu
open README.md | lines | first 20
open src/index.ts | lines | where $it =~ "registerTool"
glob **/*.ts
open package.json | get scripts
```

### Implementing

Implementation permits unrestricted direct Nushell source within the approved proposal.

**Execution path:**

- **Standard Pi sessions**: Use the Bash tool with `nu -c '<code>'` for one-shot execution.
- **pi-plan-mode**: Use the `nushell` tool with direct Nushell source.

## Critical Rules

**String interpolation uses parentheses, NOT curly braces:**

```nu
# WRONG:  $"hello {$name}"
# CORRECT: $"hello ($name)"
$"($env.HOME)/docs"    $"2 + 2 = (2 + 2)"    $"files: (ls | length)"
```

Gotcha: `$"(some text)"` errors - parens are evaluated as code. Escape literal parens: `\(text\)`.

**No bash syntax:** `cmd1; cmd2` not `&&`, `o+e>|` not `2>&1`, `$env.VAR` not `$VAR`, `(cmd)` not `$(cmd)`.

## Common Mistakes

| Mistake                             | Fix                                                                  |
| ----------------------------------- | -------------------------------------------------------------------- |
| `$"hello {$name}"`                  | `$"hello ($name)"`                                                   |
| `command 2>&1`                      | `command o+e>\| ...`                                                 |
| `$HOME/path`                        | `$env.HOME` or `$"($env.HOME)/path"`                                 |
| `export FOO=bar`                    | `$env.FOO = "bar"`                                                   |
| Mutating in closure                 | Use `reduce`, `generate`, or `each`                                  |
| `\u001b` for ANSI                   | `ansi strip` to remove, `char --unicode '1b'` for ESC                |
| `where ($in.a > 1) and ($in.b > 2)` | Second `$in` rebinds to bool. Use bare cols: `where a > 1 and b > 2` |
| `where not ($in.col \| cmd)`        | `not` breaks `$in`. Use `where ($in.col \| cmd) == false`            |
| `where col \| cmd` (no parens)      | Parsed as two pipeline stages. Use `where ($in.col \| cmd)`          |

## When to Use Nushell

**Always prefer Nushell for:**

- Any structured data (JSON, YAML, TOML, CSV, Parquet, SQLite) - unifies all formats
- CLI tools with `--json` flags - pipe JSON output directly into Nushell for querying (e.g. `^gh pr list --json title,state | from json`)
- Ad-hoc data analysis and exploration - faster than Python setup
- Initial data science/analytics - histograms, tabular output, basic aggregations
- Polars plugin for large datasets - DataFrames without Python overhead

**Use Bash only when:** bash-specific tooling or Bash-specific integrations are required.

## Reference Files

Read the relevant file(s) based on what you need:

| File                                                  | Read when you need...                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| [commands.md](references/commands.md)                 | Command reference tables (filters, strings, conversions, filesystem, math, dates) |
| [types-and-syntax.md](references/types-and-syntax.md) | Type system, string types, operators, variables, control flow, cell-paths         |
| [data-analysis.md](references/data-analysis.md)       | Format conversion, HTTP, Polars, SQLite, aggregation patterns                     |
| [advanced.md](references/advanced.md)                 | Custom commands, modules, error handling, jobs, external commands, env config     |
| [bash-equivalents.md](references/bash-equivalents.md) | Complete Bash-to-Nushell translation table                                        |

## Output Notes

- Use `| to text` or `| to json` for large outputs.
- Use `ansi strip` to remove terminal colors.
