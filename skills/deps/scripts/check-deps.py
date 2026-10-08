#!/usr/bin/env python3
"""List outdated dependencies across all manifests in the repository.

Usage: python check-deps.py [root]
Supports: package.json (npm outdated + npm audit), requirements*.txt / pyproject.toml (pip list --outdated),
Cargo.toml (cargo outdated if installed), go.mod (go list -m -u all). Splits npm/pip updates into
safe (patch/minor) and major. Missing tools are reported, never fatal.
"""
import json
import os
import re
import subprocess
import sys


def run(cmd, cwd):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True, timeout=300)
        return r.stdout + (("\n" + r.stderr) if r.stderr.strip() else "")
    except Exception as e:  # noqa: BLE001
        return f"(failed: {e})"


def major(v):
    m = re.match(r"\D*(\d+)", v or "")
    return int(m.group(1)) if m else -1


def npm(dir_):
    print(f"== npm: {dir_} ==")
    out = run("npm outdated --json", dir_)
    try:
        data = json.loads(out or "{}")
    except json.JSONDecodeError:
        print(out[:3000])
        return
    safe, majors = [], []
    for name, info in data.items():
        cur, latest = info.get("current", "?"), info.get("latest", "?")
        (majors if major(cur) != major(latest) else safe).append(f"  {name}: {cur} -> {latest}")
    print("safe (patch/minor):\n" + ("\n".join(safe) or "  (none)"))
    print("major:\n" + ("\n".join(majors) or "  (none)"))
    audit = run("npm audit --json", dir_)
    try:
        a = json.loads(audit)
        vulns = a.get("metadata", {}).get("vulnerabilities", {})
        print("audit: " + ", ".join(f"{k}={v}" for k, v in vulns.items() if v))
    except json.JSONDecodeError:
        print("audit: " + audit[:500].strip())


def pip(dir_):
    print(f"== pip: {dir_} ==")
    out = run("python -m pip list --outdated --format=json", dir_)
    try:
        data = json.loads(out or "[]")
    except json.JSONDecodeError:
        print(out[:3000])
        return
    safe, majors = [], []
    for p in data:
        (majors if major(p["version"]) != major(p["latest_version"]) else safe).append(f"  {p['name']}: {p['version']} -> {p['latest_version']}")
    print("safe (patch/minor):\n" + ("\n".join(safe) or "  (none)"))
    print("major:\n" + ("\n".join(majors) or "  (none)"))


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    found = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git", "dist", "out", "build", ".venv", "venv", "target")]
        if "package.json" in filenames:
            found = True
            npm(dirpath)
        if any(f.startswith("requirements") and f.endswith(".txt") for f in filenames) or "pyproject.toml" in filenames:
            found = True
            pip(dirpath)
        if "Cargo.toml" in filenames:
            found = True
            print(f"== cargo: {dirpath} ==\n" + run("cargo outdated --root-deps-only", dirpath)[:4000])
        if "go.mod" in filenames:
            found = True
            print(f"== go: {dirpath} ==\n" + run("go list -m -u all", dirpath)[:4000])
    if not found:
        print("no dependency manifests found")


if __name__ == "__main__":
    main()
