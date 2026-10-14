# Agent v Copilotu (Teams) jako model pro Copy Agent

Copy Agent potřebuje na druhé straně chat, který rozumí jeho protokolu. V Microsoft 365 Copilotu
(v Teams i na m365.cloud.microsoft) si k tomu založíte vlastního **deklarativního agenta** s instrukcemi
z tohoto adresáře. Agent pak každou zprávu bere jako kolo práce: čte přiloženou codebase, odpovídá
jedním blokem akcí v ohrazení kódu a snaží se úkol dokončit v co nejméně odpovědích.

## 1. Instrukce

Soubor [INSTRUCTIONS.md](INSTRUCTIONS.md) je generovaný ze zdrojového kódu rozšíření (`npm run build &&
node dist/gen-instructions.js --write`), takže vždy odpovídá protokolu. Má ~6 200 znaků; limit pole
Pokyny v Agent Builderu je 8 000 znaků. Aktuální znění (s vaším nastavením jazyka a limitů) dostanete
do schránky také přímo z VS Code: příkaz **Copy Agent: Zkopírovat instrukce pro agenta v Copilotu**,
tlačítko s robotem v horní liště panelu, nebo `/instructions` v panelu.

## 2. Založení agenta v Teams (Agent Builder)

1. V Teams otevřete aplikaci **Copilot** (nebo m365.cloud.microsoft/chat).
2. Vpravo nahoře (nebo v levém panelu) **Agenti → Vytvořit agenta** (Create an agent). Otevře se
   Agent Builder.
3. Přepněte na záložku **Konfigurovat** (Configure) – nepoužívejte záložku Popsat, ta instrukce
   přepisuje vlastním zněním.
4. Vyplňte:
   - **Název:** `Copy Agent`
   - **Popis:** `Kódovací agent pro VS Code: čte přiloženou codebase a odpovídá jedním blokem akcí
     <copy>, které rozšíření Copy Agent provede. Pro použití s rozšířením Copy Agent ve VS Code.`
   - **Pokyny** (Instructions): vložte celý obsah [INSTRUCTIONS.md](INSTRUCTIONS.md).
   - **Znalosti** (Knowledge): nic nepřidávejte (zdrojem je příloha v každém úkolu).
   - **Funkce** (Capabilities): interpret kódu ani generátor obrázků nejsou potřeba; nechte vypnuté.
   - **Úvodní zprávy** (Conversation starters), volitelně:
     - `Nový úkol: vložím prompt z Copy Agenta.`
     - `Pokračuji v úkolu: vložím výsledky akcí (<copy-results>).`
5. **Vytvořit** (Create). Agent se objeví v seznamu Agenti; pro úkol otevřete chat s ním.

Ve firemním tenantu může být tvorba agentů vypnutá správcem; pak použijte běžný chat Copilota a
v nastavení rozšíření přepněte `copyAgent.target` na `generic` (celý popis protokolu jde v prvním
promptu, prompty jsou delší).

## 3. Práce s úkolem

1. Ve VS Code v panelu Copy Agent napište zadání a odešlete.
2. Rozšíření sestaví prompt a dá ho do schránky; v chatu s agentem stiskněte **Ctrl+V**.
   - Když je prompt delší než limit chatu (`copyAgent.prompt.maxChars`, výchozí 80 000, takže zřídka), jde po částech
     `[PART i/n]`: na každou část agent odpoví „OK“, po vložení se další část zkopíruje sama (nebo
     tlačítkem *Další krok*, `Ctrl+Alt+N`).
   - Po vložení textu se do schránky dá **soubor s celou codebase** (`bundle-1-0-….txt`): stejným Ctrl+V
     ho v Teams připojíte jako přílohu. Pak zprávu odešlete.
3. Agent odpoví blokem v ohrazení kódu. Klikněte na **Kopírovat** u bloku kódu (nebo zkopírujte
   celou odpověď). Copy Agent odpověď sám převezme, provede akce a připraví další prompt.
4. Opakujte, dokud agent nepošle `<done>`. Změny v souborech jsou zvýrazněné a čekají na
   *Přijmout / Zamítnout* (CodeLens nad změnou, nebo karta v panelu).

Na jeden úkol použijte jeden chat: Copilot drží historii, prompty po prvním kole nesou jen výsledky.
Pro nový úkol založte nový chat (tlačítko *Nový chat*), rozšíření pošle kontext znovu.

## 4. Limity Copilota a jak je rozšíření obchází

| Limit | Co dělá Copy Agent |
|---|---|
| Délka jedné zprávy (podle tenantu 4 000–16 000 znaků) | prompt se dělí na části `[PART i/n]`; nastavte `copyAgent.prompt.maxChars` podle toho, co váš chat přijme |
| Délka odpovědi (ořez, typicky 1 024–4 096 tokenů) | agent má držet odpověď pod `copyAgent.reply.maxChars` a dělit ji na `part="1/2"`; useknutou akci rozšíření nikdy nevykoná a řekne si o ni znovu |
| Velké přílohy čte Copilot po částech (vyhledáváním), ne celé | agent ví, že příloha může být neúplná, a chybějící soubory si vyžádá `<read>`; přílohu lze vypnout zaškrtávátkem „celá codebase“ v panelu nebo nastavením `copyAgent.context.fullBundle` |
| Renderování `<tagů>` v chatu | blok je vždy v ohrazení kódu (čtyři zpětné apostrofy), takže Teams nic neskryje a tlačítko Kopírovat dá přesný text; escapované značky parser dekóduje |
| Copilot někdy odmítne „roli agenta“ | instrukce ho popisují jako autora textu, který uživatel vkládá do programu; žádný přístup k souborům po něm nechtějí |

## 5. Copilot Studio

V Copilot Studiu (pokud k němu máte přístup) vytvořte agenta stejně: Název, Popis a pole Pokyny
s obsahem INSTRUCTIONS.md; limit pole je tam také 8 000 znaků. Generativní odpovědi ponechte
zapnuté, znalostní zdroje a akce nepřidávejte.
