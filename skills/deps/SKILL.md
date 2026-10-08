---
name: deps
description: Zastaralé a zranitelné závislosti; bezpečná aktualizace s testy
---
Review the project's dependencies and update them safely.

1. Run the bundled script `python <script path>/check-deps.py` (see "Scripts shipped with this skill")
   in ONE `<run timeout="600">`: it finds every manifest (package.json, requirements*.txt, pyproject.toml,
   Cargo.toml, go.mod) and lists outdated packages split into safe (patch/minor) and major, plus audit
   output where the tool is available.
2. Apply the safe updates with the project's tool (`npm update`, `pip install -U`, `cargo update`…) and
   run the test suite in the same reply. Do not apply major updates without `<ask>`ing; list them with
   their changelog risks instead.
3. `<done>`: what was updated, test result, vulnerabilities found and what remains (majors, manual steps).
