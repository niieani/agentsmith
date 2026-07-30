---
title: Composition directives
description: Slots, required slots, includes, and heading behavior.
---

Directives are standalone HTML comments. They must start at column zero, occupy the whole line, and appear outside fenced code blocks.

```md
<!-- agentsmith:slot tools -->
<!-- agentsmith:required-slot verification -->
<!-- agentsmith:include grilling/core.md -->
<!-- agentsmith:include @project/domain/terms.md -->
```

## Slots

`slot` inserts matching selected pack contributions and disappears when none exist. `required-slot` fails generation when it receives no contribution.

A receiving template or skill may declare a slot name only once. A selected instruction contribution whose template slot does not exist is an error. A selected skill-slot contribution with no enabled consumer produces a warning. Generated output may not contain unresolved agentsmith directives.

Instruction templates receive snippets from `instructions/<slot>/`. Skills receive reusable snippets from `skill-slots/<slot>/`. A selected skill-slot contribution is inserted into every enabled skill that declares that slot; its path never contains a consuming skill name.

## Includes

Includes resolve only below a source root's `partials/` directory:

- unqualified names resolve from shared `partials/`;
- `@project/...` resolves from project-owned `partials/`;
- missing files, cycles, symlinks, and root escapes are errors.

Include names are logical Source IDs, not paths relative to the Markdown file containing the directive. The same lookup applies in templates, `SKILL.md`, and Markdown skill support files.

```md
<!-- agentsmith:include skills/severity-guidance.md -->
```

resolves to:

```text
<shared-source-repository>/partials/skills/severity-guidance.md
```

The project-owned form:

```md
<!-- agentsmith:include @project/skills/severity-guidance.md -->
```

resolves to:

```text
<project>/.config/agentsmith/partials/skills/severity-guidance.md
```

Because lookup is anchored to the source root, moving a Markdown file within a template or skill directory does not silently change the meaning of its includes.

Includes expand recursively before slots are filled.

## Headings in partials

A partial without headings inserts as body content. A headed partial must begin with H1. agentsmith rebases that H1 to one level below the nearest preceding heading at the include site and preserves relative depth.

Setext headings in partials are invalid. An include without a parent heading, or one that would produce a heading deeper than H6, fails.

Snippet headings are not rebased. Lint warns when a snippet starts at or above the heading surrounding its slot.

## See the directives in practice

- [Build one skill for GitHub and Linear](/use-cases/skill-author#5-fill-the-skill-from-a-pack) shows a skill slot with pack-selected content.
- [Share a checklist without runtime chaining](/use-cases/feature-cookbook#reuse-a-checklist-with-an-include) shows recursive build-time includes.
- [Require a safety policy](/use-cases/feature-cookbook#make-missing-policy-a-build-error) shows why `required-slot` is different from `slot`.
- [Reuse a headed section safely](/use-cases/feature-cookbook#reuse-a-whole-section-at-different-heading-depths) shows automatic heading rebasing.
