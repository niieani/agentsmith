---
title: Skill author walkthrough
description: Write one self-contained skill that adapts to GitHub or Linear through selected packs.
---

Suppose you want a `triage-issue` skill. Its workflow is stable—read an issue, inspect the code, propose next steps—but the commands and fields differ between GitHub and Linear.

Copying the skill into `triage-github-issue` and `triage-linear-issue` would duplicate most of the workflow. Making one skill invoke another at runtime would depend on the agent discovering and loading both correctly. agentsmith instead composes one flat skill at generation time.

## 1. Define the public skill

Create the source directory in the shared Source Repository:

```text
skills/
└── triage-issue/
    ├── SKILL.md
    └── references/
        └── severity.md
```

The public skill name must match the directory basename:

```md title="skills/triage-issue/SKILL.md"
---
name: triage-issue
description: Investigate an issue and produce an evidence-backed implementation recommendation.
---

# Triage an issue

Read the issue, identify the affected behavior, and inspect the relevant code before recommending a change.

## Tracker workflow

<!-- agentsmith:required-slot tracker -->

## Investigation

1. Reproduce or locate the reported behavior.
2. Trace the smallest relevant code path.
3. Separate confirmed facts from hypotheses.
4. Recommend the next action with supporting evidence.

## Severity

<!-- agentsmith:include skills/severity-guidance.md -->
```

This establishes two contracts:

- the `tracker` slot must be supplied by a selected pack;
- shared severity guidance is compiled into the generated skill.

## 2. Reuse a partial

Partials live at the Source Repository root, not inside the skill:

```md title="partials/skills/severity-guidance.md"
Classify impact by user reach, data risk, and availability. State which evidence supports the classification.
```

Because this partial has no headings, it inserts as body text. Includes are expanded at build time; the generated skill has no dependency on the partial path.

## 3. Keep support files with the skill

```md title="skills/triage-issue/references/severity.md"
# Severity examples

- Critical: active data loss or broad unavailability.
- High: a major workflow is blocked with no practical workaround.
- Normal: limited impact or a practical workaround exists.
```

All Markdown support files pass through composition too: agentsmith renders any directives they contain. Their includes are still resolved from a source root's `partials/` directory, not relative to the Markdown support file.

For example, this directive inside either `SKILL.md` or `references/severity.md`:

```md
<!-- agentsmith:include skills/severity-guidance.md -->
```

resolves to:

```text
<shared-source-repository>/partials/skills/severity-guidance.md
```

A project-owned partial must be explicit:

```md
<!-- agentsmith:include project:skills/severity-guidance.md -->
```

That resolves to:

```text
<project>/.config/agentsmith/partials/skills/severity-guidance.md
```

The lookup behavior does not change when a skill file moves within its source directory. Scripts, images, and other non-Markdown support files copy unchanged and preserve executable mode.

## 4. Create reusable tracker packs

The manifest-free GitHub pack supplies the tracker contract without naming any consuming skill:

```md title="packs/github/skill-slots/tracker/10-github.md"
Use `gh issue view` to read the issue body, labels, linked pull requests, and discussion. Record the repository and issue number in the result.
```

The manifest-free Linear pack supplies a different implementation of the same contract:

```md title="packs/linear/skill-slots/tracker/10-linear.md"
Read the Linear issue, including its team, project, status, labels, and linked documents. Record the issue identifier in the result.
```

Any enabled skill declaring a `tracker` slot can consume either pack. The tracker pack does not know whether the consumer triages, creates, updates, or summarizes issues.

## 5. Fill the skill from a pack

A project selects GitHub and independently enables the shared skill:

```toml
[[scopes]]
path = "."
template = "software"
packs = ["base", "github"]
skills_enable = ["triage-issue"]
```

For Codex, agentsmith emits a self-contained file at:

```text
.agents/skills/triage-issue/SKILL.md
```

