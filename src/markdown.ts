import type {
  Contribution,
  Diagnostic,
  RenderResult,
  RenderTrace,
} from "./types.ts";

export interface ResolvedInclude {
  path: string;
  content: string;
}

export type IncludeResolver = (
  sourceId: string,
  fromPath: string,
) => ResolvedInclude | undefined | Promise<ResolvedInclude | undefined>;

export interface RenderMarkdownOptions {
  content: string;
  templatePath: string;
  contributions?: readonly Contribution[];
  resolveInclude?: IncludeResolver;
}

interface Heading {
  level: number;
  line: number;
}

interface RenderContext {
  diagnostics: Diagnostic[];
  trace: RenderTrace;
  resolveInclude?: IncludeResolver;
  includeStack: string[];
}

type Directive =
  | { kind: "slot"; name: string }
  | { kind: "required-slot"; name: string }
  | { kind: "include"; name: string };

const DIRECTIVE = /^<!-- agentsmith:(slot|required-slot|include) ([^\s]+) -->$/;
const AGENTSMITH_DIRECTIVE = /<!--\s*agentsmith:/;
const ATX_HEADING = /^(#{1,6})(?:[ \t]+|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;

/** Normalize generated Markdown without otherwise reformatting authored content. */
export function normalizeMarkdown(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

/**
 * Expand includes, fill slots, validate composition, and return deterministic
 * Markdown. Source lookup remains outside this module so callers can enforce
 * source-root and symlink policy.
 */
export async function renderMarkdown(
  options: RenderMarkdownOptions,
): Promise<RenderResult> {
  const diagnostics: Diagnostic[] = [];
  const trace: RenderTrace = {
    template: options.templatePath,
    includes: [],
    slots: {},
  };
  const context: RenderContext = {
    diagnostics,
    trace,
    resolveInclude: options.resolveInclude,
    includeStack: [options.templatePath],
  };

  const expanded = await expandIncludes(
    splitLines(options.content),
    options.templatePath,
    context,
    false,
  );
  const filled = await fillSlots(
    expanded,
    options.templatePath,
    options.contributions ?? [],
    context,
  );

  findRemainingDirectives(filled, options.templatePath, diagnostics);

  return {
    content: normalizeMarkdown(filled.join("\n")),
    trace,
    diagnostics,
  };
}

async function expandIncludes(
  lines: string[],
  path: string,
  context: RenderContext,
  isPartial: boolean,
  inheritedHeading?: Heading,
): Promise<string[]> {
  if (isPartial) validateNoSetextHeadings(lines, path, context.diagnostics);

  const output: string[] = [];
  let fence: Fence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      output.push(line);
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    const directive = parseDirective(line);
    if (directive?.kind !== "include") {
      if (AGENTSMITH_DIRECTIVE.test(line) && !directive) {
        reportMalformedDirective(line, path, index + 1, context.diagnostics);
        // Do not copy a malformed directive into generated output.
        continue;
      }
      output.push(line);
      continue;
    }

    if (!validIncludeId(directive.name)) {
      context.diagnostics.push({
        severity: "error",
        code: "include-invalid",
        message: `Invalid include Source ID \"${directive.name}\" at line ${index + 1}.`,
        path,
      });
      continue;
    }

    if (!context.resolveInclude) {
      context.diagnostics.push({
        severity: "error",
        code: "include-missing-resolver",
        message: `Cannot resolve include \"${directive.name}\" because no include resolver was provided.`,
        path,
      });
      continue;
    }

    let resolved: ResolvedInclude | undefined;
    try {
      resolved = await context.resolveInclude(directive.name, path);
    } catch (error) {
      context.diagnostics.push({
        severity: "error",
        code: "include-resolution-failed",
        message: `Failed to resolve include \"${directive.name}\": ${errorMessage(error)}.`,
        path,
      });
      continue;
    }
    if (!resolved) {
      context.diagnostics.push({
        severity: "error",
        code: "include-missing",
        message: `Included partial \"${directive.name}\" does not exist.`,
        path,
      });
      continue;
    }

    if (context.includeStack.includes(resolved.path)) {
      const start = context.includeStack.indexOf(resolved.path);
      const cycle = [...context.includeStack.slice(start), resolved.path];
      context.diagnostics.push({
        severity: "error",
        code: "include-cycle",
        message: `Include cycle detected: ${cycle.join(" -> ")}.`,
        path,
      });
      continue;
    }

    context.trace.includes.push(resolved.path);
    const partialLines = splitLines(resolved.content);
    const shift = partialHeadingShift(
      partialLines,
      output,
      inheritedHeading,
      resolved.path,
      context,
    );
    const shifted = shift === undefined
      ? partialLines
      : shiftHeadingLines(partialLines, shift, resolved.path, context.diagnostics);

    context.includeStack.push(resolved.path);
    const included = await expandIncludes(
      shifted,
      resolved.path,
      context,
      true,
      nearestHeading(output) ?? inheritedHeading,
    );
    context.includeStack.pop();
    output.push(...included);
  }

  return output;
}

async function fillSlots(
  lines: string[],
  path: string,
  contributions: readonly Contribution[],
  context: RenderContext,
): Promise<string[]> {
  const declarations = new Map<string, { line: number; required: boolean }>();
  let fence: Fence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      continue;
    }
    if (fence) continue;

    const directive = parseDirective(line);
    if (directive?.kind !== "slot" && directive?.kind !== "required-slot") continue;
    if (!validLogicalName(directive.name)) {
      context.diagnostics.push({
        severity: "error",
        code: "slot-invalid",
        message: `Invalid slot name \"${directive.name}\" at line ${index + 1}.`,
        path,
      });
      continue;
    }
    const previous = declarations.get(directive.name);
    if (previous) {
      context.diagnostics.push({
        severity: "error",
        code: "slot-duplicate",
        message: `Slot \"${directive.name}\" is declared more than once (lines ${previous.line} and ${index + 1}).`,
        path,
      });
    } else {
      declarations.set(directive.name, {
        line: index + 1,
        required: directive.kind === "required-slot",
      });
    }
  }

  const grouped = new Map<string, Contribution[]>();
  for (const contribution of contributions) {
    const items = grouped.get(contribution.slot) ?? [];
    items.push(contribution);
    grouped.set(contribution.slot, items);
  }

  for (const [slot, items] of grouped) {
    if (declarations.has(slot)) continue;
    for (const item of items) {
      context.diagnostics.push({
        severity: "error",
        code: "contribution-slot-missing",
        message: `Selected contribution \"${item.path}\" from pack \"${item.pack}\" targets absent slot \"${slot}\".`,
        path: item.path,
      });
    }
  }

  const output: string[] = [];
  fence = undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      output.push(line);
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    const directive = parseDirective(line);
    if (directive?.kind !== "slot" && directive?.kind !== "required-slot") {
      if (AGENTSMITH_DIRECTIVE.test(line) && !directive) {
        reportMalformedDirective(line, path, index + 1, context.diagnostics);
        continue;
      }
      output.push(line);
      continue;
    }

    const items = grouped.get(directive.name) ?? [];
    context.trace.slots[directive.name] = items.map((item) => item.path);
    if (directive.kind === "required-slot" && items.length === 0) {
      context.diagnostics.push({
        severity: "error",
        code: "required-slot-empty",
        message: `Required slot \"${directive.name}\" has no contributions.`,
        path,
      });
      continue;
    }

    const surrounding = nearestHeading(output);
    const renderedItems: string[][] = [];
    for (const item of items) {
      const itemLines = await expandIncludes(
        splitLines(item.content),
        item.path,
        { ...context, includeStack: [item.path] },
        false,
        surrounding,
      );
      warnAboutSnippetHeading(itemLines, surrounding, item, context.diagnostics);
      renderedItems.push(trimBoundaryBlankLines(itemLines));
    }
    output.push(...joinWithBlankLines(renderedItems));
  }

  return output;
}

