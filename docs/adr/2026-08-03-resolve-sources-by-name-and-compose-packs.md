# Resolve sources by name and compose matching packs

Agent Smith accepts unqualified Source IDs as concise logical names. During project generation, singular sources such as templates, skills, and partials resolve from the project first and fall back to the configured Source Repository, while each selected pack composes all matches in deterministic Source Repository then project order; `source:` and `project:` qualifiers restrict lookup when ownership matters, and a name missing from every eligible owner is an error.

This replaces explicit `@project/...` ownership as the default because packs are additive by design and projects should be able to specialize reusable concerns without restating both sources. Resolution remains observable: explanations report canonical template identity and path plus every resolved pack's canonical identity, path, and merge order. Machine-specific behavior remains the responsibility of the active Profile and Global Scope rather than optional project packs.

## Consequences

- Selected-pack order remains primary; source ownership order is secondary.
- Matching pack files never override each other; both contribute.
- Singular sources never merge.
- Duplicate selections resolving the same owned pack are errors rather than duplicated contributions.
