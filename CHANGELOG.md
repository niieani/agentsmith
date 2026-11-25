# Changelog

## [1.0.0](https://github.com/niieani/agentsmith/compare/v0.3.0...v1.0.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* the `codex` harness no longer writes skills to `.agents/skills` or `~/.agents/skills`. Add `generic` to `harnesses` to keep those destinations; with `codex` alone project skills move to `.codex/skills` and global skills are an error. `instructions/generic/`, `skill-slots/harnesses/generic/`, and `generic.md` templates are now harness-specific. Project CLAUDE.md may now be written as `@AGENTS.md`.
* harness "claude-code" is renamed "claude"; update harnesses lists, claude-code.md templates, and claude-code/ pack directories.

### Features

* add generic harness and place each skill once per harness ([d1575c6](https://github.com/niieani/agentsmith/commit/d1575c6ec18fa910ab5e08aabd48a8a4126d5d0c))
* add project init with ignore entries and --prepare ([2508fe5](https://github.com/niieani/agentsmith/commit/2508fe5ad6db37478f8297a3b59a2322175b04c1))
* add snippets to pack slots from the CLI ([eb484c3](https://github.com/niieani/agentsmith/commit/eb484c3caa0e4e05e6bad55ab54fbee604be8e71))
* add the antigravity harness adapter ([0dd44d3](https://github.com/niieani/agentsmith/commit/0dd44d314c64cb4f192eeb98cf70388475f85ffa))
* allow pack-only base profiles in extends chains ([56a9fa7](https://github.com/niieani/agentsmith/commit/56a9fa775aa4222b5f2c96a6c1520d963422e68d))
* check per-harness limits for Claude Code and Codex ([d162478](https://github.com/niieani/agentsmith/commit/d162478395c42ec7eb01f24c7a689fccf27e810a))
* clean generated artifacts and state ([98eea5f](https://github.com/niieani/agentsmith/commit/98eea5fa877a6d094c94fb247a9884efdf8925a0))
* commit global add snippets by default ([ce75e98](https://github.com/niieani/agentsmith/commit/ce75e98c598644f1fabb3d5b563c37ed911ba953))
* copy a Source Repository template into the project with project init --template ([3f944e9](https://github.com/niieani/agentsmith/commit/3f944e98d76ca8ad23f2b1fe4711a92f503f9da8))
* exclusive mode and skill adoption ([8d75bf2](https://github.com/niieani/agentsmith/commit/8d75bf224455b7b5c06ed4208a253c67a7c45667))
* generate projects without a Source Repository ([1136303](https://github.com/niieani/agentsmith/commit/1136303f1749452f2d4bbab146552eae6ee36e75))
* **global:** add global init and scheduled sync ([1a6c406](https://github.com/niieani/agentsmith/commit/1a6c406e7a2071486e299b3463ee1c44bd91028a))
* **global:** add run status, exit codes, modified-artifact backups, and adopt ([75f95ea](https://github.com/niieani/agentsmith/commit/75f95ea5a51cb73c605633095bd2690c71e59762))
* let profiles extend a parent profile ([0345a66](https://github.com/niieani/agentsmith/commit/0345a66a4509f74aa212794694661d2e643410af))
* record project artifact hashes and replace untracked artifacts safely ([b42461c](https://github.com/niieani/agentsmith/commit/b42461c5acfc2c6ed98af63ec1e80e46509f5ee8))
* rename the claude-code harness to claude ([83ee791](https://github.com/niieani/agentsmith/commit/83ee791b3cea7511fe5cc8be23c84f5564f36f56))
* render antigravity instructions globally and in projects ([93ad97d](https://github.com/niieani/agentsmith/commit/93ad97d5495143324cce3d6be88109fc83e25d7e))
* render shared and personal project layers ([66b55e4](https://github.com/niieani/agentsmith/commit/66b55e4424edddc48c7cb107af83c9193075892a))
* route project Antigravity snippets to Antigravity-only rules ([e2f710c](https://github.com/niieani/agentsmith/commit/e2f710c6e61c0336e9fca258b7b88773a0a8181e))
* sandbox home in the machine config ([697c413](https://github.com/niieani/agentsmith/commit/697c4133a48d854a1069393f74e196503afe76bd))
* show personal entry changes in project diff and layers in explain ([f9aabb3](https://github.com/niieani/agentsmith/commit/f9aabb3262cd2fa3f0956af4155ef62f36d95957))
* support third-party repositories with upstream keep or replace ([4f654b7](https://github.com/niieani/agentsmith/commit/4f654b70730f4746f0776faca5d91d7f92c4279a))


### Bug Fixes

* accept home, project, and source roots behind symlinked ancestors ([cdaebee](https://github.com/niieani/agentsmith/commit/cdaebee062218d2a3d4efb1712804a2887591ab0))
* back up skill directories outside every skill root ([64a4449](https://github.com/niieani/agentsmith/commit/64a4449c1945c7faaa8706aa26f1dd98e195043a))
* do not treat a skill's own stale copy as an unmanaged collision ([4ef16ae](https://github.com/niieani/agentsmith/commit/4ef16ae6ed91c38639380672deccc73ac4effbd9))
* keep only the latest scheduled run's log on macOS ([574a4e7](https://github.com/niieani/agentsmith/commit/574a4e749db044c995e408658953cc8bebe15eee))
* only ever add .git/info/exclude entries, in one agentsmith block ([03ed7e1](https://github.com/niieani/agentsmith/commit/03ed7e16a3a7cb1d593babec0d201c99d4153900))
* protect upstream files, user claudeMdExcludes, and nested-project clean scopes ([3b09c46](https://github.com/niieani/agentsmith/commit/3b09c4615f41bd5cb4361f98875c9bbfd540dea8))
* prune emptied .codex/skills directories and drop the doubled slash in diff headers ([a8fbe51](https://github.com/niieani/agentsmith/commit/a8fbe51e558b899ee74e001678604b02836dcea6))
* read add snippets from stdin reliably on Linux ([bf1dab6](https://github.com/niieani/agentsmith/commit/bf1dab6b6baacc237f48f2cba86ad49db45b5aec))

## [0.3.0](https://github.com/niieani/agentsmith/compare/v0.2.0...v0.3.0) (2026-08-20)


### Features

* publish CLI package to npm ([44e27ce](https://github.com/niieani/agentsmith/commit/44e27cef4cdc65077a838316c43a5f7ea26ecdc5))
* simplify source composition ([bdca899](https://github.com/niieani/agentsmith/commit/bdca8990d91bae42e90565ffb75bcf401d4a9edd))


### Bug Fixes

* accept npm package name in release builds ([130abcb](https://github.com/niieani/agentsmith/commit/130abcb77bf65f7879ee97c0d599bc4aaa688c87))
* normalize npm package metadata ([a430f2f](https://github.com/niieani/agentsmith/commit/a430f2fcd859c825f04e83abb84a8afb1e74c871))

## [0.2.0](https://github.com/niieani/agentsmith/compare/v0.1.0...v0.2.0) (2026-07-30)


### Features

* add reusable skill slots and docs site ([4b3ea12](https://github.com/niieani/agentsmith/commit/4b3ea12238774d4bf2e1422e225b825a5a01e64a))
* build agentsmith context generator ([6d9d4d4](https://github.com/niieani/agentsmith/commit/6d9d4d467a9deae3184a8c0286845fb900d0d74d))
