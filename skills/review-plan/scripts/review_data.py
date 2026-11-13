#!/usr/bin/env python3
"""Helper for the review-plan skill: data for the VS Code extension "Review změn".

Usage:
  python review_data.py diff  [options]   print every change with exact line numbers
  python review_data.py check [options]   validate .review/agent.json and fill in fingerprints

Options:
  --folder DIR       workspace folder to scan, repeatable (pass every root of a multi-root workspace);
                     default: the folders in the environment variable COPY_AGENT_ROOTS, else the current dir
  --main DIR         main directory (holds .review/, paths are relative to it); default: the only
                     folder, or for several folders the directory of COPY_AGENT_WORKSPACE_FILE when
                     they all lie under it, otherwise their common parent
  --depth N          how deep to look for separately checked-out working copies (default 2)
  --scope MODE       git: auto (staged if anything is staged, else working tree), staged, working
  --changelist NAME  svn: only files of this changelist
  --encoding NAME    encoding of files that are not valid UTF-8 (default cp1250)
  --context N        diff: context lines around changes (default 3)
  --max-lines N      diff: print at most N changed lines per file (default 400)
  --file PATH        check: file to validate (default <main>/.review/agent.json); a file from elsewhere
                     is installed to <main>/.review/agent.json when it passes, and then removed
  --no-write         check: only validate, write nothing

Works with Git and SVN working copies, several of them in one workspace. Unversioned folders are
ignored. Python 3.8+, standard library only. The mapping of pieces to changed lines and the
fingerprint are the same as in the extension (src/core/pieces.ts); keep them in sync.
"""
import argparse
import codecs
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
import zipfile

RISKS = {"nizke", "stredni", "vysoke"}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _c1(err):  # bytes undefined in cp1250 map to the same code point, as browsers do
    return "".join(chr(b) for b in err.object[err.start:err.end]), err.end


codecs.register_error("review-c1", _c1)


def decode(data, fallback):
    if not data:
        return ""
    if data[:2] == b"\xff\xfe":
        return data[2:].decode("utf-16-le", "replace")
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", "replace")
    body = data[3:] if data[:3] == b"\xef\xbb\xbf" else data
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return body.decode(fallback, "review-c1")
        except LookupError:
            return body.decode("latin-1")


def is_binary(data):
    if not data or data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return False
    return b"\x00" in data[:8000]


def split_lines(text):
    if text == "":
        return []
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    return [l[:-1] if l.endswith("\r") else l for l in lines]


def run(cmd, cwd):
    try:
        p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        sys.exit("error: command not found: %s" % cmd[0])
    return p.returncode, p.stdout, p.stderr.decode("utf-8", "replace")


def slash(p):
    return p.replace("\\", "/")


# ---------------------------------------------------------------- working copies
def marker(d):
    if os.path.exists(os.path.join(d, ".svn")):
        return "svn"
    if os.path.exists(os.path.join(d, ".git")):
        return "git"
    return None


def detect_up(d):
    cur = os.path.abspath(d)
    for _ in range(40):
        m = marker(cur)
        if m:
            return m
        up = os.path.dirname(cur)
        if up == cur:
            return None
        cur = up
    return None


def find_roots(folders, main, depth):
    found = []
    for folder in folders:
        own = marker(folder)
        if own:
            found.append((folder, own))
            continue
        inside, level = [], [folder]
        for _ in range(depth):
            nxt = []
            for d in level:
                try:
                    names = sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d, n)))
                except OSError:
                    names = []
                for n in names:
                    if n.startswith(".") or n == "node_modules":
                        continue
                    sub = os.path.join(d, n)
                    v = marker(sub)
                    if v:
                        inside.append((sub, v))
                    else:
                        nxt.append(sub)
            level = nxt
        found.extend(inside if inside else [(folder, detect_up(folder))])
    roots, seen = [], set()
    for d, vcs in found:
        d = os.path.abspath(d)
        if d in seen or not vcs:
            continue
        seen.add(d)
        prefix = slash(os.path.relpath(d, main))
        if prefix == ".":
            prefix = ""
        if prefix.startswith(".."):
            prefix = os.path.basename(d)
        roots.append({"name": prefix or os.path.basename(d), "dir": d, "prefix": prefix, "vcs": vcs})
    return sorted(roots, key=lambda r: r["name"])


