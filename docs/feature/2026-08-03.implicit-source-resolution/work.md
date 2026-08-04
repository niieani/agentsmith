# Design

## Source reference

A Source ID is a logical name with an optional ownership qualifier:

- `software`
- `source:software`
- `project:software`

Names retain slash-separated logical segments. `@project/...` is invalid.

## Resolution policies

Singular sources—templates, skills, partials:

1. A qualifier restricts lookup to that owner.
2. Unqualified project generation checks project, then Source Repository.
3. Global generation has only the Source Repository.
4. No match is an error.

Packs:

1. A qualifier selects one matching pack.
2. An unqualified project selection loads Source Repository then project matches.
3. Selected-pack order remains primary; owner order is secondary.
4. No match is an error.
5. Two selections resolving the same owned pack are an error.

## Resolved identity and provenance

Resolved sources receive canonical qualified identities (`source:name`, `project:name`) independent of the requested spelling. Explanations list resolved pack identity, path, and composition order. Snippet provenance remains file-based.

## Seam

Configuration parses Source IDs but does not perform filesystem discovery. The source-resolution module owns lookup policy, validation, canonical identity, and loading. Planning consumes resolved templates, packs, skills, and partials.
