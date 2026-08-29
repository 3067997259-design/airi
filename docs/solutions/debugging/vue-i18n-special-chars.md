---
module: i18n
tags: [vue-i18n, yaml, linked-message, blank-page]
problem_type: root-cause-analysis
---

# Unescaped `@` in a locale message blanks the whole page

Found 2026-08-29 when the long-term memory page first became reachable.

## Symptom

The page rendered only the route heading; the entire component tree below
was blank. Console showed a vue-i18n tokenizer error:

```
{code: 10, domain: "tokenizer", stack: "SyntaxError: 10 at createCompileError (vue-i18n.runtime...)"}
```

## Root cause

A new key carried a connection-string example:

```yaml
connection-placeholder: postgresql://user:password@127.0.0.1:5435/postgres
```

In vue-i18n message syntax `@` starts a **linked message** (`@:key`,
`@.modifier:key`). The tokenizer hit `@127.0.0.1` and threw at compile
time; because `t()` ran during render, the whole subtree failed.

The page had never been opened before (unreachable route), so the broken
key survived from the day it was added — a reminder that "pages nobody can
navigate to have never been rendered once".

## Fix

Escape the literal with vue-i18n's literal interpolation:

```yaml
connection-placeholder: postgresql://user:password{'@'}127.0.0.1:5435/postgres
```

A repo-wide sweep of en/zh-Hans settings/stage/base found no other
unescaped `@`.

## Prevention

When adding locale strings that embed URLs, emails, or `@`/`|`/`{`
literally, either use the `{'@'}` literal syntax or avoid the characters.
`{count}`-style real interpolations are fine. After adding keys, open the
page once (or run the agent-browser walkthrough) — a blank page with only
a heading means check the console for `domain: "tokenizer"`.