class Git:
    def __init__(self, d, scope):
        self.dir, self.scope, self.staged, self.untracked = d, scope, False, set()

    def git(self, *args):
        return run(["git", "-c", "core.quotepath=off", *args], self.dir)

    @staticmethod
    def _names(out):
        parts, res, i = out.decode("utf-8", "replace").split("\0"), [], 0
        while i < len(parts) - 1:
            code = parts[i]
            i += 1
            if not code:
                continue
            if code[0] in "RC":
                res.append({"path": slash(parts[i + 1]), "status": "renamed" if code[0] == "R" else "copied", "orig": slash(parts[i])})
                i += 2
            else:
                res.append({"path": slash(parts[i]), "status": {"A": "added", "D": "deleted"}.get(code[0], "modified")})
                i += 1
        return res

    def changes(self):
        lst = []
        if self.scope != "working":
            lst = self._names(self.git("diff", "--cached", "--name-status", "-z", "-M", "--relative")[1])
        self.staged = self.scope == "staged" or (self.scope == "auto" and bool(lst))
        if not self.staged:
            has_head = self.git("rev-parse", "--verify", "-q", "HEAD")[0] == 0
            args = ("diff", "HEAD", "--name-status", "-z", "-M", "--relative") if has_head else ("diff", "--cached", "--name-status", "-z", "--relative")
            lst = self._names(self.git(*args)[1])
            known = {c["path"] for c in lst}
            for p in self.git("ls-files", "--others", "--exclude-standard", "-z")[1].decode("utf-8", "replace").split("\0"):
                if p and slash(p) not in known:
                    self.untracked.add(slash(p))
                    lst.append({"path": slash(p), "status": "added"})
        return lst

    def new(self, c):
        if c["status"] == "deleted":
            return None
        if self.staged:
            code, out, _ = self.git("show", ":./" + c["path"])
            if code == 0:
                return out
        try:
            with open(os.path.join(self.dir, c["path"]), "rb") as f:
                return f.read()
        except OSError:
            return None

    def old(self, c):
        if c["status"] == "added":
            return None
        code, out, _ = self.git("show", "HEAD:./" + c.get("orig", c["path"]))
        return out if code == 0 else None

    def diff(self, c, context):
        if c["path"] in self.untracked:
            return None
        paths = [c["orig"], c["path"]] if c.get("orig") else [c["path"]]
        base = ["-U%d" % context, "--no-color", "--no-ext-diff", "--no-textconv", "-M", "--relative", "--", *paths]
        code, out, _ = self.git("diff", "--cached", *base) if self.staged else self.git("diff", "HEAD", *base)
        return out if code == 0 else None


class Svn:
    def __init__(self, d, changelist):
        self.dir, self.changelist = d, changelist

    def svn(self, *args):
        return run(["svn", "--non-interactive", *args], self.dir)

    def changes(self):
        code, out, err = self.svn("status", "--xml")
        if code != 0:
            sys.exit("error: svn status failed in %s: %s" % (self.dir, err.strip()))
        xml = out.decode("utf-8", "replace")
        if self.changelist:
            m = re.search(r'<changelist\s+name="%s">([\s\S]*?)</changelist>' % re.escape(self.changelist), xml)
            xml = m.group(1) if m else ""
        res = []
        for m in re.finditer(r'<entry\s+path="([^"]*)"\s*>([\s\S]*?)</entry>', xml):
            st = re.search(r"<wc-status\b([^>]*)>", m.group(2))
            st = st.group(1) if st else ""
            item = re.search(r'\bitem="([^"]*)"', st)
            item = item.group(1) if item else ""
            path = slash(m.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))
            if item in ("modified", "conflicted", "replaced"):
                status = "modified"
            elif item == "added":
                status = "copied" if 'copied="true"' in st else "added"
            elif item == "deleted":
                # a deleted directory is one status entry; `svn info -R` lists its files
                info = self.svn("info", "--xml", "-R", path)[1].decode("utf-8", "replace")
                found = [re.search(r'\bpath="([^"]*)"', t) for t in re.findall(r"<entry\b([^>]*)>", info) if 'kind="file"' in t]
                for f in ([slash(m.group(1)) for m in found if m] or ([] if info else [path])):
                    res.append({"path": f, "status": "deleted"})
                continue
            else:
                continue
            full = os.path.join(self.dir, path)
            if status != "deleted" and (not os.path.exists(full) or os.path.isdir(full)):
                continue
            res.append({"path": path, "status": status})
        return res

    def new(self, c):
        if c["status"] == "deleted":
            return None
        try:
            with open(os.path.join(self.dir, c["path"]), "rb") as f:
                return f.read()
        except OSError:
            return None

    def old(self, c):
        if c["status"] == "added":
            return None
        code, out, _ = self.svn("cat", "-r", "BASE", c["path"])
        return out if code == 0 else None

    def diff(self, c, context):
        code, out, _ = self.svn("diff", "--internal-diff", "-x", "-U%d" % context, c["path"])
        return out if code == 0 and out else None


