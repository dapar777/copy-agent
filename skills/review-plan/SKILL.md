---
name: review-plan
description: Připraví plán revize a popisy změn pro rozšíření Review změn (.review/agent.json)
---
Prepare the review data for the VS Code extension "Review změn": split the uncommitted changes into
pieces, describe every piece, rate its risk, order the pieces into a review plan and save it all for
the extension. Do NOT change any source file. The real diff stays the source of truth; your data only
helps the reviewer, so never describe a change you did not see in the diff.

1. In ONE `<run>`: `python <script path>/review_data.py diff` (see "Scripts shipped with this skill"
   below). It prints every change of every working copy (Git and SVN, also several separately checked
   out folders and multi-root workspaces) with exact line numbers: `+N` is an added line and N its NEW
   line number, `-N` is a removed line and N its OLD line number. Every path it prints is the path to
   use in the data. Text after /review-plan narrows the scope or adds instructions. Add `<read>` only
   for code you need to understand a change (callers, the surrounding function) and that is not
   already shown.
2. Split the changes into pieces. A piece is one logical change the reviewer approves at once,
   usually one hunk or a few adjacent hunks of ONE file; prefer more small pieces to one large.
   - `radky` is the range of NEW line numbers of the piece's added lines. Removed lines replaced by
     them, and removed lines strictly inside the range, belong to the piece automatically.
   - A piece that only removes lines has `stare` (range of OLD line numbers) instead of `radky`.
   - Pieces must not overlap and together should cover every changed line.
   - When several pieces lie in one function, procedure or class, add a parent piece (`id`, `soubor`,
     `titulek`, `radky` = the whole function in the new file) and put its id in `rodic` of the children.
   - Formatting-only changes (whitespace, indentation, reordered imports): `"sum": true`, short title.
   - Workbook (.xlsx): one piece per changed sheet with `"list": "<sheet name>"`, no line range.
   - Binary files: no piece.
   - A new file that is a copy of another file: add `{"cesta": "<new>", "zdroj": "<original>"}` to
     `soubory` and describe what differs from the original.
3. Describe each piece:
   - `titulek`: a few words naming the change.
   - `popis`: one to three sentences, what changed and why, and what the code did before.
   - `labely`: from `kod, api, ddl, data, konfigurace, test, dokumentace, transakce, vykon,
     bezpecnost, refaktoring, kopie, generovane`.
   - `riziko`: `uroven` is `nizke`, `stredni` or `vysoke`; `duvod` is one sentence and is required
     above `nizke`. High: data loss or corruption, money, security, transactions and locking, public
     API or schema changes, code without tests on a hot path. Do not inflate; most pieces are `nizke`.
   - `odkazy.volani`: callers you actually found, as `path:line`. `odkazy.souvisejici`: ids of pieces
     this one depends on.
   - `otazky`: only real questions the reviewer has to decide; most pieces have none.
4. Build the `plan`: steps in the order in which the change is easiest to understand. Foundations
   first (schema, configuration, signatures), then the core logic, then callers, tests and docs.
   Each step has `nazev`, `proc` (why it comes here and what it builds on) and `kusy` (ids; a parent
   id stands for all its children). Every piece that is not formatting belongs to exactly one step.
5. `souhrn.titulek` is a proposed commit subject (at most 72 characters), `souhrn.body` two to six
   points for the commit body.
6. In ONE reply `<write path=".copy-agent/review-agent.json">` with the complete JSON and
   `<run>python <script path>/review_data.py check --file .copy-agent/review-agent.json</run>`.
   The script checks the draft against the real diff, fills in `otisk` (fingerprint) of every piece,
   installs the result as `.review/agent.json` in the main directory of the workspace and removes the
   draft. On ERROR nothing is installed: fix the draft with `<edit>` and run the check again, in one
   reply. A warning about changed lines without a piece means pieces are missing; add them.
7. `<done>` with a short summary: number of pieces and steps, the risky pieces, the open questions,
   and that the review opens with the command "Review změn: Otevřít" (Ctrl+Alt+R).

Texts inside the JSON (`titulek`, `popis`, `duvod`, `otazky`, `nazev`, `proc`, `souhrn`) are written in
the language of the user. Paths use forward slashes exactly as the script printed them. A large change
does not fit one reply: send the JSON in parts (`part="1/2"` …), first `<write>` with the beginning,
then `<edit>` appending the rest, and run the check in the last part.

## Format of the data

```json
{
  "verze": 2,
  "souhrn": { "titulek": "DPH zaokrouhlené po řádcích faktury", "body": ["Nový sloupec faktura_radek.dph_zaokr"] },
  "soubory": [{ "cesta": "db/pkg_dobropisy.sql", "zdroj": "db/pkg_faktury.sql" }],
  "kusy": [
    { "id": "fn", "soubor": "db/pkg_faktury.sql", "radky": { "od": 3, "do": 31 }, "titulek": "vystav_fakturu" },
    {
      "id": "telo", "rodic": "fn", "soubor": "db/pkg_faktury.sql", "radky": { "od": 9, "do": 21 },
      "titulek": "Tělo – výpočet DPH",
      "popis": "DPH se nově počítá po řádcích faktury. Dřív se počítala jednou ze součtu základu.",
      "labely": ["kod", "transakce"],
      "riziko": { "uroven": "vysoke", "duvod": "UPDATE v cyklu uvnitř transakce nad velkou tabulkou." },
      "odkazy": { "volani": ["db/pkg_objednavky.sql:88"], "souvisejici": ["sloupec"] },
      "otazky": ["Používá se součet základu ještě jinde než pro DPH?"]
    },
    { "id": "stary-kod", "soubor": "db/pkg_faktury.sql", "stare": { "od": 40, "do": 44 }, "titulek": "Odstraněný pomocný výpočet" },
    { "id": "sazby", "soubor": "config/sazby.xlsx", "list": "Sazby", "titulek": "Sazby DPH od 2024" }
  ],
  "plan": [
    { "krok": 1, "nazev": "Výpočet DPH", "kusy": ["fn", "stary-kod"], "proc": "Jádro změny." },
    { "krok": 2, "nazev": "Konfigurace", "kusy": ["sazby"], "proc": "Data, která výpočet čte." }
  ]
}
```

`otisk` and `vytvoreno` are filled in by the script. The extension keeps its own data (approvals,
comments, answers) in `.review/uzivatel.json`; never touch that file.

## Help
Použití: /review-plan [rozsah nebo pokyny]
Projde necommitnuté změny ve všech pracovních kopiích (Git i SVN, i ve workspace s více složkami), rozdělí je na kusy, popíše je, ohodnotí riziko, sestaví plán revize a uloží ho do .review/agent.json pro rozšíření Review změn (dapar.vscode-review). Zdrojové soubory nemění.
Příklady:
- /review-plan
- /review-plan jen pracovní kopie db
- /review-plan zaměř se na transakce a výkon
