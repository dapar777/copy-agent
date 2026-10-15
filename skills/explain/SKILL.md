---
name: explain
description: Vysvětlí kód, modul nebo architekturu; nic nemění
---
Explain what is named after /explain (a file, function, module, flow or the whole project) to a
competent engineer who is new to this code. Read-only: do not edit files or run anything but harmless
read-only commands.

1. Use the attached codebase; otherwise read the relevant files in ONE turn (`<bundle>` for a module).
2. Answer in `<done>` in the user's language: purpose, how it works step by step (entry points, data flow,
   key types), how it is wired to the rest, notable design decisions and pitfalls, and where to look next.
   Reference locations as `path:line` so the user can click them. Keep it structured and concrete; no
   generic advice.

## Help
Použití: /explain <soubor, funkce, modul nebo téma>
Vysvětlí kód nebo architekturu pro nového inženýra: účel, tok dat, napojení, úskalí, kam se dívat dál. Nic nemění.
Příklady:
- /explain src/engine/TurnEngine.ts
- /explain jak funguje autentizace