# ---------------------------------------------------------------- changed lines
def parse_diff(text):
    """Changed lines of one file in diff order: dicts with t (+/-), s, o, n, block, before, after;
    plus the hunks with numbered lines for printing. Returns (entries, hunks) or None when there is no hunk."""
    lines = text.split("\n")
    entries, hunks = [], []
    o = n = 1
    block = 0
    fresh = True  # the next changed line starts a new block
    i = 0
    seen = False
    while i < len(lines):
        m = HUNK.match(lines[i])
        i += 1
        if not m:
            continue
        seen = True
        o_start, o_len = int(m.group(1)), 1 if m.group(2) is None else int(m.group(2))
        n_start, n_len = int(m.group(3)), 1 if m.group(4) is None else int(m.group(4))
        first_o = o_start + 1 if o_len == 0 else o_start
        first_n = n_start + 1 if n_len == 0 else n_start
        if first_n > n and first_o > o:  # context lies between this hunk and the previous one
            fresh = True
        o, n = max(o, first_o), max(n, first_n)
        hunk = []
        rem_o, rem_n = o_len, n_len
        while i < len(lines) and (rem_o > 0 or rem_n > 0):
            l = lines[i]
            if l.endswith("\r"):
                l = l[:-1]
            t = l[:1]
            if t == "\\":
                i += 1
                continue
            if t == "+" and rem_n > 0:
                if fresh:
                    block, fresh = block + 1, False
                entries.append({"t": "+", "s": l[1:], "o": None, "n": n, "block": block})
                hunk.append(("+", None, n, l[1:]))
                n += 1
                rem_n -= 1
            elif t == "-" and rem_o > 0:
                if fresh:
                    block, fresh = block + 1, False
                entries.append({"t": "-", "s": l[1:], "o": o, "n": None, "block": block, "before": n - 1, "after": n})
                hunk.append(("-", o, None, l[1:]))
                o += 1
                rem_o -= 1
            elif (t == " " or l == "") and rem_o > 0 and rem_n > 0:
                hunk.append((" ", o, n, l[1:]))
                fresh = True
                o += 1
                n += 1
                rem_o -= 1
                rem_n -= 1
            else:
                break
            i += 1
        hunks.append(hunk)
    return (entries, hunks) if seen else None


def fits(entries, old_count, new_count):
    return old_count + sum(1 if e["t"] == "+" else -1 for e in entries) == new_count


def whole_file(lines, t):
    """Entries for a file that is all added or all deleted (no usable VCS diff)."""
    es = []
    for k, s in enumerate(lines, 1):
        e = {"t": t, "s": s, "o": k if t == "-" else None, "n": k if t == "+" else None, "block": 1}
        if t == "-":
            e.update(before=0, after=1)
        es.append(e)
    return es, [[(t, e["o"], e["n"], e["s"]) for e in es]]


def in_range(v, r):
    return v is not None and bool(r) and r.get("od") is not None and r["od"] <= v <= r.get("do", r["od"])


