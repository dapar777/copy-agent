# Copy Agent – návrh

Copy Agent je kódovací agent pro VS Code, který s modelem komunikuje přes schránku. Vychází
z whisper-agentu, ale je navržený znovu kolem jednoho cíle: **Copilot v Teams s vlastním agentem**
a **co nejméně interakcí uživatele** na úkol.

## 1. Co se oproti whisper-agentu změnilo a proč

| Oblast | whisper-agent | Copy Agent |
|---|---|---|
| Protokol pro model | celá preambule v každém prvním promptu | protokol je v **instrukcích agenta** v Copilotu (generované ze zdrojů, ≤ 8 000 znaků); první prompt nese jen kontext a zadání (`copyAgent.target = copilot-agent`); obecný chat dál dostane celou preambuli (`generic`) |
| Blok odpovědi | bez ohrazení (claude.ai) | **vždy v ohrazení čtyř zpětných apostrofů**: Teams nic neskryje, tlačítko *Kopírovat* dá přesný text, vnitřní ``` nic nerozbijí; parser zvládne i ohrazení rozbité renderováním |
| Kontext | model si soubory vyžádá (bundle na vyžádání, volitelně full bundle) | **celá codebase jako jeden .txt k prvnímu promptu** (výchozí, do limitu velikosti), jinak **automatický výběr souborů** podle zadání (cesty, identifikátory, aktivní soubor, osnovy a okolí shod) |
| Limity chatu | jeden limit promptu, dlouhé výsledky se odloží | **dělení promptu na části** `[PART i/n]` (model na části odpoví „OK“), **vícedílné odpovědi** `part="i/n"`, **useknutá odpověď** = hotové akce proběhnou, model dostane přesný seznam, co poslat znovu |
| Doručení do chatu | text, historie schránky, soubory, drag & drop přes pywin32 | **kroky doručení**: části textu, pak přílohy jako soubory ve schránce (Windows); po vložení textu se další krok zkopíruje sám; žádný Python |
| Kola | 2–5 kol na úkol, revize před dokončením vždy | pravidlo „**co nejméně odpovědí, ideálně jedna**“ (edity + testy + done v jedné odpovědi, otázky jen když je model blokovaný), revize před dokončením vypnutá (`off`/`auto`/`always`) |
| Provádění akcí | sekvenčně | čtecí akce (read, grep, ls, glob, bundle, diagnostics) **souběžně**, grep v dávkách, seznam souborů v cache |
| Schránka | text přes vlastníka s odloženým vykreslením (PowerShell) | text **hned** přes VS Code API, vlastník (detekce vložení) běží vedle a nezdržuje; po návratu fokusu do VS Code se schránka přečte ihned |
| Panel | plné překreslení proudu | přírůstkové vykreslení, kroky doručení s ukazatelem, tlačítko *Další krok*, přepínač cíle chatu |
| Instrukce projektu | `WHISPER.md` | `AGENTS.md` (standard napříč nástroji), fallback `COPY-AGENT.md`; stav v `.copy-agent/`, globálně `~/.copy-agent/` |
| Nástroje | read, ls, glob, grep, bundle, write, edit, delete, run, screenshot, diagnostics, ask, status, dialog, plan, suggest, done | totéž + `move`; `read` vrací osnovu včetně metod tříd |

Převzaté a ověřené části (s úpravami): SEARCH/REPLACE hunky s tolerancemi, sekce markdownu, řádkový
diff a review změn s CodeLens, kódování souborů, kontrola zapsaných souborů, hooky, skilly, návrhy,
transkript, git checkpoint, záchrany dokumentu z chatu, headless harness.

## 2. Pracovní tok s Copilotem v Teams

```
VS Code (panel)                    schránka                     Copilot v Teams (agent Copy Agent)
──────────────                     ────────                     ──────────────────────────────────
zadání ──► prompt (kontext+úkol) ─► text ──────────────────────► Ctrl+V (části: „OK“ … LAST)
           codebase.txt ──────────► soubor (po vložení textu) ──► Ctrl+V = příloha, Enter
                                                               ◄─ odpověď: ````<copy turn="1">…</copy>````
