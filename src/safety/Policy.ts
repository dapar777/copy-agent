import { HostPolicy } from "../host/Host";
import { matchesAny } from "../protocol/text";

export function isDeniedCommand(cmd: string, policy: HostPolicy): string | null {
  const hit = policy.deny.find((d) => cmd.toLowerCase().includes(d.toLowerCase()));
  return hit ?? null;
}

export function isAutoAllowedCommand(cmd: string, policy: HostPolicy): boolean {
  const c = cmd.trim();
  for (const p of policy.allowPatterns ?? []) {
    try {
      if (new RegExp(p).test(c)) return true;
    } catch {
      /* neplatný regex ignorujeme */
    }
  }
  const lower = c.toLowerCase();
  // příkaz smí být spojen jen s dalšími povolenými příkazy (&&, ;, ||)
  const parts = lower.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => policy.autoAllow.some((a) => p === a.toLowerCase() || p.startsWith(a.toLowerCase() + " ")));
}

export function isProtectedPath(rel: string, policy: HostPolicy): boolean {
  return matchesAny(rel, policy.protectedPaths);
}