def map_pieces(entries, pieces):
    """The same assignment as mapPieces() in the extension. Returns owner index (into leaves) per entry and the leaves."""
    parents = {p.get("rodic") for p in pieces if p.get("rodic")}
    leaves = [p for p in pieces if p["id"] not in parents]
    owner = [-1] * len(entries)
    for k, p in enumerate(leaves):
        old = p.get("radky") if p.get("strana") == "stara" else p.get("stare")
        new = None if p.get("strana") == "stara" else p.get("radky")
        for i, e in enumerate(entries):
            if owner[i] >= 0:
                continue
            if (e["t"] == "+" and in_range(e["n"], new)) or (e["t"] == "-" and in_range(e["o"], old)):
                owner[i] = k
    for i, e in enumerate(entries):
        if e["t"] != "-" or owner[i] >= 0:
            continue
        for k, p in enumerate(leaves):
            r = p.get("radky")
            if p.get("strana") != "stara" and r and r.get("od") is not None and r["od"] <= e["before"] and e["after"] <= r.get("do", r["od"]):
                owner[i] = k
                break
    for i, e in enumerate(entries):
        if e["t"] != "-" or owner[i] >= 0:
            continue
        found = -1
        j = i + 1
        while j < len(entries) and entries[j]["block"] == e["block"] and found < 0:
            if owner[j] >= 0:
                found = owner[j]
            j += 1
        j = i - 1
        while j >= 0 and entries[j]["block"] == e["block"] and found < 0:
            if owner[j] >= 0:
                found = owner[j]
            j -= 1
        if found >= 0:
            owner[i] = found
    return owner, leaves