akce (edit, run, diagnostics) ◄── schránka ◄──────────────────── klik „Kopírovat“ u bloku
výsledky ──► další prompt ────────► text ──────────────────────► Ctrl+V … dokud nepřijde <done>
```

Ideální průběh je **jedna odpověď**: model má celou codebase, udělá úpravy, spustí testy a pošle
`<done>` v jednom bloku. Rozšíření pak jen zobrazí výsledky a změny ke schválení.

## 3. Protokol

- Model odpovídá jedním blokem `<copy turn="N" session="S">…</copy>` v ohrazení ```` (čtyři zpětné
  apostrofy). Atribut `part="i/n"` dělí dlouhou odpověď; každá část je úplný blok, akce pokračují.
- Rozšíření odpovídá blokem `<copy-results turn="N-1" session="S">` s `<result of=… status=…>` pro každou
  akci, `<diagnostics>`, `<note>` (co agent opravil nebo udělal sám), `<user>` (poznámky a odpovědi
  uživatele), `<protocol-error>` a připomínkou formátu v jazyce uživatele.
- Tabulka nástrojů (`src/protocol/schema.ts`) je jediný zdroj pravdy: generuje popis v instrukcích
  agenta i v preambuli, validaci v parseru a dispatch v runneru.
- Parser (`src/protocol/parser.ts`) hledá blok strukturně (těla akcí přeskakuje, kandidáty uvnitř
  jiných zahazuje, preferuje blok s očekávaným kolem), odstraňuje ohrazení, dekóduje escapované
  značky, CDATA a entity, dorovnává zaměněné uzavírací tagy, a useknutou akci nikdy nevykoná.

## 4. Doručení promptu (kroky)

`Controller.buildSteps` rozdělí prompt na kroky: části textu podle `prompt.maxChars` a nakonec krok
s přílohami (soubory). Každý krok je jedno `Ctrl+V`. Na Windows vlastník schránky pozná vložení textu
(WM_RENDERFORMAT) a další krok se zkopíruje sám; jinde a při selhání je tlačítko *Další krok*
(`Ctrl+Alt+N`). `prompt.asFile` dá text promptu jako `copy-prompt-N.txt` mezi soubory (jediné Ctrl+V;
agent v Copilotu má v instrukcích, že prompt může přijít jako příloha).

Odpověď se převezme ze schránky, jakmile obsahuje `<copy turn=…>` a `</copy>`; po vložení promptu
i useknutý blok nebo dokument napsaný do chatu. Po návratu fokusu do VS Code se schránka přečte hned.

## 5. Kontext

1. `attachInitialBundle`: celá codebase (textové soubory podle `.gitignore`, bez binárních) jako
   jeden kompaktní `.txt` do `.copy-agent/out/`, pokud je do `context.fullMaxChars` (nebo `always`).
2. Jinak `collectAutoContext`: cesty ze zadání, názvy souborů shodné s identifikátory, obsahové shody
   identifikátorů (CamelCase, snake_case, delší slova), aktivní soubor; malé soubory celé, velké jako
   osnova + okna kolem shod; rozpočet `context.autoMaxChars`.
3. Vždy: strom projektu (kompaktní, adresáře s počty), `AGENTS.md`, pravidla, plán, diagnostika,
   `#odkazy`, aktivní soubor a výběr.

## 6. Bezpečnost a vratnost

Stejně jako whisper: allowlist/denylist a schvalování příkazů v panelu, chráněné cesty, git checkpoint
před každým kolem a Undo, změny ke schválení po hunkách, výstupy příkazů čištěné od tajemství,
kontrola zapsaných souborů (zbytky protokolu, syntaxe).

Agent nevytváří pomocné soubory mimo `.copy-agent/` ve workspace (ani v systémovém Temp: dočasný text
pro detekci vložení žije v `.copy-agent/tmp`). Při startu úkolu `safety/VcsIgnore.ts` doplní `.copy-agent/`
a `AGENTS.md` do `.gitignore` a do `svn:ignore` každé složky pod správou verzí.

## 7. Architektura

```
src/
├── extension.ts            aktivace, příkazy, stavový řádek
├── protocol/               čistá vrstva (testovaná): schema, parser, prompt, edit, section, diff, refs, slash, detect, roots, text
├── tools/                  nástroje nad Hostem: fs, grep, run, bundle, check, context (auto-kontext), refs, runner (souběžné čtení)
├── engine/                 TurnEngine (smyčka kola bez UI), Controller (VS Code orchestrace), Session, SessionData, Transcript
├── host/                   Host rozhraní, NodeHost (CLI/testy), VsCodeHost, spawn, screenshot
├── clipboard/              ClipboardBridge, ClipboardOwner (detekce vložení), FileReplyWatcher
├── review/                 ReviewManager (baseline, hunky, CodeLens, dekorace)
├── safety/                 Policy, Approvals, Checkpoint
├── skills/                 Skills (+ skripty), Hooks, GlobalConfig (~/.copy-agent)
├── ui/                     SidebarView (webview)
└── cli/                    harness (headless), gen-instructions (instrukce pro Copilot agenta)
```

Žádné runtime závislosti; jen VS Code API a Node. Balení přes esbuild, testy vitest (`test/`).

## 8. Známá omezení

- Velké přílohy čte Copilot po částech; model to ví a chybějící soubory si vyžádá. Limit přílohy
  (`context.fullMaxChars`) je nastavený konzervativně a stojí za vyladění podle tenantu.
- Soubory do schránky a detekce vložení jsou jen na Windows; jinde se příloha přikládá ručně
  z `.copy-agent/out/` a další krok se spouští tlačítkem.
- Screenshoty jen na Windows.
