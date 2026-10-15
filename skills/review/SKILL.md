---
name: review
description: Code review necommitnutých změn nebo zadaných souborů; nic nemění
---
Review the uncommitted changes (or the files named after /review) and report findings. Do NOT edit
anything; this task only reads and runs read-only commands.

1. Run the bundled script `python <script path>/collect-diff.py` (see "Scripts shipped with this skill"
   below) in ONE `<run>`: it prints the diff, per-file statistics and warnings about secrets or debug
   leftovers. Add `<read>` for the full content of changed files when the diff alone is not enough.
2. Judge: correctness (edge cases, error handling, concurrency), security (injection, secrets, unsafe
   deserialization), performance (N+1, needless work in loops), maintainability (naming, duplication,
   dead code), tests (missing or weakened), and consistency with the surrounding code and `AGENTS.md`.
3. Report in `<done>` as a list ordered by severity, each item with `path:line`, what is wrong, why it
   matters and a concrete fix. Say explicitly when you found nothing serious. Keep it concise.

## Help
Použití: /review [soubory]
Code review necommitnutých změn (nebo zadaných souborů): správnost, bezpečnost, výkon, testy. Nic nemění; nálezy seřazené podle závažnosti s cesta:řádek.
Příklady:
- /review
- /review src/auth.ts src/session.ts
