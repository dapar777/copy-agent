import * as fs from "fs";
import * as path from "path";
import { looksLikeReply } from "../protocol/detect";
import { globToRegExp } from "../protocol/text";

export interface FileReplyOptions {
  dirs: string[];
  pattern: string;
  pollMs: number;
  lastPrompt: string;
  onReply: (text: string, file: string) => void;
  log?: (line: string) => void;
  readFile?: (p: string) => string;
}

interface Seen {
  size: number;
  mtime: number;
  done?: boolean;
  tries?: number;
}

/**
 * Alternativa ke schránce: odpověď modelu přijde jako NOVÝ nebo přepsaný soubor ve sledované složce
 * (chaty, které umí dát soubor ke stažení). Soubor se přečte, až se přestane měnit.
 */
export class FileReplyWatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly seen = new Map<string, Seen>();
  private readonly re: RegExp;
  private busy = false;
  private readonly dirs: string[];

  constructor(private readonly opts: FileReplyOptions) {
    this.re = globToRegExp(opts.pattern || "*.{xml,md,txt}");
    this.dirs = opts.dirs.filter((d, i) => d && opts.dirs.findIndex((x) => x.toLowerCase() === d.toLowerCase()) === i);
  }

  start(): void {
    this.stop();
    for (const f of this.scan()) this.seen.set(f.key, { size: f.size, mtime: f.mtime, done: true });
    this.timer = setInterval(() => void this.tick(), Math.max(200, this.opts.pollMs));
    this.opts.log?.(`Hlídám ${this.dirs.join("; ")} (${this.opts.pattern}) pro odpověď v souboru.`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private scan(): { key: string; path: string; name: string; size: number; mtime: number }[] {
    const out: { key: string; path: string; name: string; size: number; mtime: number }[] = [];
    for (const dir of this.dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!this.re.test(name)) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) out.push({ key: full.toLowerCase(), path: full, name, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* soubor mezitím zmizel */
        }
      }
    }
    return out;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const f of this.scan()) {
        const prev = this.seen.get(f.key);
        const changed = !prev || prev.size !== f.size || prev.mtime !== f.mtime;
        if (prev?.done && !changed) continue;
        if (changed) {
          this.seen.set(f.key, { size: f.size, mtime: f.mtime, tries: 0 });
          continue;
        }
        if (f.size === 0) continue;
        let text: string;
        try {
          text = (this.opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8")))(f.path).replace(/^﻿/, "");
        } catch (e) {
          prev.tries = (prev.tries ?? 0) + 1;
          if (prev.tries >= 10) {
            prev.done = true;
            this.opts.log?.(`Soubor ${f.name} nejde přečíst (${(e as Error).message}), vzdávám to.`);
          }
          continue;
        }
        prev.done = true;
        if (looksLikeReply(text, this.opts.lastPrompt)) {
          this.opts.log?.(`Odpověď převzata ze souboru ${f.name} (${text.length} znaků).`);
          this.stop();
          this.opts.onReply(text, f.path);
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