function partialHeadingShift(
  lines: string[],
  renderedBefore: string[],
  inheritedHeading: Heading | undefined,
  path: string,
  context: RenderContext,
): number | undefined {
  const structural = structuralHeadings(lines);
  if (structural.length === 0) return undefined;

  const firstNonblank = lines.findIndex((line) => line.trim().length > 0);
  const firstHeading = structural[0];
  if (!firstHeading || firstHeading.level !== 1 || firstHeading.line !== firstNonblank + 1) {
    context.diagnostics.push({
      severity: "error",
      code: "partial-heading-start",
      message: "A headed partial must begin with an H1 heading.",
      path,
    });
    return 0;
  }

  const parent = nearestHeading(renderedBefore) ?? inheritedHeading;
  if (!parent) {
    context.diagnostics.push({
      severity: "error",
      code: "partial-heading-parent-missing",
      message: "A headed partial must be included beneath a preceding ATX heading.",
      path,
    });
    return 0;
  }
  const shift = parent.level;
  const deepest = Math.max(...structural.map((heading) => heading.level + shift));
  if (deepest > 6) {
    context.diagnostics.push({
      severity: "error",
      code: "partial-heading-too-deep",
      message: `Rebasing the partial beneath H${parent.level} would produce H${deepest}.`,
      path,
    });
    return 0;
  }
  return shift;
}

