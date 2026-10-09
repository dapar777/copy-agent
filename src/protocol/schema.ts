/**
 * Jediný zdroj pravdy o nástrojích (akcích) protokolu. Z této tabulky se generuje popis pro model
 * (preambule i instrukce agenta v Copilotu), validace v parseru a dispatch v ToolRunneru.
 */

export interface ToolAttr {
  name: string;
  required: boolean;
  doc: string;
}

export interface ToolDef {
  name: string;
  attrs: ToolAttr[];
  /** true = párový tag s tělem, false = self-closing */
  hasBody: boolean;
  bodyDoc?: string;
  doc: string;
  example: string;
  /** akce jen čte (dá se spouštět souběžně s ostatními čtecími akcemi) */
  readOnly?: boolean;
  /** zkrácený popis do instrukcí agenta (limit 8 000 znaků) */
  short?: string;
}

/** Název bloku v odpovědi modelu a bloku s výsledky od agenta. */
export const BLOCK = "copy";
export const RESULTS = "copy-results";

export const TOOLS: ToolDef[] = [
  {
    name: "read",
    hasBody: false,
    readOnly: true,
    attrs: [
      { name: "path", required: true, doc: "workspace-relative path" },
      { name: "lines", required: false, doc: 'line range "A-B" (1-based, inclusive); files over ~300 lines return an outline unless a range is given' },
    ],
    doc: "Return file contents with line numbers.",
    short: "file with line numbers; lines=\"A-B\" for a range (long files return an outline without it)",
    example: '<read path="src/app.ts" lines="1-120"/>',
  },
  {
    name: "ls",
    hasBody: false,
    readOnly: true,
    attrs: [
      { name: "path", required: false, doc: "directory (default: workspace root)" },
      { name: "depth", required: false, doc: "recursion depth (default 1, max 4)" },
    ],
    doc: "List directory entries (respects .gitignore).",
    short: "directory listing",
    example: '<ls path="src" depth="2"/>',
  },
  {
    name: "glob",
    hasBody: false,
    readOnly: true,
    attrs: [{ name: "pattern", required: true, doc: 'glob, e.g. "src/**/*.test.ts"' }],
    doc: "List files matching a glob.",
    short: "files matching a glob",
    example: '<glob pattern="**/*.config.*"/>',
  },
  {
    name: "grep",
    hasBody: false,
    readOnly: true,
    attrs: [
      { name: "pattern", required: true, doc: "regular expression (JS syntax, case-insensitive)" },
      { name: "glob", required: false, doc: "restrict to files matching glob" },
      { name: "context", required: false, doc: "lines of context (default 0, max 5)" },
    ],
    doc: "Search file contents. Returns path:line: text.",
    short: "regex search, returns path:line: text",
    example: '<grep pattern="isValidEmail|validateEmail" glob="src/**/*.ts*"/>',
  },
  {
    name: "bundle",
    hasBody: false,
    readOnly: true,
    attrs: [
      { name: "paths", required: false, doc: 'comma-separated paths, directories or globs, e.g. "src/**/*.ts, tests, README.md"' },
      { name: "all", required: false, doc: '"true" = the whole codebase (respects .gitignore; binaries skipped)' },
    ],
    doc: "Get MANY files at once as one structured text (one section per file) instead of many <read>s. Use it for a whole module; use <read> for one or two files.",
    short: "many files at once (paths/globs or all=\"true\"); prefer over 5+ reads",
    example: '<bundle paths="src/**/*.ts, package.json"/>',
  },
  {
    name: "write",
    hasBody: true,
    attrs: [
      { name: "path", required: true, doc: "workspace-relative path; parent dirs are created" },
      { name: "force", required: false, doc: '"true" to allow overwriting an existing file with much shorter content (otherwise such a write is refused as a safety measure)' },
    ],
    bodyDoc: "the complete new file content, verbatim: no HTML escaping, no <![CDATA[ ]]>, no code fence around the body, never a placeholder like \"see above\"",
    doc: "Create or fully overwrite a file. Prefer <edit> for existing files.",
    short: "create/overwrite a whole file; body verbatim and complete (a placeholder or a much shorter body is refused)",
    example: '<write path="src/utils/email.ts">\nexport function isValidEmail(v: string) {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v);\n}\n</write>',
  },
  {
    name: "edit",
    hasBody: true,
    attrs: [
      { name: "path", required: true, doc: "existing file" },
      { name: "section", required: false, doc: 'markdown only: heading of the section to replace, e.g. "## Rizika"; the body is then the complete new section instead of hunks' },
      { name: "insert", required: false, doc: 'with section=: "before" or "after" = insert the body (starting with its own heading) as a new section' },
    ],
    bodyDoc: "one or more SEARCH/REPLACE hunks; SEARCH must match the file text exactly (whitespace-tolerant fallback exists); keep SEARCH short but unique",
    doc: "Modify an existing file with SEARCH/REPLACE hunks, or (markdown) replace a whole section by its heading.",
    short: "SEARCH/REPLACE hunks (or section=\"## Heading\" for markdown)",
    example: '<edit path="src/forms/RegisterForm.tsx">\n<<<<<<< SEARCH\n  const canSubmit = name.length > 0;\n=======\n  const canSubmit = name.length > 0 && isValidEmail(email);\n>>>>>>> REPLACE\n</edit>',
  },
  {
    name: "move",
    hasBody: false,
    attrs: [
      { name: "from", required: true, doc: "existing file" },
      { name: "to", required: true, doc: "new path (parent dirs are created)" },
    ],
    doc: "Rename or move a file.",
    short: "rename/move a file",
    example: '<move from="src/old.ts" to="src/lib/new.ts"/>',
  },
  {
    name: "delete",
    hasBody: false,
    attrs: [{ name: "path", required: true, doc: "file to delete" }],
    doc: "Delete a file (user is asked to confirm).",
    short: "delete a file (user confirms)",
    example: '<delete path="src/old/legacy.ts"/>',
  },
  {
    name: "run",
    hasBody: true,
    attrs: [
      { name: "cwd", required: false, doc: "working directory relative to workspace (default: root)" },
      { name: "timeout", required: false, doc: "seconds (default 120, max 1800)" },
      { name: "probe", required: false, doc: "seconds; for servers/GUI apps that never exit: start, wait N s, report whether it still runs, then stop it" },
      { name: "capture", required: false, doc: "seconds (with probe): screenshot this many seconds after start, attached to the next prompt" },
      { name: "window", required: false, doc: "with capture: part of the window title to capture" },
    ],
    bodyDoc: "the shell command",
    doc: "Run a shell command; returns stdout+stderr and exit code. Some commands need user approval. Never run a server or GUI app without probe=.",
    short: "shell command (stdout+stderr+exit); servers/GUI need probe=\"N\"",
    example: '<run timeout="180">npm test -- RegisterForm</run>',
  },
  {
    name: "screenshot",
    hasBody: false,
    readOnly: true,
    attrs: [
      { name: "window", required: false, doc: "part of a visible window title; without it the whole screen" },
      { name: "name", required: false, doc: "file name hint" },
    ],
    doc: "Take a screenshot (Windows) and attach it as an image to the next prompt.",
    short: "screenshot attached to the next prompt (Windows)",
    example: '<screenshot window="Calculator"/>',
  },
  {
    name: "diagnostics",
    hasBody: false,
    readOnly: true,
    attrs: [{ name: "path", required: false, doc: "limit to one file" }],
    doc: "Return current errors/warnings from the editor language servers (TypeScript, ESLint, ...).",
    short: "editor errors/warnings",
    example: '<diagnostics path="src/forms/RegisterForm.tsx"/>',
  },
  {
    name: "ask",
    hasBody: true,
    attrs: [
      { name: "options", required: false, doc: 'answer choices separated by "|"; shown as buttons' },
      { name: "multi", required: false, doc: "true = several options may be picked" },
    ],
    bodyDoc: "the question for the user",
    doc: "Ask the user a question; the loop pauses until they answer. Use for ambiguous requirements or risky changes.",
    short: "question for the user (options=\"A|B\" as buttons); pauses the task",
    example: '<ask options="Jen v UI|I na serveru|Obojí">Kde má být validace e-mailu?</ask>',
  },
  {
    name: "status",
    hasBody: true,
    attrs: [],
    bodyDoc: "one or two sentences",
    doc: "Short progress note shown to the user.",
    short: "one-sentence progress note for the user",
    example: "<status>Přidal jsem validaci, teď spouštím testy.</status>",
  },
  {
    name: "dialog",
    hasBody: true,
    attrs: [{ name: "from", required: true, doc: "model = a question you asked directly in the chat; user = what the user wrote directly in the chat, verbatim" }],
    bodyDoc: "the exact text",
    doc: "Record a direct exchange that happened in the chat outside the protocol, so the tool keeps it in its log. Put these first in the block.",
    short: "record a chat exchange that happened outside the block",
    example: '<dialog from="user">Jen v UI, server řešíme jinde.</dialog>',
  },
  {
    name: "plan",
    hasBody: true,
    attrs: [],
    bodyDoc: "the COMPLETE plan as a markdown checklist (`- [ ] task` / `- [x] done`, subtasks indented by two spaces); resend the whole plan when it changes",
    doc: "Create or update the task plan for larger tasks (several files or distinct steps). Keep it current.",
    short: "markdown checklist for larger tasks; resend whole when it changes",
    example: "<plan>\n- [x] Prozkoumat validace\n- [ ] Přidat isValidEmail\n  - [ ] utils/email.ts\n  - [ ] testy\n</plan>",
  },
  {
    name: "suggest",
    hasBody: true,
    attrs: [
      { name: "kind", required: true, doc: "skill | script | instructions | rule | hook | allow | setting | task | agent" },
      { name: "scope", required: false, doc: "project (default) or global (every project)" },
      { name: "title", required: true, doc: "short title shown to the user" },
      { name: "update", required: false, doc: 'modify an existing item: skill name, "rule N" or a hook match glob; the body is the complete replacement' },
      { name: "lang", required: false, doc: 'with kind="script": python | node | bash | powershell | cmd (file extension)' },
      { name: "file", required: false, doc: 'with kind="script": file name, e.g. "release.py"' },
    ],
    bodyDoc:
      "skill: markdown instructions reusable via /name (start with `# name`); script: COMPLETE source of a runnable script; instructions: lines for AGENTS.md; rule: one concise behaviour rule; " +
      'hook: JSON {"match": glob, "run": command}; allow: regex of commands safe to run without confirmation; setting: JSON {"key": "copyAgent.…", "value": …}; task: a follow-up for the plan; agent: feedback for the agent developer',
    doc: "Propose a reusable improvement for the user to approve (never applied automatically).",
    short: "propose a reusable improvement (skill, script, rule, hook, allow, task…); user approves",
    example: '<suggest kind="rule" scope="global" title="Testy až po všech editech">Run tests once at the end of a turn, after all edits.</suggest>',
  },
  {
    name: "done",
    hasBody: true,
    attrs: [{ name: "reviewed", required: false, doc: '"true" after the review round the tool asks for' }],
    bodyDoc: "final summary: what changed, how it was verified, what remains",
    doc: "Finish the task. Put it last; it may follow final actions in the same block (if one of them fails, the task continues).",
    short: "finish with a summary (last in the block)",
    example: "<done>Přidána validace e-mailu v RegisterForm, testy prochází.</done>",
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
export const BODY_TOOLS = new Set(TOOLS.filter((t) => t.hasBody).map((t) => t.name));
export const READ_ONLY_TOOLS = new Set(TOOLS.filter((t) => t.readOnly).map((t) => t.name));
export const REQUIRED_ATTRS: Record<string, string[]> = Object.fromEntries(TOOLS.map((t) => [t.name, t.attrs.filter((a) => a.required).map((a) => a.name)]));
/** Akce, které samy nic nedělají (poznámky): blok složený jen z nich je „jen poznámka“. */
export const REMARK_TOOLS = new Set(["status", "dialog", "plan", "done", "think"]);
/** Akce, které nemají výsledek v <copy-results> (jen mění stav kola). */
export const SILENT_TOOLS = new Set(["status", "ask", "done", "dialog", "think"]);

/** Akce rozpoznaná v odpovědi modelu. */
export interface Action {
  tool: string;
  attrs: Record<string, string>;
  body?: string;
  /** pořadí v rámci bloku (pro párování výsledků a pro hlášení useknutí) */
  index: number;
}

/** Výsledek vykonání akce. */
export interface ActionResult {
  tool: string;
  attrs: Record<string, string>;
  status: "ok" | "error" | "denied" | "skipped";
  /** hlavní textový obsah (výpis souboru, výstup příkazu…) */
  output?: string;
  /** krátké doplňující atributy (exit, lines, hunks…) */
  meta?: Record<string, string | number>;
  /** cesta k plnému výstupu, pokud byl zkrácen */
  fullOutputPath?: string;
  /** soubory (obrázky, svazky) k přiložení k dalšímu promptu, relativní cesty */
  attachments?: string[];
}

export interface ParsedReply {
  turn: number | null;
  session: string | null;
  /** část vícedílné odpovědi (part="2/3"), když ji model poslal po částech */
  part?: { index: number; total: number };
  actions: Action[];
  /** chyby parsování, které se modelu vrátí k opravě */
  errors: string[];
  /** poznámky (ne chyby): co agent při čtení odpovědi sám opravil */
  notes: string[];
  /** odpověď byla useknutá (chybí </copy> nebo uzavírací tag poslední akce) */
  truncated?: boolean;
  /** akce, která byla useknutá (nevykoná se); model ji má poslat znovu */
  truncatedAction?: { tool: string; attrs: Record<string, string>; index: number };
  /** prosté vyjádření před blokem (uložíme do logu) */
  prose: string;
  /** veškerý text mimo blok (před i za ním); bez bloku celá odpověď */
  outside: string;
  /** celý původní text odpovědi (pro záchranu dokumentu) */
  raw: string;
}
