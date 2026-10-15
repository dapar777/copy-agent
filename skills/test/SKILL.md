---
name: test
description: Spustí testy, opraví příčiny selhání (ne testy) a doplní chybějící testy
---
Make the test suite pass and strengthen it where it is thin. Scope: the area named after /test, or the
whole project.

1. Find the test command in `AGENTS.md`, `package.json`/`pyproject.toml`/CI; run it in the SAME reply as
   your first look (`<run timeout="600">`). Use focused runs (one file or pattern) while iterating.
2. For each failure read the assertion and the code it exercises; fix the cause in the code, never weaken
   or delete a test to make it pass (if a test is genuinely wrong, say so in `<done>` and ask with `<ask>`).
3. Add tests for untested branches you touched (edge cases, error paths). Follow the existing test style.
4. Finish with the full suite green and `<diagnostics/>`; `<done>` lists what failed, why, what changed.

## Help
Použití: /test [oblast]
Spustí testy, opraví příčiny selhání v kódu (ne testy) a doplní chybějící testy pro dotčené větve.
Příklady:
- /test
- /test modul plateb