function shiftHeadingLines(
  lines: string[],
  shift: number,
  path: string,
  diagnostics: Diagnostic[],
): string[] {
  if (shift === 0) return lines;
  const output = [...lines];
  let fence: Fence | undefined;
  for (let index = 0; index < output.length; index += 1) {
    const line = output[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      continue;
    }
    if (fence) continue;
    const match = ATX_HEADING.exec(line);
    if (!match?.[1]) continue;
    const level = match[1].length + shift;
    if (level > 6) {
      diagnostics.push({
        severity: "error",
        code: "partial-heading-too-deep",
        message: `Heading at line ${index + 1} would be deeper than H6.`,
        path,
      });
      continue;
    }
    output[index] = `${"#".repeat(level)}${line.slice(match[1].length)}`;
  }
  return output;
}

function warnAboutSnippetHeading(
  lines: string[],
  surrounding: Heading | undefined,
  contribution: Contribution,
  diagnostics: Diagnostic[],
): void {
  if (!surrounding) return;
  const first = structuralHeadings(lines)[0];
  if (first && first.level <= surrounding.level) {
    diagnostics.push({
      severity: "warning",
      code: "snippet-heading-level",
      message: `Contribution \"${contribution.path}\" begins with H${first.level}, at or above the slot's surrounding H${surrounding.level}.`,
      path: contribution.path,
    });
  }
}

function validateNoSetextHeadings(
  lines: string[],
  path: string,
  diagnostics: Diagnostic[],
): void {
  let fence: Fence | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      continue;
    }
    const previous = lines[index - 1] ?? "";
    if (!fence && index > 0 && previous.trim() && SETEXT_UNDERLINE.test(line)) {
      diagnostics.push({
        severity: "error",
        code: "partial-setext-heading",
        message: `Setext headings are not allowed in partials (line ${index + 1}).`,
        path,
      });
    }
  }
}

function structuralHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: Fence | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      continue;
    }
    if (fence) continue;
    const match = ATX_HEADING.exec(line);
    if (match?.[1]) headings.push({ level: match[1].length, line: index + 1 });
  }
  return headings;
}

function nearestHeading(lines: string[]): Heading | undefined {
  return structuralHeadings(lines).at(-1);
}

function parseDirective(line: string): Directive | undefined {
  const match = DIRECTIVE.exec(line);
  const kind = match?.[1];
  const name = match?.[2];
  if (!name) return undefined;
  if (kind === "slot" || kind === "required-slot" || kind === "include") {
    return { kind, name };
  }
  return undefined;
}

function reportMalformedDirective(
  line: string,
  path: string,
  lineNumber: number,
  diagnostics: Diagnostic[],
): void {
  const isPosition = !line.startsWith("<!-- agentsmith:") || !line.endsWith(" -->");
  diagnostics.push({
    severity: "error",
    code: isPosition ? "directive-position" : "directive-malformed",
    message: isPosition
      ? `An agentsmith directive must begin at column zero and occupy line ${lineNumber} completely.`
      : `Malformed or unknown agentsmith directive at line ${lineNumber}.`,
    path,
  });
}

function findRemainingDirectives(
  lines: string[],
  path: string,
  diagnostics: Diagnostic[],
): void {
  let fence: Fence | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const transition = fenceTransition(line, fence);
    if (transition.closed) {
      fence = undefined;
      continue;
    }
    if (transition.opened) {
      fence = transition.opened;
      continue;
    }
    if (!fence && AGENTSMITH_DIRECTIVE.test(line)) {
      diagnostics.push({
        severity: "error",
        code: "directive-remaining",
        message: `An agentsmith directive remains after rendering at line ${index + 1}.`,
        path,
      });
    }
  }
}

function validIncludeId(value: string): boolean {
  const name = value.startsWith("@project/") ? value.slice("@project/".length) : value;
  return validLogicalName(name) && name.endsWith(".md");
}

function validLogicalName(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

function joinWithBlankLines(groups: string[][]): string[] {
  const output: string[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (output.length > 0) output.push("");
    output.push(...group);
  }
  return output;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

function fenceTransition(
  line: string,
  fence: Fence | undefined,
): { opened?: Fence; closed?: boolean } {
  const candidate = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  const run = candidate?.[2];
  if (!run) return {};
  const marker = run[0];
  if (marker !== "`" && marker !== "~") return {};
  if (!fence) {
    if (marker === "`" && candidate?.[3]?.includes("`")) return {};
    return { opened: { marker, length: run.length } };
  }
  if (marker === fence.marker && run.length >= fence.length && candidate?.[3]?.trim() === "") {
    return { closed: true };
  }
  return {};
}
