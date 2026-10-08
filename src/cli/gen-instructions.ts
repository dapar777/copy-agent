/**
 * Vygeneruje instrukce pro agenta v Copilotu (Teams) z téže tabulky nástrojů jako parser:
 *   node dist/gen-instructions.js            → vypíše na stdout
 *   node dist/gen-instructions.js --write    → zapíše copilot-agent/INSTRUCTIONS.md (+ délku)
 */
import * as fs from "fs";
import * as path from "path";
import { buildAgentInstructions } from "../protocol/prompt";

const text = buildAgentInstructions();
if (process.argv.includes("--write")) {
  const out = path.resolve(__dirname, "..", "copilot-agent", "INSTRUCTIONS.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text + "\n", "utf8");
  console.log(`${out}: ${text.length} characters (limit 8000)`);
} else {
  process.stdout.write(text + "\n");
}
