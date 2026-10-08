---
name: init
description: Prozkoumá projekt a založí/aktualizuje AGENTS.md (příkazy, struktura, konvence, úskalí)
---
Create or update the project instructions file `AGENTS.md` in the workspace root so that any future
session starts with the essential facts. Work like a new senior engineer joining the project.

READ-ONLY TASK: init maps the project, it never sets it up. Do NOT run anything that installs, builds,
downloads or changes the environment (no `npm install`, `pip install`, builds, migrations, test runs).
The only commands allowed are harmless read-only checks that end immediately (`node --version`,
`git log --oneline -5`), and only when the answer is not already in the files.

1. The complete codebase is usually attached to the first message; if not, gather what you need in ONE
   turn with a single `<bundle>` for the config files (`package.json, pyproject.toml, requirements*.txt,
   Cargo.toml, go.mod, Makefile, *.csproj, .github/workflows/*, tsconfig*.json, README*`) plus `<ls depth="2"/>`.
2. Derive, do not guess: the exact commands to install, build, run, lint and test (copy them from
   scripts/CI, note the working directory), runtime versions, the top-level layout (what lives where,
   entry points), naming and style conventions visible in the code, and pitfalls (Windows vs. Unix
   shell, env variables, generated files not to edit, slow or flaky steps).
3. Write `AGENTS.md` (Czech if the existing docs are Czech, otherwise English) as short bullet lists
   under headings: Projekt / Příkazy / Struktura / Konvence / Pozor. Keep it under ~60 lines; it is
   injected into every prompt. If it already exists, keep the user's lines and only add or correct facts.
4. Say where each command comes from (`package.json scripts.test`, `.github/workflows/ci.yml`…) so a
   later task can trust or fix it; do not verify commands by running them.
5. Finish with `<done>` in the same reply listing what you wrote and what you could not determine.
