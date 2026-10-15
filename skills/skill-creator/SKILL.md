---
name: skill-creator
description: Vytvoří nebo upraví skill Copy Agenta (globálně v ~/.copy-agent/skills, s --local v projektu); každý skill dostane sekci Help pro /název --help
---
Create (or update) a Copy Agent skill from the request after /skill-creator. Skills of THIS tool live in
exactly two places and nowhere else: never under .codex/, .claude/, .cursor/, .github/, .vscode/ or any
other tool's directory, never as a loose file in the project root.

- GLOBAL (default): `~/.copy-agent/skills/<name>/SKILL.md` — available in every project.
- LOCAL (`--local` in the request): `.copy-agent/skills/<name>/SKILL.md` — this workspace only.

The tool resolves the path `~/.copy-agent/...` itself (it is the only path outside the workspace you
may write to), so write it literally: `<write path="~/.copy-agent/skills/<name>/SKILL.md">`.

## Procedure

1. Parse the request: skill name (lowercase, words joined by `-`, e.g. `release-notes`), what the skill
   should do, `--local`/`--global`, and any switches the user wants the skill to support. The
   "Available skills" list in the prompt shows which skills exist and where (global/project/built-in).
   To update an existing one, `<read>` its SKILL.md first (same path convention) and keep what works.
2. If the purpose is clear, write the skill in THIS reply (no questions). Ask with `<ask>` only when the
   goal is genuinely ambiguous. Do not run commands for this task.
3. Write `SKILL.md` in this shape (instructions for the model in English, Help for the user in the
   user's language, Czech by default):

   ```
   ---
   name: <name>
   description: <one line, what it does; shown in the skill list>
   ---
   <Concise, deterministic playbook for the model: numbered steps, what to read, what to change,
   how to verify, what to put in <done>. Switches the user may add after /<name> and what each
   changes. Favour ONE reply: read what is needed and do the work in the same block.>

   ## Help
   Použití: /<name> <argumenty> [--přepínač]
   <co skill udělá, v 1–3 větách>
   Přepínače:
   - --x: <co dělá>
   Příklady:
   - /<name> <příklad 1>
   - /<name> <příklad 2>
   ```

   The `## Help` section is mandatory: the tool shows it when the user types `/<name> --help`
   (no model turn needed), so keep it short, concrete and in the user's language.
4. Scripts (optional): when the skill needs a repeatable mechanical step, add it as a file in
   `<same folder>/scripts/<file>` (python/node/powershell), complete and runnable, with a usage comment at
   the top; the tool lists such scripts to the model automatically when the skill is used.
5. Finish with `<done>` saying where the skill was saved, how to invoke it (`/<name> …`,
   `/<name> --help`) and that the skill list in the panel reloads automatically.

## Help
Použití: /skill-creator <název> <k čemu skill je> [--local] [--přepínače, které má skill umět]
Vytvoří skill Copy Agenta: složku `<název>/SKILL.md` s playbookem pro model a sekcí Help. Výchozí
umístění je globální (`~/.copy-agent/skills`, platí ve všech projektech); `--local` ho uloží do
`.copy-agent/skills` jen pro tento projekt. Existující skill stejného jména upraví.
Přepínače:
- --local: skill jen pro tento projekt (jinak globální)
- --global: výslovně globální (výchozí)
Příklady:
- /skill-creator release-notes sepíše poznámky k vydání z git logu od posledního tagu, přepínač --since <tag>
- /skill-creator sql-review --local zkontroluje PL/SQL balíčky podle našich konvencí v docs/konvence.md
- /release-notes --help
