# Copy Agent

Kódovací agent pro VS Code, který pracuje jako Claude Code, ale s modelem komunikuje **přes schránku**.
Nepotřebuje API klíč: prompt zkopíruje do schránky, vy ho vložíte do chatu, zkopírujete odpověď
a agent ji sám převezme a vykoná. Cílová platforma je **Copilot v Teams** (Microsoft 365 Copilot)
s vlastním agentem, jehož instrukce jsou v [copilot-agent/](copilot-agent/NAVOD.md); funguje ale
s jakýmkoli chatem (claude.ai, ChatGPT, Gemini, lokální UI).

Hlavní cíl návrhu je **co nejméně interakcí uživatele**: k prvnímu promptu se přiloží celá codebase
jako jeden textový soubor, model má pokyn udělat celou práci hned v první odpovědi a každé kolo se
drží v limitech chatu automaticky (dělení promptu na části, vícedílné odpovědi, useknuté odpovědi).

Copy Agent vychází z [whisper-agentu](https://github.com/dapar777/whisper-agent) (stejný autor), ale je
postavený znovu kolem Copilota v Teams; co se liší, je v [DESIGN.md](DESIGN.md).

## Instalace

1. Stáhněte `copy-agent-0.1.0.vsix` a `install.bat` do jedné složky (nebo naklonujte repo).
2. Poklepejte na `install.bat`. Skript najde VS Code (potřeba 1.106 nebo novější kvůli panelu v pravém postranním panelu), nainstaluje balíček a ověří, že je vidět.
3. Restartujte VS Code (nebo `Developer: Reload Window`).

Ručně: `code --install-extension copy-agent-0.1.0.vsix --force`, nebo Extensions › „…“ › *Install from VSIX…*.

Potom si založte agenta v Copilotu podle [copilot-agent/NAVOD.md](copilot-agent/NAVOD.md): instrukce
pro něj dostanete do schránky příkazem **Copy Agent: Zkopírovat instrukce pro agenta v Copilotu**
(nebo `/instructions` v panelu).

## Jak to funguje

1. V panelu Copy Agent (pravý postranní panel, přepíná se v jeho záhlaví vedle Copilot Chatu) napište úkol a odešlete Enterem (nebo `Ctrl+Alt+C`).
   Lomítko `/` nabídne příkazy a skilly, `#` odkazy na soubory.
2. Prompt je ve schránce: v chatu s agentem `Ctrl+V`. Panel vede krok za krokem:
   - prompt delší než `copyAgent.prompt.maxChars` (výchozí 80 000 znaků, takže zřídka) jde po částech
     `[PART i/n]` (model na části odpoví „OK“); po vložení se další část zkopíruje sama, nebo tlačítkem
     *Další krok* / `Ctrl+Alt+N`;
   - po textu se do schránky dá **soubor s celou codebase** (jen Windows; jinde ho přiložíte ručně
     z `.copy-agent/out/`): stejným `Ctrl+V` ho připojíte jako přílohu a zprávu odešlete.
3. Model odpoví blokem `<copy turn="N">…</copy>` v ohrazení kódu. Klikněte na **kopírovat** u bloku
   (nebo zkopírujte celou odpověď); Copy Agent hlídá schránku a odpověď převezme. Záložně `Ctrl+Alt+V`
   nebo vložení do pole v panelu.
4. Copy Agent provede akce (čtení, hledání, úpravy, příkazy, diagnostika) a rovnou dá do schránky
   další prompt s výsledky. Opakujte, dokud model nepošle `<done>`.

Změny v souborech se aplikují hned (aby šly spustit testy), ale zůstávají **ke schválení** jako
v Copilotu: v editoru jsou zvýrazněné, nad každou je CodeLens *Přijmout / Zamítnout*, příkaz
**Copy Agent: Projít změny** je otevírá jednu po druhé. Zamítnutí se modelu nahlásí v dalším kole.
Když provádění akcí stojí na schválení příkazu, stavová karta zežloutne, ukáže příkaz a tlačítka
*Povolit / Zamítnout / Auto* přímo v ní.

## Co umí

- **Celá codebase v příloze.** Při startu úkolu se všechny textové soubory (podle `.gitignore`, bez
  binárních, bez limitu velikosti) zabalí do jednoho `.txt` (`===== FILE: cesta =====` + obsah). Model
  tak nemusí nic vyžadovat a obvykle úkol dokončí v jedné odpovědi. Vypnout jde nastavením
  `copyAgent.context.fullBundle` nebo zaškrtávátkem „celá codebase“ dole v panelu (platí pro další úkol).
  Vedle toho jdou v promptu vždy **automaticky vybrané soubory**: cesty a identifikátory ze zadání,
  aktivní soubor, u velkých souborů osnova a okolí shod (`copyAgent.context.auto`).
- **Dva cíle.** `copyAgent.target = copilot-agent` (výchozí): protokol zná agent z instrukcí, první
  prompt má ~2 000 znaků plus kontext. `generic`: celý popis protokolu jde v prvním promptu (obecný chat).
- **Limity chatu.** Prompt nad `copyAgent.prompt.maxChars` se dělí na části; odpověď modelu nad
  `copyAgent.reply.maxChars` má model dělit na `part="1/2"` a rozšíření si o další část řekne samo.
  Useknutá odpověď: hotové akce se provedou, useknutá se nikdy nevykoná a model dostane přesně, co má
  poslat znovu.
- **Robustní parser.** Blok v ohrazení (i rozbitém vnitřními ```), HTML-escapované značky, CDATA, entity,
  typografické uvozovky, ukázky protokolu uvnitř dokumentu, zaměněné uzavírací tagy, odpověď bez bloku
  (dokument v chatu se zachrání do souboru, zmíněné soubory se přečtou), dutý `<write>`.
- **Kontrola po zápisu.** Každý zapsaný soubor se zkontroluje na zbytky protokolu a syntaxi (JSON,
  Python, JavaScript, TypeScript); neplatný soubor je neúspěšná akce a `<done>` neprojde.
- **Rychlé provádění.** Čtecí akce (read, grep, ls, glob, bundle) běží souběžně; grep čte soubory
  v dávkách; seznam souborů je v cache; text jde do schránky okamžitě, detekce vložení (Windows) běží
  vedle a nezdržuje.
- **Akce:** `read` (osnova u dlouhých souborů), `ls`, `glob`, `grep`, `bundle`, `write`, `edit`
  (SEARCH/REPLACE s tolerancí bílých znaků, uvozovek a přeformátování; `section=` pro markdown),
  `move`, `delete`, `run` (schvalování, `probe=` pro servery a GUI, `capture=` screenshot), `screenshot`,
  `diagnostics`, `ask` (tlačítka s možnostmi), `status`, `dialog`, `plan`, `suggest`, `done`.
- **Ochrana obsahu.** `<write>` existujícího souboru se zástupným textem („viz výše“) nebo se zlomkem původní
  délky se odmítne (model dostane pokyn poslat celý obsah nebo použít `<edit>`; `force="true"` přepsání
  dovolí). Když model napíše obsah souboru do chatu mimo blok a v bloku jen odkáže, agent si vezme
  ohrazený kód z chatu a soubor zapíše z něj.
- **Kódování.** Soubor se čte z disku a kódování se pozná z bajtů (BOM, UTF-8, UTF-16, jinak
  `copyAgent.files.fallbackEncoding`, výchozí windows-1250); zápis jde zpět ve stejném kódování, s BOM
  i koncem řádků. Z editoru se bere jen text s neuloženými změnami. Po zápisu se kódování ověří a změna se
  hlásí jako varování. U projektů se smíšeným kódováním zapněte ve VS Code `files.autoGuessEncoding`,
  aby editor soubory zobrazoval správně.
- **Nic mimo `.copy-agent/`.** Všechny pomocné soubory (stav sezení, záznam průběhu, plán, svazky,
  výstupy příkazů, snímky, dočasný text pro schránku) jsou jen ve složce `.copy-agent/` workspace
  (globální skilly a pravidla v `~/.copy-agent/`). Při startu úkolu se `.copy-agent/` a `AGENTS.md`
  automaticky doplní do `.gitignore` a do `svn:ignore` každé složky pod gitem či Subversion
  (`copyAgent.vcs.autoIgnore`).
- **Plán** (`/plan` nebo automaticky u větších úkolů, `.copy-agent/plan.md`), **přímý dialog** (model se
  smí ptát přímo v chatu), **návrhy** (`/suggest`: skilly, skripty, pravidla, hooky, povolení, úkoly
  z průběhu; každý schválíte kartou), **hooky** (`.copy-agent/hooks.json`, běží po změně souborů),
  **git checkpoint** a Undo kola, **chráněné cesty**, **kódování souborů** (zachová UTF-8/BOM/windows-1250/
  UTF-16 i CRLF), **multi-root workspace**, **obnova sezení** po restartu VS Code, **záznam průběhu**
  (`.copy-agent/transcript.jsonl`).
- **Skilly**: vestavěné `/init` (založí `AGENTS.md`), `/commit`, `/review`, `/test`, `/fix`, `/explain`,
  `/docs`, `/deps`; vlastní v `.copy-agent/skills/` (projekt) nebo `~/.copy-agent/skills/` (uživatel),
  soubor `název.md` nebo `název/SKILL.md` i se skripty.
- **Odkazy na soubory** v zadání jako `#cesta/soubor.ts`, `#soubor.ts:40-80`, `#file`, `#selection`.

## Příkazy a klávesy

| Příkaz | Klávesa |
|---|---|
| Copy Agent: Nový úkol | `Ctrl+Alt+C` |
| Copy Agent: Vložit odpověď ze schránky | `Ctrl+Alt+V` |
| Copy Agent: Další krok doručení promptu | `Ctrl+Alt+N` |
| Copy Agent: Zkopírovat aktuální prompt znovu, Zobrazit aktuální prompt | |
| Copy Agent: Znovu poslat kontext (nový chat), Undo posledního kola, Zrušit úkol, Přerušit akce | |
| Copy Agent: Zkopírovat instrukce pro agenta v Copilotu | |
| Copy Agent: Projít změny, Přijmout / Zamítnout všechny změny | |

Ovládací příkazy v panelu: `/plan`, `/suggest`, `/auto`, `/resend`, `/undo`, `/stop`, `/new`, `/status`,
`/skills`, `/instructions`, `/help`.

## Nastavení

Tlačítko ⚙ v panelu, nebo `Ctrl+,` a hledat `copyAgent`. Nejdůležitější:

- `copyAgent.target` – `copilot-agent` (výchozí) / `generic`.
- `copyAgent.prompt.maxChars` (80 000) – limit jedné zprávy chatu; delší prompt jde po částech (snižte, když chat dlouhou zprávu odmítne).
- `copyAgent.reply.maxChars` (9 000) – kolik znaků má model dát do jedné odpovědi.
- `copyAgent.context.fullBundle` (true) – celá codebase v příloze úvodního promptu; zaškrtávátko „celá codebase“ v panelu to přepne pro další úkol.
- `copyAgent.context.auto` (true) – automatický výběr souborů podle zadání.
- `copyAgent.bundle.delivery` – `file` (výchozí, Windows: soubor do schránky), `history` (Win+V), `text`.
- `copyAgent.prompt.asFile` – prompt jako `copy-prompt-N.txt` spolu s přílohou (jedno Ctrl+V).
- `copyAgent.review.beforeDone` – `off` (výchozí) / `auto` / `always`: revize před dokončením stojí
  další kolo.
- `copyAgent.run.autoAllow`, `copyAgent.run.allowPatterns`, `copyAgent.run.deny`, `copyAgent.run.approval`.
- `copyAgent.protectedPaths`, `copyAgent.checkpoint.git`, `copyAgent.files.defaultEncoding`.

Instrukce pro projekt (příkazy, konvence) patří do `AGENTS.md` (nebo `COPY-AGENT.md`) v kořeni
workspace; založí ho `/init`. Globální instrukce a pravidla: `~/.copy-agent/AGENTS.md`, `~/.copy-agent/rules.md`.

## Vývoj

```
npm install
npm run build        # bundle do dist/ (extension, harness, gen-instructions)
npm test             # unit testy (vitest)
node dist/gen-instructions.js --write   # copilot-agent/INSTRUCTIONS.md ze zdrojů
npm run package      # vytvoří .vsix
```

Ladění: F5 ve VS Code (*Run Extension*).

### Headless harness

Stejné jádro běží i bez VS Code, „schránka“ je soubor. Hodí se k testování s libovolným chatem:

```
node dist/harness.js start <root> "<úkol>" [--generic] [--plan] [--no-full] [--max=N]
      → prompt do <root>/.copy-agent/outbox.md (části do outbox-N.md), codebase do .copy-agent/out/
node dist/harness.js reply <root> [inbox.md]   # vykoná odpověď z .copy-agent/inbox.md, další prompt do outboxu
node dist/harness.js answer <root> "<odpověď>" # odpověď na <ask>
node dist/harness.js suggest <root>            # prompt s žádostí o návrhy z průběhu
node dist/harness.js status <root>
node dist/harness.js instructions              # instrukce pro agenta v Copilotu
```

V headless režimu se potvrzovací dotazy schvalují automaticky a logují; denylist platí dál.
