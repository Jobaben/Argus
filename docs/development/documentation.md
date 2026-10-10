# Maintaining the documentation

[Documentation](../README.md) · [Development](README.md) · [Catalog](catalog.md)

## One purpose per document

- **Getting started:** prerequisites, numbered actions and visible success checks.
- **Guides:** a user task, prerequisites, expected results, controls and recovery.
- **Reference:** exact options, defaults, payloads, formats and invariants.
- **Development/evidence:** what was proposed, implemented or verified at a stated
  time and identity, plus the remaining prerequisites.

Keep advanced protocol definitions in the API, Harness and Knowledge Ledger
references. Link to their worked examples from guides instead of duplicating
schemas that can drift. Keep original evidence files and their paths stable.

## When a feature changes

1. Inspect the actual implementation and tests, including defaults and refusal
   conditions. Confirm the CLI/runtime and authentication requirements.
2. Update the affected topic guide and exact technical reference together.
3. Add or update the route/task in the [feature map](../guides/README.md#feature-map).
4. Add a newcomer-friendly example with prerequisites, actions and expected result.
   Identify whether it invokes a provider, alters state or is only a read.
5. Use separate labels for source behavior, offline validation and live readiness.
   Include dates/identities when making a historical status claim.
6. If a page moves, update relative links and keep old heading aliases when cited.
   Check screenshot paths as well as text links.
7. Add a new document to [catalog.md](catalog.md); preserve titles for old records.
8. Review the installation → first run → feature guide → reference path without
   assuming the reader knows a product nickname or prior session.

## Verification

For docs-only changes, check Markdown formatting, local link targets and heading
fragments, CLI help, package-script names, actual route coverage, and retention
of protocol/screenshot content moved between pages. A formatting pass is not
proof the application starts or a model call succeeds.

Run from the root, substituting only the intended Markdown paths:

```sh
node bin/argus.mjs --help
node node_modules/prettier/bin/prettier.cjs --check README.md docs/README.md docs/guides/*.md
git diff --check
```

When validation requires starting a live instance, invoking a provider or
changing accounts/hooks, report that requirement explicitly. Documentation
validation alone must not be reported as live feature verification.
