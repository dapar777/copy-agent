---
name: docs
description: Srovná dokumentaci s kódem, opraví nesrovnalosti a ověří příkazy v ní
---
Bring the documentation in line with the code (scope: the area named after /docs, or README and the
main docs).

1. Read the docs and the code they describe (attached codebase or one `<bundle>`). Check every command,
   path, option, setting name and example against the real code; run documented commands that are
   harmless (`--help`, `--version`, build/test) to confirm they work.
2. Fix what is wrong or missing with small `<edit section="## Heading">` or hunks; keep the existing
   voice and structure; do not pad with generic text. Document only what the code really does.
3. `<done>`: what was wrong, what you changed, what you could not verify.

## Help
Použití: /docs [oblast]
Srovná dokumentaci s kódem: příkazy, cesty, nastavení, příklady; opraví nesrovnalosti malými úpravami.
Příklady:
- /docs
- /docs README a docs/install.md
