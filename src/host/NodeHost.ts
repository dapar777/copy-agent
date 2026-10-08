import * as fs from "fs/promises";
import * as path from "path";
import { DEFAULT_EXCLUDES, globToRegExp, parseGitignoreNames } from "../protocol/text";
import { applyEol, decodeBytes, DEFAULT_ENCODING, detectEncoding, encodeText, FileEncoding, normalizeEncoding, toLf } from "../tools/encoding";
import { Host, HostPolicy, RunResult } from "./Host";
import { captureScreenshot } from "./screenshot";
import { spawnCommand } from "./spawn";

export const DEFAULT_POLICY: HostPolicy = {
  autoAllow: ["npm test", "npm run build", "npm run lint", "npm run typecheck", "npx tsc", "tsc", "git status", "git diff", "git log", "npx vitest run", "pytest", "python -m pytest", "python -m unittest", "cargo test", "cargo build", "go test", "go build", "dotnet build", "dotnet test"],
  allowPatterns: [],
  deny: ["rm -rf /", "git push --force", "git push -f", "sudo ", "format ", "del /s", "Remove-Item -Recurse", "rmdir /s"],
  protectedPaths: [".env", ".env.*", ".git/**", "node_modules/**", "**/*.pem", "**/*.key"],
};

export interface NodeHostOptions {
  policy?: Partial<HostPolicy>;
  /** headless: potvrzovací dotazy se automaticky schválí (a zalogují) */
  autoConfirm?: boolean;
  log?: (line: string) => void;
  defaultEncoding?: string;
  defaultEol?: "lf" | "crlf";
  fallbackEncoding?: string;
}

/** Host nad Node API – pro CLI harness a testy. */
export class NodeHost implements Host {
  readonly workspaceName: string;
  readonly policy: HostPolicy;
  private readonly autoConfirm: boolean;
  private readonly logger: (line: string) => void;
  private readonly defaultEncoding: string;
  private readonly defaultEol: "lf" | "crlf";
  private readonly fallbackEncoding: string;

  constructor(
    readonly rootPath: string,
    opts: NodeHostOptions = {},
  ) {
    this.rootPath = path.resolve(rootPath);
    this.workspaceName = path.basename(this.rootPath);
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.autoConfirm = opts.autoConfirm ?? false;
    this.logger = opts.log ?? ((l) => console.log(l));
    this.defaultEncoding = opts.defaultEncoding ?? "utf8";
    this.defaultEol = opts.defaultEol ?? "lf";
    this.fallbackEncoding = opts.fallbackEncoding ?? "windows-1250";
  }

  get folders(): { name: string; path: string }[] {
    return [{ name: this.workspaceName, path: this.rootPath }];
  }

  private abs(rel: string): string {
    this.assertInside(rel);
    return path.resolve(this.rootPath, rel.replace(/\\/g, "/").replace(/^\.\//, ""));
  }

  assertInside(rel: string): void {
    const abs = path.resolve(this.rootPath, rel.replace(/\\/g, "/"));
    const back = path.relative(this.rootPath, abs);
    if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`Path "${rel}" is outside the workspace.`);
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(rel: string): Promise<string> {
    const buf = await fs.readFile(this.abs(rel));
    return toLf(decodeBytes(buf, detectEncoding(buf, this.fallbackEncoding).encoding));
  }

  async fileEncoding(rel: string): Promise<FileEncoding> {
    try {
      return detectEncoding(await fs.readFile(this.abs(rel)), this.fallbackEncoding);
    } catch {
      return { ...DEFAULT_ENCODING, encoding: normalizeEncoding(this.defaultEncoding), eol: this.defaultEol };
    }
  }

  async writeFile(rel: string, text: string): Promise<void> {
    const p = this.abs(rel);
    const enc = await this.fileEncoding(rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, encodeText(applyEol(text, enc.eol), enc));
  }

  async appendFile(rel: string, text: string): Promise<void> {
    const p = this.abs(rel);
    const enc = await this.fileEncoding(rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, encodeText(applyEol(text, enc.eol), { ...enc, bom: false }));
  }

  deleteFile(rel: string): Promise<void> {
    return fs.rm(this.abs(rel), { force: true });
  }

  async moveFile(from: string, to: string): Promise<void> {
    const dest = this.abs(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(this.abs(from), dest);
  }

  async listFiles(glob: string, max = 5000): Promise<string[]> {
    const ignore = new Set(DEFAULT_EXCLUDES);
    try {
      parseGitignoreNames(await fs.readFile(path.join(this.rootPath, ".gitignore"), "utf8")).forEach((n) => ignore.add(n));
    } catch {
      /* bez .gitignore */
    }
    const re = globToRegExp(glob);
    const out: string[] = [];
    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      if (out.length >= max) return;
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (ignore.has(e.name) || ignore.has(rel)) continue;
          await walk(path.join(dirAbs, e.name), rel);
        } else if (e.isFile()) {
          if (ignore.has(rel)) continue;
          if (re.test(rel)) out.push(rel);
        }
      }
    };
    await walk(this.rootPath, "");
    return out.sort();
  }

  run(command: string, cwdRel: string, timeoutMs: number, probeMs?: number, signal?: AbortSignal): Promise<RunResult> {
    const cwd = cwdRel && cwdRel !== "." ? this.abs(cwdRel) : this.rootPath;
    return spawnCommand(command, cwd, timeoutMs, probeMs, signal);
  }

  async diagnostics(): Promise<string> {
    return "";
  }

  screenshot(rel: string, opts: { window?: string }): Promise<{ width: number; height: number; window?: string }> {
    return captureScreenshot(this.abs(rel), opts);
  }

  absolutePath(rel: string): string {
    return this.abs(rel);
  }

  async confirmCommand(command: string): Promise<boolean> {
    if (this.autoConfirm) this.logger(`[auto-approved command] ${command}`);
    return this.autoConfirm;
  }

  async confirmDelete(rel: string): Promise<boolean> {
    if (this.autoConfirm) this.logger(`[auto-approved delete] ${rel}`);
    return this.autoConfirm;
  }

  log(line: string): void {
    this.logger(line);
  }
}
