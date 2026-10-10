# Decision Ledger consumer backlog

Proposed work only. No consumer implementation or release has been verified. See development-plan.md for acceptance tests, dependencies and rollback.

- **DL-01: Closeout ADR and evidence manifest.** Depends on none. Release: Known disposition for all experiment items and explicit measured/unmeasured claims.
- **DL-02: Consumer contract and journal read model.** Depends on DL-01. Release: Read isolation, deterministic replay and truthful currency.
- **DL-03: Supported budgeted retained-snapshot evaluation.** Depends on DL-02. Release: Single writer, immutable reevaluation, bounded invocation and unknown-call reconciliation.
- **DL-04: Cause adjudication and optional independent references.** Depends on DL-01. Release: Blinded reviewed taxonomy and distinct reference stream.
- **DL-05: Advisory run/gate display.** Depends on DL-02. Release: Visible inference/currency limitations, no active-study label leakage or authority.
- **DL-06: Pure escalation policy and audit records.** Depends on DL-02. Release: Approved identity-bound rules, typed fallback and replayable audit.
- **DL-07: Ordinary-phase engine adapter.** Depends on DL-06, DL-09. Release: Prospective evidence gate passed; atomic eligibility check; idempotence; no knowledge bypass.
- **DL-08: Artifact and acceptance advisory links.** Depends on DL-05. Release: Artifact/criterion/verification identity binding with unchanged support and completion semantics.
- **DL-09: Drift and retirement runbook.** Depends on DL-03. Release: Canary monitoring and tested disable/recovery before DL-07 release.

Additional mandatory gates: neutral metadata and exact-input label-hint audit; supported runtime/model preflight; no-output and unknown-cost fallback; tool-denial versus normal-process separation; genuine independent reference labels.
