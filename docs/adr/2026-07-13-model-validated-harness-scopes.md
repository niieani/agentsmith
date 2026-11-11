# Model validated harness scopes

Configuration is organized around global, repository, and subtree scopes, with first-class adapters for Codex and Claude Code, rather than generic output targets. Instruction and skill discovery differ both by artifact kind and by harness, so raw paths cannot safely express inheritance, shadowing, skill collisions, or effective context. The shared renderer remains harness-neutral, but v1 exposes only adapters whose discovery rules and native destinations agentsmith can validate.

The adapter destinations and skill placement are superseded by [Add a generic harness and place each skill once per harness](2026-11-10-generic-harness-and-skill-placement.md).
