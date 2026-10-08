# Instrukce pro agenty v tomto projektu

- Jazyk: TypeScript, VS Code extension. Bundluje se přes `npm run build` (esbuild) do `dist/`
  (extension.js, harness.js, gen-instructions.js).
- Typová kontrola: `npx tsc --noEmit`. Unit testy: `npx vitest run` (jen čistá vrstva bez `vscode`:
  `src/protocol`, `src/tools`, `src/engine/TurnEngine.ts`, `src/host/NodeHost.ts`).
- Kód, který sahá na `vscode` API, nelze testovat Vitestem; logiku drž v `src/protocol`, `src/tools`
  a `src/engine/TurnEngine.ts` bez importu `vscode`.
- Komentáře a UI texty česky, texty pro model (prompt.ts, skills/) anglicky.
- Neměň `package.json` `contributes` bez doplnění odpovídajícího `registerCommand` v `src/extension.ts`.
- Instrukce pro agenta v Copilotu se generují: po změně `src/protocol/prompt.ts` nebo `schema.ts`
  spusť `npm run build && node dist/gen-instructions.js --write` (limit 8 000 znaků, hlídá test).