Its tracker section contains the GitHub instructions. A project selecting `linear` gets the same public skill and core investigation workflow, with the Linear tracker section instead.

:::warning
Do not select both example packs in one scope unless their snippets are intentionally cumulative. Both provide `tracker`, so every consuming skill would contain both tracker workflows.
:::

## 6. Bring your own tracker instructions

The tracker pack does not have to come from the shared Source Repository. A project can define its own tracker integration and reuse it across multiple shared skills.

Create a project-owned pack:

```text
.config/agentsmith/
└── packs/
    └── acme-tracker/
        └── skill-slots/
            └── tracker/
                └── 10-acme.md
```

The pack has no manifest and no knowledge of its consumers:

Its tracker instructions are entirely owned by the project:

```md title=".config/agentsmith/packs/acme-tracker/skill-slots/tracker/10-acme.md"
Read issues from Acme Track using the repository's `acme issue show` command. Preserve the issue key, owning team, milestone, and linked incidents in the triage result.
```

Select that pack at the project scope:

```toml
[[scopes]]
path = "."
template = "software"
packs = ["base", "acme-tracker"]
skills_enable = ["triage-issue", "create-issue"]
```

Assuming the shared Source Repository contains both skills and each declares `tracker`, agentsmith embeds the same `10-acme.md` snippet into both generated skills. Neither shared skill needs to know which tracker implementation the project selected, and the project pack does not need to know which skills consume it.

Pack ownership and skill ownership are independent: a project pack can provide slots to shared skills, and a shared pack can provide slots to project-owned skills.

If tracker guidance should be reusable across several repositories, add a shared `packs/acme-tracker/`. Selecting `acme-tracker` composes shared and project matches; select `source:acme-tracker` or `project:acme-tracker` only when one owner must be isolated.

## 7. Specialize by harness only when needed

Choosing the tracker pack and specializing for a harness are separate decisions. Most tracker content should stay common. If the selected GitHub pack needs one extra Claude Code instruction, it can additionally contain:

```text
packs/github/skill-slots/
└── harnesses/
    └── claude-code/
        └── tracker/
            └── 20-claude.md
```

Common snippets render first, followed by harness-specific snippets. Codex remains unchanged.

## 8. Give consumers an escape hatch

Pack auto-enablement is optional and separate from slot provision. A broad GitHub pack might choose to enable a standard skill set:

```toml title="packs/github/pack.toml"
skills = ["triage-issue", "create-issue"]
```

A project may opt out of one:

```toml
[[scopes]]
path = "."
template = "software"
packs = ["base", "github"]
skills_disable = ["triage-issue"]
```

As in this walkthrough, skills can instead be selected explicitly while the tracker pack remains consumer-agnostic:

```toml
skills_enable = ["triage-issue"]
```

An explicit enable still needs a selected pack to fill every required slot.

## 9. Test the contract

In a fixture project that selects the pack:

```sh
asmith project lint --warnings-as-errors
asmith project explain
asmith project diff
```

Lint catches missing slots, malformed metadata, includes that do not exist, cycles, unsafe paths, heading errors, and public-name collisions. Explain shows which pack enabled the skill and which snippets filled each slot.

## 10. Evolve without runtime coupling

You can change the core skill, a partial, or one tracker pack independently. Consumers regenerate and receive a flat native skill. The harness never needs to understand agentsmith directives, locate partials, or invoke dependency skills.

## What this example used

- **Skill metadata** defines one stable public identity.
- **Required skill slots** make tracker integration an explicit contract.
- **Reusable Skill Slot Contributions** let one selected tracker implementation feed multiple skills.
- **Optional pack auto-enablement** connects standard capabilities to selected tooling without being required for composition.
- **Project-owned packs** bring a repository's own integration into shared skills without naming them.
- **Partials** reuse prose without runtime chaining.
- **Harness-specific contributions** isolate genuine harness differences.
- **Disable lists** let consumers opt out.
- **Lint and explain** test the composition before distribution.
