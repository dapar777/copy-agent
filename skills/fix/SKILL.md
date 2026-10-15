---
name: fix
description: Najde příčinu chyby (z popisu, chybové hlášky nebo stack trace) a opraví ji s ověřením
---
Fix the problem described after /fix (an error message, stack trace, failing test or symptom).

1. Reproduce first: find the command or test that shows the failure and run it (`<run>`), or read the
   stack trace and open the files it names; use `<grep>` to find every place the failing symbol is used.
   With the codebase attached you can usually do this and the fix in ONE reply.
2. Explain the root cause to yourself in `<think>` before editing. Fix the cause, not the symptom; do not
   add try/except or null checks that merely hide the error. Keep the change minimal and local.
3. If the bug was not covered by a test, add a regression test that fails before and passes after.
4. Re-run the reproduction and the related test suite; finish with `<diagnostics/>`.
5. If the report is ambiguous or you cannot reproduce it, `<ask>` one precise question with options,
   in the same reply as your investigation, rather than guessing.
6. `<done>`: cause, change, evidence (command output), and anything the user should watch for.

## Help
Použití: /fix <popis chyby, chybová hláška nebo stack trace>
Reprodukuje chybu, najde příčinu, opraví ji minimální změnou, přidá regresní test a ověří.
Příklady:
- /fix TypeError: cannot read 'id' of undefined v storage.ts
- /fix test login_test padá po přihlášení