def fingerprint(entries):
    return hashlib.sha256("\n".join(e["t"] + e["s"] for e in entries).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- xlsx (values and formulas only)
def read_xlsx(data):
    import io
    sheets = {}
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        text = lambda n: z.read(n).decode("utf-8", "replace") if n in names else ""
        unx = lambda s: s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")
        shared = ["".join(unx(t) for t in re.findall(r"<t\b[^>]*>([\s\S]*?)</t>", si)) for si in re.findall(r"<si\b[^>]*>([\s\S]*?)</si>", text("xl/sharedStrings.xml"))]
        rels = {}
        for tag in re.findall(r"<Relationship\b[^>]*>", text("xl/_rels/workbook.xml.rels")):
            rid, target = re.search(r'\bId="([^"]*)"', tag), re.search(r'\bTarget="([^"]*)"', tag)
            if rid and target:
                rels[rid.group(1)] = target.group(1).lstrip("/") if target.group(1).startswith("/") else "xl/" + target.group(1)
        for tag in re.findall(r"<sheet\b[^>]*>", text("xl/workbook.xml")):
            name, rid = re.search(r'\bname="([^"]*)"', tag), re.search(r'\br:id="([^"]*)"', tag)
            cells = {}
            for attrs, inner in re.findall(r"<c\b([^>]*?)(?:/>|>([\s\S]*?)</c>)", text(rels.get(rid.group(1), "") if rid else "")):
                ref, typ = re.search(r'\br="([^"]*)"', attrs), re.search(r'\bt="([^"]*)"', attrs)
                v, f = re.search(r"<v\b[^>]*>([\s\S]*?)</v>", inner), re.search(r"<f\b[^>]*?(?:/>|>([\s\S]*?)</f>)", inner)
                val = v.group(1) if v else ""
                if typ and typ.group(1) == "s" and val.isdigit() and int(val) < len(shared):
                    val = shared[int(val)]
                elif typ and typ.group(1) == "inlineStr":
                    val = "".join(re.findall(r"<t\b[^>]*>([\s\S]*?)</t>", inner))
                val = unx(val)
                if f and f.group(1):
                    val = "=%s (%s)" % (unx(f.group(1)), val)
                if ref and val != "":
                    cells[ref.group(1)] = val
            sheets[unx(name.group(1)) if name else "?"] = cells
    except Exception as e:  # noqa: BLE001 - any broken workbook is reported the same way
        return None, str(e)
    return sheets, None


def xlsx_changes(old, new):
    a, err_a = read_xlsx(old) if old else ({}, None)
    b, err_b = read_xlsx(new) if new else ({}, None)
    if a is None or b is None:
        return None, err_a or err_b
    out = []
    for name in list(b) + [n for n in a if n not in b]:
        if name not in a:
            out.append((name, "new sheet", []))
        elif name not in b:
            out.append((name, "removed sheet", []))
        else:
            ca, cb = a[name], b[name]
            key = lambda r: (int(re.sub(r"\D", "", r) or 0), re.sub(r"\d", "", r))
            diff = [(r, ca.get(r, ""), cb.get(r, "")) for r in sorted(set(ca) | set(cb), key=key) if ca.get(r, "") != cb.get(r, "")]
            if diff:
                out.append((name, "changed", diff))
    return out, None


# ---------------------------------------------------------------- collecting
def main_dir(args):
    """The same rule as the extension: one folder is the main directory itself; several folders share the
    directory of the .code-workspace file when they all lie under it, otherwise their common parent."""
    folders = [os.path.abspath(f) for f in (args.folder or [])]
    if not folders and os.environ.get("COPY_AGENT_ROOTS"):
        folders = [os.path.abspath(f) for f in os.environ["COPY_AGENT_ROOTS"].split(os.pathsep) if f]
    if args.main:
        main = os.path.abspath(args.main)
    elif len(folders) > 1:
        main = None
        ws_file = os.environ.get("COPY_AGENT_WORKSPACE_FILE")
        try:
            if ws_file:
                d = os.path.dirname(os.path.abspath(ws_file))
                if all(not os.path.relpath(f, d).startswith("..") for f in folders):
                    main = d
            if main is None:
                main = os.path.commonpath(folders)
                if os.path.dirname(main) == main:  # only the drive root in common
                    main = folders[0]
        except ValueError:  # folders on different drives
            main = folders[0]
    else:
        main = folders[0] if folders else os.getcwd()
    return main, folders or [main]


def git_exclude(main):
    """Keep .review/ out of `git status` through the local .git/info/exclude (never committed)."""
    try:
        p = subprocess.run(["git", "rev-parse", "--git-path", "info/exclude"], cwd=main, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0:
            return
        path = os.path.join(main, p.stdout.decode("utf-8", "replace").strip())
        cur = ""
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="replace") as fh:
                cur = fh.read()
        if any(l.strip().strip("/") == ".review" for l in cur.splitlines()):
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(("" if not cur or cur.endswith("\n") else "\n") + "# Review změn: data review se necommitují\n.review/\n")
    except OSError:
        pass


def collect(args):
    main, folders = main_dir(args)
    files = []
    roots = find_roots(folders, main, args.depth)
    for root in roots:
        prov = Git(root["dir"], args.scope) if root["vcs"] == "git" else Svn(root["dir"], args.changelist)
        for c in sorted(prov.changes(), key=lambda c: c["path"]):
            path = (root["prefix"] + "/" if root["prefix"] else "") + c["path"]
            if path == ".review" or path.startswith(".review/") or "/.review/" in path:
                continue
            f = {"path": path, "rel": c["path"], "root": root["name"], "vcs": root["vcs"], "status": c["status"], "kind": "text", "entries": [], "hunks": []}
            if c.get("orig"):
                f["orig"] = (root["prefix"] + "/" if root["prefix"] else "") + c["orig"]
            old, new = prov.old(c), prov.new(c)
            if re.search(r"\.(xlsx|xlsm)$", path, re.I):
                f["kind"] = "xlsx"
                f["sheets"], f["error"] = xlsx_changes(old, new)
                if f["sheets"] is None:
                    f["kind"] = "binary"
            elif is_binary(old) or is_binary(new) or max(len(old or b""), len(new or b"")) > 4 * 1024 * 1024:
                f["kind"] = "binary"
            else:
                old_lines, new_lines = split_lines(decode(old, args.encoding)), split_lines(decode(new, args.encoding))
                raw = prov.diff(c, args.context)
                parsed = parse_diff(decode(raw, args.encoding)) if raw else None
                if parsed and fits(parsed[0], len(old_lines), len(new_lines)):
                    f["entries"], f["hunks"] = parsed
                elif not old_lines:
                    f["entries"], f["hunks"] = whole_file(new_lines, "+")
                elif not new_lines:
                    f["entries"], f["hunks"] = whole_file(old_lines, "-")
                else:
                    f["error"] = "the VCS diff does not match the file content; the extension computes its own diff, fingerprints will not be filled"
            files.append(f)
    return main, roots, files


def cmd_diff(args):
    main, roots, files = collect(args)
    print("# Changes for review. Main directory: %s" % slash(main))
    print("# Working copies: %s" % (", ".join("%s (%s)" % (r["name"], r["vcs"]) for r in roots) or "none found"))
    print("# Lines: '+N' = added, N is the NEW line number; '-N' = removed, N is the OLD line number; ' O/N' = context.")
    if not files:
        print("\nNo changes.")
        return 0
    for f in files:
        plus = sum(1 for e in f["entries"] if e["t"] == "+")
        minus = len(f["entries"]) - plus
        print("\n=== %s [%s, %s%s] +%d -%d" % (f["path"], f["status"], f["vcs"], ", from " + f["orig"] if f.get("orig") else "", plus, minus))
        if f.get("error"):
            print("!! " + f["error"])
        if f["kind"] == "binary":
            print("(binary or too large: do not create a piece for it, the extension shows it on its own)")
            continue
        if f["kind"] == "xlsx":
            for name, state, cells in f["sheets"] or []:
                print('sheet "%s": %s%s' % (name, state, " (%d cells)" % len(cells) if cells else ""))
                for ref, a, b in cells[:40]:
                    print("  %s: %s -> %s" % (ref, a or "(empty)", b or "(empty)"))
                if len(cells) > 40:
                    print("  ... %d more cells" % (len(cells) - 40))
            if not f["sheets"]:
                print("(no cell values or formulas changed; formatting only)")
            continue
        shown = 0
        for hunk in f["hunks"]:
            if shown >= args.max_lines:
                print("... more changes not shown (limit --max-lines %d); read the file for the rest" % args.max_lines)
                break
            print("@@")
            for t, o, n, s in hunk:
                if t == " ":
                    print(" %5d/%-5d %s" % (o, n, s))
                else:
                    print("%s%-11d %s" % (t, n if t == "+" else o, s))
                    shown += 1
    return 0


def cmd_check(args):
    main, _roots, files = collect(args)
    target = os.path.join(main, ".review", "agent.json")
    path = os.path.abspath(args.file) if args.file else target
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except OSError as e:
        print("ERROR: cannot read %s: %s" % (path, e))
        return 1
    except ValueError as e:
        print("ERROR: %s is not valid JSON: %s" % (path, e))
        return 1
    # the validated file itself is not a change to review
    files = [f for f in files if os.path.normcase(os.path.join(main, f["path"])) != os.path.normcase(path)]
    errors, warnings = [], []
    pieces = data.get("kusy")
    if not isinstance(pieces, list) or not pieces:
        print('ERROR: "kusy" must be a non-empty list')
        return 1
    by_path = {f["path"]: f for f in files}
    ids = set()
    for p in pieces:
        pid = p.get("id")
        if not pid or not p.get("soubor"):
            errors.append("piece without id or soubor: %s" % json.dumps(p, ensure_ascii=False)[:120])
            continue
        if pid in ids:
            errors.append("duplicate id %s" % pid)
        ids.add(pid)
        p["soubor"] = slash(p["soubor"])
        if p["soubor"] not in by_path:
            hint = [f["path"] for f in files if f["path"].endswith("/" + p["soubor"]) or f["rel"] == p["soubor"]]
            errors.append("%s: file %s is not among the changes%s" % (pid, p["soubor"], " (did you mean %s?)" % hint[0] if hint else ""))
        if p.get("rodic") and p["rodic"] not in {q.get("id") for q in pieces if q.get("soubor") == p.get("soubor")}:
            errors.append("%s: rodic %s is not a piece of the same file" % (pid, p["rodic"]))
        risk = p.get("riziko")
        if risk:
            level = "".join(ch for ch in unicodedata.normalize("NFD", str(risk.get("uroven", "")).lower()) if not unicodedata.combining(ch))
            level = {"high": "vysoke", "medium": "stredni", "low": "nizke"}.get(level, level)
            if level not in RISKS:
                errors.append("%s: riziko.uroven must be nizke, stredni or vysoke" % pid)
            else:
                risk["uroven"] = level
                if level != "nizke" and not str(risk.get("duvod", "")).strip():
                    warnings.append("%s: riziko %s without duvod" % (pid, level))
        if not str(p.get("titulek", "")).strip():
            warnings.append("%s: missing titulek" % pid)
    covered_total = changed_total = 0
    for f in files:
        mine = [p for p in pieces if p.get("soubor") == f["path"] and p.get("id")]
        if f["kind"] == "binary":
            for p in mine:
                warnings.append("%s: %s is binary or too large; the extension shows it on its own and ignores this piece" % (p["id"], f["path"]))
            continue
        if f["kind"] == "xlsx":
            sheet_names = [name for name, _s, _c in f["sheets"] or []]
            for p in mine:
                if p.get("list") not in sheet_names:
                    errors.append('%s: a piece of a workbook needs "list" with the name of a changed sheet (%s)' % (p["id"], ", ".join(sheet_names) or "no sheet changed"))
            for name, _state, _cells in f["sheets"] or []:
                if not any(p.get("list") == name for p in mine):
                    warnings.append('%s: sheet "%s" has changes but no piece with "list": "%s"' % (f["path"], name, name))
            continue
        if f["kind"] != "text" or not f["entries"]:
            continue
        owner, leaves = map_pieces(f["entries"], mine)
        changed_total += len(owner)
        covered_total += sum(1 for o in owner if o >= 0)
        for k, p in enumerate(leaves):
            own = [e for i, e in enumerate(f["entries"]) if owner[i] == k]
            if not own:
                errors.append("%s: covers no changed line of %s (radky = NEW line numbers of '+' lines, stare = OLD numbers of '-' lines)" % (p["id"], f["path"]))
            else:
                p["otisk"] = fingerprint(own)
        loose = [e for i, e in enumerate(f["entries"]) if owner[i] < 0]
        if loose:
            spans = sorted({("+%d" % e["n"]) if e["t"] == "+" else ("-%d" % e["o"]) for e in loose}, key=lambda s: (int(s[1:]), s[0] != "-"))
            warnings.append("%s: %d changed lines belong to no piece (%s%s); the extension will show them without a description" % (f["path"], len(loose), ", ".join(spans[:12]), ", ..." if len(spans) > 12 else ""))
    described = {p.get("soubor") for p in pieces}
    for f in files:
        if f["path"] not in described and f["kind"] == "text" and f["entries"]:
            warnings.append("%s: changed file without any piece" % f["path"])
    plan = data.get("plan") or []
    planned = set()
    for s in plan:
        for pid in s.get("kusy", []):
            if pid not in ids:
                errors.append("plan step %s refers to unknown piece %s" % (s.get("krok", "?"), pid))
            planned.add(pid)
        if not str(s.get("nazev", "")).strip():
            warnings.append("plan step %s has no nazev" % s.get("krok", "?"))
    if not plan:
        warnings.append('no "plan": the extension will order pieces by file')
    else:
        parent_of = {p["id"]: p.get("rodic") for p in pieces if p.get("id")}
        parents = set(filter(None, parent_of.values()))

        def is_planned(pid):
            for _ in range(10):
                if pid in planned:
                    return True
                pid = parent_of.get(pid)
                if not pid:
                    return False
            return False
        missing = [pid for pid in parent_of if pid not in parents and not is_planned(pid)]
        if missing:
            warnings.append("pieces not in any plan step: %s" % ", ".join(missing[:15]))
    data["verze"] = 2
    data.setdefault("vytvoreno", datetime.datetime.now().astimezone().isoformat(timespec="seconds"))
    for w in warnings:
        print("warning: " + w)
    for e in errors:
        print("ERROR: " + e)
    if not errors and not args.no_write:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        if os.path.normcase(path) != os.path.normcase(target):
            os.remove(path)
        git_exclude(main)
    print("%s: %d pieces, %d plan steps, %d of %d changed lines covered, %d warnings, %d errors%s" % (
        "FAILED" if errors else "OK", len(pieces), len(plan), covered_total, changed_total, len(warnings), len(errors),
        "" if errors or args.no_write else "; written with fingerprints to " + slash(target)))
    return 1 if errors else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("command", choices=["diff", "check"])
    ap.add_argument("--main")
    ap.add_argument("--folder", action="append")
    ap.add_argument("--depth", type=int, default=2)
    ap.add_argument("--scope", choices=["auto", "staged", "working"], default="auto")
    ap.add_argument("--changelist", default="")
    ap.add_argument("--encoding", default="cp1250")
    ap.add_argument("--context", type=int, default=3)
    ap.add_argument("--max-lines", type=int, default=400)
    ap.add_argument("--file")
    ap.add_argument("--no-write", action="store_true")
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    return cmd_diff(args) if args.command == "diff" else cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
