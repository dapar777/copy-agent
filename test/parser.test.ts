import { describe, expect, it } from "vitest";
import { mergeParts, parseReply } from "../src/protocol/parser";

describe("parseReply", () => {
  it("parses a mixed block with self-closing and body actions inside a four-backtick fence", () => {
    const reply = `Sure.\n\n\`\`\`\`\n<copy turn="3" session="ab12">\n<think>need context</think>\n<read path="src/a.ts" lines="1-40"/>\n<grep pattern="foo|bar" glob="src/**/*.ts"/>\n<edit path="src/b.ts">\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n</edit>\n<write path="src/new.ts">\nexport const y = \`tpl \${x}\`;\n</write>\n<run timeout="60">npm test</run>\n<status>working</status>\n</copy>\n\`\`\`\`\nDone.`;
    const p = parseReply(reply);
    expect(p.errors).toEqual([]);
    expect(p.turn).toBe(3);
    expect(p.session).toBe("ab12");
    expect(p.prose).toBe("Sure.");
    expect(p.actions.map((a) => a.tool)).toEqual(["read", "grep", "edit", "write", "run", "status"]);
    expect(p.actions[0].attrs).toEqual({ path: "src/a.ts", lines: "1-40" });
    expect(p.actions[2].body).toContain("<<<<<<< SEARCH");
    expect(p.actions[3].body).toBe("export const y = `tpl ${x}`;");
    expect(p.actions[4].body).toBe("npm test");
    expect(p.truncated).toBeFalsy();
  });

  it("survives an inner ``` fence that broke the outer ``` fence (chat rendering)", () => {
    const reply = "```\n<copy turn=\"1\">\n<write path=\"README.md\">\n# T\n\n```js\nconsole.log(1)\n```\n\ntext\n</write>\n</copy>\n```";
    const p = parseReply(reply, 1);
    expect(p.errors).toEqual([]);
    expect(p.actions[0].body).toBe("# T\n\n```js\nconsole.log(1)\n```\n\ntext");
  });

  it("takes the right block when an example precedes it", () => {
    const p = parseReply('Example: <copy turn="1"><read path="x"/></copy>\n````\n<copy turn="2">\n<ls path="src"/>\n</copy>\n````', 2);
    expect(p.turn).toBe(2);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].tool).toBe("ls");
  });

  it("normalises typographic quotes in attributes", () => {
    const p = parseReply("<copy turn=“4”>\n<read path=„src/a.ts” />\n</copy>");
    expect(p.turn).toBe(4);
    expect(p.actions[0].attrs.path).toBe("src/a.ts");
  });

  it("reports a missing block", () => {
    const p = parseReply("I cannot help with that.");
    expect(p.errors[0]).toMatch(/No <copy/);
    expect(p.actions).toEqual([]);
  });

  it("marks a cut-off reply: complete actions kept, the truncated one skipped and named", () => {
    const p = parseReply('<copy turn="1">\n<read path="a"/>\n<edit path="b.ts">\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n</edit>\n<write path="c.ts">\nabc');
    expect(p.truncated).toBe(true);
    expect(p.truncatedAction).toEqual({ tool: "write", attrs: { path: "c.ts" }, index: 2 });
    expect(p.actions.map((a) => a.tool)).toEqual(["read", "edit"]);
    expect(p.errors.some((e) => /cut off/.test(e))).toBe(true);
  });

  it("reports unknown actions and missing closing tag", () => {
    const p = parseReply('<copy turn="1">\n<read path="a"/>\n<fetch url="x"/>\n');
    expect(p.errors.some((e) => /Unknown action <fetch>/.test(e))).toBe(true);
    expect(p.truncated).toBe(true);
    expect(p.actions.map((a) => a.tool)).toEqual(["read"]);
  });

  it("does not treat tags inside a body as actions", () => {
    const p = parseReply('<copy turn="1">\n<write path="a.html">\n<div><read path="nope"/></div>\n</write>\n</copy>');
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].body).toBe('<div><read path="nope"/></div>');
  });

  it("flags missing required attributes and empty bodies", () => {
    const p = parseReply('<copy turn="1">\n<read/>\n<run></run>\n</copy>');
    expect(p.errors).toContain('<read> is missing required attribute "path".');
    expect(p.errors).toContain("<run> has an empty body.");
  });

  it("keeps a </write> line inside an <edit> body as content", () => {
    const p = parseReply('<copy turn="4">\n<edit path="README.md">\n<<<<<<< SEARCH\na\n=======\nb\n```\n</write>\n>>>>>>> REPLACE\n</edit>\n<run>npm test</run>\n</copy>');
    expect(p.actions.map((a) => a.tool)).toEqual(["edit", "run"]);
    expect(p.actions[0].body).toContain("</write>");
    expect(p.errors).toEqual([]);
  });

  it("skips an edit closed with </write> by mistake and still parses the next action", () => {
    const p = parseReply('<copy turn="2">\n<edit path="a.ts">\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n</write>\n<read path="b.ts"/>\n</copy>');
    expect(p.actions.map((a) => a.tool)).toEqual(["read"]);
    expect(p.errors[0]).toMatch(/closed with <\/write> instead of <\/edit>.*SKIPPED/);
  });

  it("ignores an echoed <copy-results> block", () => {
    const p = parseReply('<copy-results turn="1"><result of="read"/></copy-results>\n<copy turn="2"><done>ok</done></copy>');
    expect(p.turn).toBe(2);
    expect(p.actions[0].tool).toBe("done");
  });

  it("decodes HTML-escaped protocol tags (chat rendered them as text)", () => {
    const p = parseReply('&lt;copy turn="2"&gt;\n&lt;read path="a.ts"/&gt;\n&lt;/copy&gt;', 2);
    expect(p.actions.map((a) => a.tool)).toEqual(["read"]);
    expect(p.notes[0]).toMatch(/HTML-escaped/);
  });

  it("parses part attributes and merges parts in order", () => {
    const a = parseReply('<copy turn="3" part="2/2">\n<run>npm test</run>\n<done>ok</done>\n</copy>', 3);
    const b = parseReply('<copy turn="3" part="1/2">\n<edit path="x.ts">\n<<<<<<< SEARCH\n1\n=======\n2\n>>>>>>> REPLACE\n</edit>\n</copy>', 3);
    expect(a.part).toEqual({ index: 2, total: 2 });
    const m = mergeParts([a, b]);
    expect(m.actions.map((x) => `${x.index}:${x.tool}`)).toEqual(["0:edit", "1:run", "2:done"]);
    expect(m.errors).toEqual([]);
  });
});

