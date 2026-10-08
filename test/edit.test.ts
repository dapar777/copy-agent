import { describe, expect, it } from "vitest";
import { applyHunks, parseHunks } from "../src/protocol/edit";
import { applySection, outline } from "../src/protocol/section";
import { diffLines, diffStats } from "../src/protocol/diff";

describe("hunks", () => {
  it("parses several hunks and applies exact matches", () => {
    const hunks = parseHunks("<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nbaz\n=======\nqux\n>>>>>>> REPLACE");
    expect(hunks).toHaveLength(2);
    const r = applyHunks("foo\nbaz\n", hunks);
    expect(r.content).toBe("bar\nqux\n");
    expect(r.applied).toBe(2);
  });

  it("matches ignoring whitespace and reindents, refuses ambiguous matches", () => {
    const r = applyHunks("  a = 1\n  b = 2\n", parseHunks("<<<<<<< SEARCH\na = 1\n=======\na = 10\n>>>>>>> REPLACE"));
    expect(r.content).toBe("  a = 10\n  b = 2\n");
    const amb = applyHunks("x\ny\nx\n", parseHunks("<<<<<<< SEARCH\nx\n=======\nz\n>>>>>>> REPLACE"));
    expect(amb.applied).toBe(0);
    expect(amb.failures[0].reason).toMatch(/ambiguous/);
  });

  it("strips line-number prefixes copied from <read> and explains a miss", () => {
    const r = applyHunks("const a = 1;\nconst b = 2;\n", parseHunks("<<<<<<< SEARCH\n 1| const a = 1;\n=======\nconst a = 3;\n>>>>>>> REPLACE"));
    expect(r.content).toBe("const a = 3;\nconst b = 2;\n");
    expect(r.notes[0]).toMatch(/line-number prefixes/);
    const miss = applyHunks("const a = 1;\nconst b = 2;\n", parseHunks("<<<<<<< SEARCH\nconst a = 1;\nconst c = 3;\n=======\nx\n>>>>>>> REPLACE"));
    expect(miss.failures[0].reason).toMatch(/resembles line 1/);
    const nothing = applyHunks("const a = 1;\n", parseHunks("<<<<<<< SEARCH\nzzz\n=======\nx\n>>>>>>> REPLACE"));
    expect(nothing.failures[0].reason).toMatch(/No line of the file resembles/);
  });

  it("keeps CRLF line endings", () => {
    const r = applyHunks("a\r\nb\r\n", parseHunks("<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE"));
    expect(r.content).toBe("a\r\nc\r\n");
  });
});

describe("sections", () => {
  const doc = "# Title\n\nintro\n\n## A\n\ntext a\n\n## B\n\ntext b\n";
  it("replaces a section body keeping the heading", () => {
    const r = applySection(doc, "## A", "new a");
    expect(r.content).toBe("# Title\n\nintro\n\n## A\n\nnew a\n\n## B\n\ntext b\n");
    expect(r.replaced?.heading).toBe("## A");
  });
  it("inserts a new section after another", () => {
    const r = applySection(doc, "A", "## A2\n\nmore", "after");
    expect(r.content).toContain("text a\n\n## A2\n\nmore\n\n## B");
  });
  it("reports unknown and ambiguous headings", () => {
    expect(applySection(doc, "## Z", "x").error).toMatch(/not found/);
    expect(applySection(doc + "\n## A\n\nagain\n", "A", "x").error).toMatch(/ambiguous/);
  });
  it("outlines markdown and code", () => {
    expect(outline(doc, "d.md")).toContain("L5: ## A");
    const code = "import x\n\nexport function foo() {}\nclass Bar {\n  method(a: number) {\n  }\n}\n";
    const o = outline(code, "a.ts");
    expect(o).toContain("L3: export function foo() {}");
    expect(o).toContain("L5:   method(a: number) {");
  });
});

describe("diff", () => {
  it("finds hunks and stats", () => {
    const hunks = diffLines("a\nb\nc\n", "a\nx\nc\nd\n");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({ oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["x"] });
    expect(diffStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  });
});
