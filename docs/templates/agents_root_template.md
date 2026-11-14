# AGENTS.md — [Project Name] MetaPrompt

> Scope: repository-wide orientation for all agents. Keep ≤150 lines. Subdirs inherit from this.

## Mission

[1-3 sentences describing the project's core purpose and goals]

## Workflow Guiding Principles

- **Spec first:** Write the plan before code.
- **Compact progress:** Summarize after each step.
- **Prune aggressively:** Delete noise, keep signal.
- **Delegate cleanly:** Use subagents with narrow scopes.
- **Validate early:** Run quality checks before proposing commits.
- **Update docs:** Reflect any surface changes in AGENTS.md.

## Agent Behavior

- Follow this root file as primary instruction; subdir AGENTS.md may extend but not override core principles.
- Never modify outside assigned directories.
- Keep context lean (<40% window); summarize often.
- Purge incorrect info instead of propagating it.

## Environment

- **Framework:** [Primary framework/language]
- **Infra:** [Infrastructure stack]
- **Toolchain:** [Development tools]
- **CI entrypoint:** [Main quality check command]

## Pointers

- [Architecture](https://node-template.cognidao.org/knowledge/hexagonal-layering-contract)
- [Repo State](docs/research/REPO_STATE.md) <!-- Current implementation status -->
- [Repo Specification](.cogni/repo-spec.yaml) <!-- DAO configuration spec -->
- [Subdir AGENTS.md Policy](docs/templates/agents_subdir_template.md)
- [Feature Spec Template](docs/templates/feature_spec_template.md)
- [Style & Lint Rules](https://node-template.cognidao.org/knowledge/code-style-standard)

## Usage

```bash
[command]        # [description]
[command]        # [description]
[command]        # [description]
[command]        # [description]
```