describe("body clean-up", () => {
  it("removes CDATA wrappers and tells the model", () => {
    const p = parseReply('<copy turn="1">\n<write path="docs/a.md"><![CDATA[\n# A\n\ntext with ]]]]><![CDATA[> inside\n]]></write>\n<done><![CDATA[Hotovo.]]></done>\n</copy>', 1);
    expect(p.actions.map((a) => a.body)).toEqual(["# A\n\ntext with ]]> inside", "Hotovo."]);
    expect(p.notes[0]).toMatch(/CDATA/);
  });

  it("decodes a fully HTML-escaped body but keeps real HTML", () => {
    const p = parseReply('<copy turn="1">\n<write path="a.md">\nuse `a &gt; b` &amp; done\n</write>\n<write path="a.html">\n<p>&lt;b&gt; &amp; x</p>\n</write>\n<run>echo a &gt; out.txt &amp;&amp; type out.txt</run>\n</copy>', 1);
    expect(p.actions[0].body).toBe("use `a > b` & done");
    expect(p.actions[1].body).toBe("<p>&lt;b&gt; &amp; x</p>");
    expect(p.actions[2].body).toBe("echo a > out.txt && type out.txt");
  });

  it("unwraps a write body wrapped in a code fence and decodes escaped hunk markers", () => {
    const p = parseReply('<copy turn="1">\n<write path="a.py">\n```python\nprint(1)\n```\n</write>\n<edit path="b.ts">\n&lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH\nx\n=======\ny\n&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE\n</edit>\n</copy>', 1);
    expect(p.actions[0].body).toBe("print(1)");
    expect(p.actions[1].body).toBe("<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE");
  });
});
