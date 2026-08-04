# Use template families and additive packs

agentsmith composes artifacts from template families, ordered additive packs, named slots, snippets, and explicit partial includes. Templates own document structure, packs represent orthogonal reusable concerns, and numeric filenames make contribution order visible. We rejected broad layer concatenation, MDX, fragment front matter, arbitrary conditions, and a general templating language because they either cannot place content precisely or obscure how content was selected.

The original explicit `@project/...` ownership decision is superseded by [Resolve sources by name and compose matching packs](2026-08-03-resolve-sources-by-name-and-compose-packs.md).
