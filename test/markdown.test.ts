import { describe, expect, test } from "bun:test";
import { normalizeMarkdown, renderMarkdown, type ResolvedInclude } from "../src/markdown.ts";
import type { Contribution, Diagnostic } from "../src/types.ts";

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function contribution(slot: string, path: string, content: string, pack = "base"): Contribution {
  return { pack, slot, path, content };
}

describe("normalizeMarkdown", () => {
  test("uses LF and exactly one terminal newline", () => {
    expect(normalizeMarkdown("one\r\ntwo\r\n\r\n")).toBe("one\ntwo\n");
    expect(normalizeMarkdown("")).toBe("\n");
  });
});

describe("slots", () => {
  test("fills ordered contributions, removes empty slots, and records a trace", async () => {
    const result = await renderMarkdown({
      templatePath: "templates/default.md",
      content: "# Guide\r\n\r\n<!-- agentsmith:slot tools -->\r\n<!-- agentsmith:slot empty -->\r\n",
      contributions: [contribution("tools", "packs/a/10.md", "first\n\n"), contribution("tools", "packs/b/20.md", "\nsecond", "other")],
    });

    expect(result.content).toBe("# Guide\n\nfirst\n\nsecond\n");
    expect(result.trace).toEqual({
      template: "templates/default.md",
      includes: [],
      slots: {
        tools: ["packs/a/10.md", "packs/b/20.md"],
        empty: [],
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("reports an unfilled required slot", async () => {
    const result = await renderMarkdown({
      templatePath: "skill/SKILL.md",
      content: "<!-- agentsmith:required-slot tracker -->",
    });
    expect(codes(result.diagnostics)).toContain("required-slot-empty");
    expect(result.content).toBe("\n");
  });

  test("reports duplicate slots and contributions whose slot is absent", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: ["<!-- agentsmith:slot tools -->", "<!-- agentsmith:required-slot tools -->"].join("\n"),
      contributions: [contribution("missing", "packs/base/10.md", "lost")],
    });
    expect(codes(result.diagnostics)).toContain("slot-duplicate");
    expect(codes(result.diagnostics)).toContain("contribution-slot-missing");
  });

  test("warns when a snippet heading competes with its surrounding heading", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "## Tools\n<!-- agentsmith:slot tools -->",
      contributions: [contribution("tools", "packs/base/10.md", "## Git\nText")],
    });
    expect(codes(result.diagnostics)).toContain("snippet-heading-level");
    expect(result.content).toBe("## Tools\n## Git\nText\n");
  });
});

describe("directive recognition", () => {
  test("recognizes directives only as complete column-zero lines outside fences", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: [
        "```md",
        "<!-- agentsmith:slot example -->",
        "```",
        "  <!-- agentsmith:slot indented -->",
        "prefix <!-- agentsmith:include thing.md -->",
        "<!-- agentsmith:unknown nope -->",
        "<!-- agentsmith:slot real -->",
      ].join("\n"),
      contributions: [contribution("real", "pack/real.md", "rendered")],
    });

    expect(result.content).toContain("<!-- agentsmith:slot example -->");
    expect(result.content).toContain("rendered");
    expect(codes(result.diagnostics).filter((code) => code === "directive-position")).toHaveLength(2);
    expect(codes(result.diagnostics)).toContain("directive-malformed");
  });

  test("ignores headings and directives in tilde and backtick fences", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: ["~~~", "# not structural", "<!-- agentsmith:required-slot nope -->", "~~~", "````", "<!-- agentsmith:include absent.md -->", "````"].join("\n"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.content).toContain("<!-- agentsmith:required-slot nope -->");
  });
});

