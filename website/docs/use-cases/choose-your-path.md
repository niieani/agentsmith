---
title: Choose your path
description: Start with the agentsmith workflow that matches the job you are doing.
---

agentsmith serves several people who touch agent context in different ways. You may play all three roles, but each has a different source of truth and a different daily workflow.

| Role | You own | You usually run | Start here |
| --- | --- | --- | --- |
| Personal user | Machine config, profile selection, personal context repository | `asmith global sync` | [Personal user walkthrough](/use-cases/personal-user) |
| Skill author | `SKILL.md`, support files, partials, and skill slot contracts | `asmith global lint` or `asmith project lint` | [Skill author walkthrough](/use-cases/skill-author) |
| Project maintainer | Checked-in project config, local packs, repository and subtree context | `asmith project diff` and `asmith project generate` | [Project maintainer walkthrough](/use-cases/project-maintainer) |

## The handoff between roles

The roles meet through named sources:

1. A skill author publishes a skill source and documents its slots.
2. A pack author fills those slots for a technology or workflow and may auto-enable the skill.
3. A project maintainer selects packs for repository scopes.
4. A personal user selects packs for a machine profile.
5. agentsmith renders the same sources into the native locations expected by each harness.

No consumer edits the generated artifact to customize it. They change a selected pack, profile, scope, or project-owned source and regenerate.

## Not sure which abstraction you need?

| If the content… | Put it in… |
| --- | --- |
| defines the overall order and headings of an instruction file | a template family |
| belongs to a reusable concern such as Bun, GitHub, macOS, or release policy | a pack snippet |
| is an on-demand workflow an agent should invoke | a skill |
| is prose reused inside templates or skills | a partial |
| is unique to one repository | an unqualified project-owned source |
| applies only below one monorepo directory | a nested scope |
| chooses a machine's personal context | a profile |

The [feature cookbook](/use-cases/feature-cookbook) turns each of these choices into a concrete problem-and-solution example.
