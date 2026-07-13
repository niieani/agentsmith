# agentsmith

agentsmith assembles agent instructions and skills from reusable source material for a particular environment or project. This glossary names the concepts used to describe that assembly consistently.

## Language

**Source Repository**:
The version-controlled collection of reusable templates, packs, partials, and profiles from which agent artifacts are assembled.
_Avoid_: Context repo, global repo, synced repo

**Machine Configuration**:
The machine-owned selection of a Source Repository and an active profile.
_Avoid_: Global config, host file

**Project Configuration**:
The project-owned declaration of its harnesses and scopes.
_Avoid_: Project profile, local config

**Harness**:
An agent runtime with its own instruction and skill discovery semantics.
_Avoid_: Tool, client

**Harness Adapter**:
agentsmith's mapping between scopes, artifact kinds, and a harness's native discovery model.
_Avoid_: Output adapter, arbitrary target

**Artifact**:
A complete agent-facing instruction or capability produced by agentsmith.
_Avoid_: Generated file, output file

**Scope**:
A visibility boundary within which agent artifacts apply. A scope may be global, repository-wide, or limited to a project subtree.
_Avoid_: Target, destination, layer

**Global Scope**:
The personal scope whose artifacts are available across projects in one environment.
_Avoid_: Host scope, user scope

**Repository Scope**:
The project scope whose artifacts are available throughout a repository.
_Avoid_: Root scope, repo target

**Subtree Scope**:
A project scope whose artifacts are available while working within a particular directory tree.
_Avoid_: Nested target, module target

**Scope Pack Selection**:
The ordered packs introduced by one scope. It excludes packs belonging to broader scopes whose artifacts are already inherited.
_Avoid_: Effective packs, inherited packs, full pack list

**Effective Agent Context**:
The instruction layers and skill artifacts visible at a working location after applying all relevant scopes.
_Avoid_: Generated context, merged scope

**Instruction Layer**:
A complete instruction artifact associated with one scope and combined with instruction layers from broader applicable scopes.
_Avoid_: Instructions target, AGENTS target

**Skill Root**:
The collection of skill artifacts associated with one scope.
_Avoid_: Skills target, skill catalog

**Skill Artifact**:
One assembled skill placed in a skill root.
_Avoid_: Skill target, generated skill

**Template**:
The structural source of an artifact, containing fixed content and optional composition directives.
_Avoid_: Master file, boilerplate

**Template Family**:
A named set of harness-specific templates representing the same conceptual instruction structure.
_Avoid_: Project type, universal template

**Directive**:
A composition instruction embedded in a template or partial, such as a slot or include.
_Avoid_: Marker, magic comment

**Slot**:
A named insertion point where selected packs may contribute content to a template.
_Avoid_: Section, placeholder, hook

**Snippet**:
An ordered piece of content contributed by a pack to a slot.
_Avoid_: Fragment, addition

**Partial**:
Reusable content included directly by a template or another partial. Unlike a snippet, a partial is selected by an explicit include rather than by pack membership and slot name.
_Avoid_: Shared snippet, sub-template

**Pack**:
A named, additive collection of snippets and skill contributions representing one reusable concern, capability, or convention.
_Avoid_: Category, tag, layer, scope

**Project Pack**:
A pack owned by one project and available only while assembling that project's artifacts.
_Avoid_: Local pack, repo pack

**Source ID**:
The qualified identity of a pack, template, partial, or skill source. It identifies ownership without determining the public identity of a generated artifact.
_Avoid_: Path, artifact name

**Local Source**:
Machine-owned source material that participates in assembly without belonging to version control.
_Avoid_: Override, dirty source

**Profile**:
A named selection of harnesses, a template family, and ordered packs used to assemble a machine's global artifacts.
_Avoid_: Host, configuration

**Generation Plan**:
The complete validated set of artifact changes for one operation before any changes are written.
_Avoid_: Render, target list

**Render**:
The operation that resolves a template's directives and selected packs into complete artifact content without writing it.
_Avoid_: Build, compile

**Generate**:
The operation that renders source material and writes the resulting artifact.
_Avoid_: Render, sync

**Sync**:
The global operation that updates the source repository and then generates all artifacts selected by the active profile.
_Avoid_: Project sync, copy

**Global Generation**:
Generation of personal agent artifacts selected by a machine's active profile.
_Avoid_: User generation, host generation

**Project Generation**:
Generation of project-owned artifacts for the scopes declared by that project.
_Avoid_: Local generation, project sync

**Skill**:
A named agent-facing capability that may be assembled from a template, partials, and pack contributions.
_Avoid_: Command, workflow

**Skill Name**:
The public identity declared by a skill and exposed to a harness.
_Avoid_: Source ID, skill path

**Enabled Skill**:
A skill selected for generation in a scope by at least one pack and not excluded by the active configuration.
_Avoid_: Installed skill, active skill

**Skill Exclusion**:
A scope-local decision not to generate a skill that the same scope would otherwise enable.
_Avoid_: Inherited override, disabled pack