describe("includes", () => {
  test("expands recursive includes and records resolved paths", async () => {
    const sources = new Map<string, ResolvedInclude>([
      ["intro.md", { path: "/source/partials/intro.md", content: "Intro\n<!-- agentsmith:include detail.md -->" }],
      ["detail.md", { path: "/source/partials/detail.md", content: "Details" }],
    ]);
    const result = await renderMarkdown({
      templatePath: "/source/templates/default.md",
      content: "Before\n<!-- agentsmith:include intro.md -->\nAfter",
      resolveInclude: (id) => sources.get(id),
    });
    expect(result.content).toBe("Before\nIntro\nDetails\nAfter\n");
    expect(result.trace.includes).toEqual(["/source/partials/intro.md", "/source/partials/detail.md"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("expands includes inside contributions", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:slot tools -->",
      contributions: [contribution("tools", "pack/10.md", "A\n<!-- agentsmith:include common.md -->")],
      resolveInclude: () => ({ path: "partials/common.md", content: "B" }),
    });
    expect(result.content).toBe("A\nB\n");
    expect(result.trace.includes).toEqual(["partials/common.md"]);
  });

  test("reports missing includes, resolver failures, and absent resolvers", async () => {
    const missing = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:include absent.md -->",
      resolveInclude: () => undefined,
    });
    const failed = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:include broken.md -->",
      resolveInclude: () => {
        throw new Error("unreadable");
      },
    });
    const noResolver = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:include absent.md -->",
    });
    expect(codes(missing.diagnostics)).toContain("include-missing");
    expect(codes(failed.diagnostics)).toContain("include-resolution-failed");
    expect(codes(noResolver.diagnostics)).toContain("include-missing-resolver");
  });

  test("rejects traversal and malformed Source IDs before calling the resolver", async () => {
    let calls = 0;
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: [
        "<!-- agentsmith:include ../secret.md -->",
        "<!-- agentsmith:include /absolute.md -->",
        "<!-- agentsmith:include project:a//b.md -->",
        "<!-- agentsmith:include no-extension -->",
      ].join("\n"),
      resolveInclude: () => {
        calls += 1;
        return undefined;
      },
    });
    expect(calls).toBe(0);
    expect(codes(result.diagnostics).filter((code) => code === "include-invalid")).toHaveLength(4);
  });

  test("detects include cycles by canonical resolved path", async () => {
    const sources = new Map<string, ResolvedInclude>([
      ["a.md", { path: "/partials/a.md", content: "<!-- agentsmith:include b.md -->" }],
      ["b.md", { path: "/partials/b.md", content: "<!-- agentsmith:include a.md -->" }],
    ]);
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:include a.md -->",
      resolveInclude: (id) => sources.get(id),
    });
    expect(codes(result.diagnostics)).toContain("include-cycle");
    expect(result.diagnostics.find((item) => item.code === "include-cycle")?.message).toContain("/partials/a.md -> /partials/b.md -> /partials/a.md");
  });
});

describe("partial headings", () => {
  test("rebases a headed partial beneath the nearest preceding heading", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "# Root\n## Parent\n<!-- agentsmith:include section.md -->",
      resolveInclude: () => ({
        path: "partials/section.md",
        content: "# Child\n## Grandchild\n\n```\n# code\n```",
      }),
    });
    expect(result.content).toBe("# Root\n## Parent\n### Child\n#### Grandchild\n\n```\n# code\n```\n");
    expect(result.diagnostics).toEqual([]);
  });

  test("inserts body-only partials verbatim", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "# Root\n<!-- agentsmith:include body.md -->",
      resolveInclude: () => ({ path: "partials/body.md", content: "Body\n\nMore" }),
    });
    expect(result.content).toBe("# Root\nBody\n\nMore\n");
    expect(result.diagnostics).toEqual([]);
  });

  test("carries outer heading context through a body partial's nested include", async () => {
    const sources = new Map<string, ResolvedInclude>([
      [
        "body.md",
        {
          path: "partials/body.md",
          content: "<!-- agentsmith:include nested-section.md -->\nBody tail",
        },
      ],
      [
        "nested-section.md",
        {
          path: "partials/nested-section.md",
          content: "# Nested child\nNested body",
        },
      ],
    ]);
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "## Outer\n<!-- agentsmith:include body.md -->",
      resolveInclude: (id) => sources.get(id),
    });

    expect(result.content).toBe("## Outer\n### Nested child\nNested body\nBody tail\n");
    expect(result.diagnostics).toEqual([]);
  });

  test("reports headed partials with no parent, a non-H1 start, or excessive depth", async () => {
    const noParent = await renderMarkdown({
      templatePath: "template.md",
      content: "<!-- agentsmith:include partial.md -->",
      resolveInclude: () => ({ path: "partial.md", content: "# Child" }),
    });
    const badStart = await renderMarkdown({
      templatePath: "template.md",
      content: "# Root\n<!-- agentsmith:include partial.md -->",
      resolveInclude: () => ({ path: "partial.md", content: "Text\n# Child" }),
    });
    const tooDeep = await renderMarkdown({
      templatePath: "template.md",
      content: "##### Parent\n<!-- agentsmith:include partial.md -->",
      resolveInclude: () => ({ path: "partial.md", content: "# Child\n## Too deep" }),
    });
    expect(codes(noParent.diagnostics)).toContain("partial-heading-parent-missing");
    expect(codes(badStart.diagnostics)).toContain("partial-heading-start");
    expect(codes(tooDeep.diagnostics)).toContain("partial-heading-too-deep");
  });

  test("rejects Setext headings in partials but ignores fence content", async () => {
    const result = await renderMarkdown({
      templatePath: "template.md",
      content: "# Root\n<!-- agentsmith:include partial.md -->",
      resolveInclude: () => ({
        path: "partial.md",
        content: "Text\n====\n\n```\nCode\n----\n```",
      }),
    });
    expect(codes(result.diagnostics).filter((code) => code === "partial-setext-heading")).toHaveLength(1);
  });
});
