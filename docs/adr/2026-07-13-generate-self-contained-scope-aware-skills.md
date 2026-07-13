# Generate self-contained scope-aware skills

Skills use the same renderer as instructions: packs enable them, selected packs fill their slots, and includes flatten private partials into the emitted skill. The generated public Skill Name is separate from its qualified source identity, and agentsmith rejects duplicate visible names across any effective scope chain even where a harness defines precedence. This stricter rule prevents different harnesses from exposing different or ambiguous behavior and avoids relying on unreliable runtime skill chaining.
