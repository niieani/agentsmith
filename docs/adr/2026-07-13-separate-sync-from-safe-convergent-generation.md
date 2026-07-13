# Separate sync from safe convergent generation

Only global sync updates Git, using a clean Source Repository and `git pull --ff-only`; project operations only generate. Project artifacts are replaceable or removable only when their specific paths are Git-clean, while global artifacts use external path-and-hash state because they normally live outside Git; neither mechanism writes ownership markers into artifacts. Every operation preflights the complete plan and tracks stale owned destinations, trading some state bookkeeping for convergent generation without silently destroying local edits.
