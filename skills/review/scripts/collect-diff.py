#!/usr/bin/env python3
"""Collect the uncommitted git diff with statistics and simple warnings for a code review.

Usage: python collect-diff.py [path ...]   (paths limit the diff; default: whole repository)
Prints: stat summary, warnings (possible secrets, debug prints, TODO/FIXME, huge files), then the diff.
"""
import re
import subprocess
import sys


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
    return r.stdout


def main():
    paths = sys.argv[1:]
    stat = git("diff", "--stat", "HEAD", "--", *paths) if paths else git("diff", "--stat", "HEAD")
    diff = git("diff", "HEAD", "--", *paths) if paths else git("diff", "HEAD")
    untracked = git("ls-files", "--others", "--exclude-standard").split()
    print("== STAT ==")
    print(stat.strip() or "(no tracked changes)")
    if untracked:
        print("== UNTRACKED (not in the diff) ==")
        for u in untracked[:50]:
            print("  " + u)
    warnings = []
    secret = re.compile(r"(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['\"][^'\"]{8,}", re.I)
    debug = re.compile(r"^\+.*\b(console\.log|print\(|debugger;|binding\.pp|pdb\.set_trace)", re.M)
    todo = re.compile(r"^\+.*\b(TODO|FIXME|XXX|HACK)\b", re.M)
    for m in secret.finditer(diff):
        warnings.append("possible secret in diff: " + m.group(0)[:60])
    for m in debug.finditer(diff):
        warnings.append("debug leftover: " + m.group(0).strip()[:100])
    for m in todo.finditer(diff):
        warnings.append("marker: " + m.group(0).strip()[:100])
    for line in stat.splitlines():
        m = re.match(r"\s*(\S+)\s*\|\s*(\d+)", line)
        if m and int(m.group(2)) > 500:
            warnings.append(f"large change: {m.group(1)} ({m.group(2)} lines)")
    print("== WARNINGS ==")
    print("\n".join("  " + w for w in warnings) if warnings else "  (none)")
    print("== DIFF ==")
    print(diff if len(diff) < 120000 else diff[:120000] + "\n... (diff truncated; read files with <read> for the rest)")


if __name__ == "__main__":
    main()
