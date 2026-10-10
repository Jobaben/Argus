# Verified shadow-feeder handoff

Current evidence captured2026-10-08. Implementation and live collection were verified; statistical readiness is deliberately not claimed.

## Final configuration

Pipeline8a4a1975-0cab-49d8-b9ca-46ca22ed511e was created with the requested argus-pipeline skill helper and refined with Argus's native validated atomic writer. The existing Workshop Studio pipeline was preserved. Final definition is pipeline-definition.json; final authoring input is pipeline-input.json; skill-validation.json retains helper validation.

Daily fixed slots00,12,24,36,48 minutes each hour; window00:00–23:59; skip overlap; Claude/Haiku; one read-only scenario step; four-minute deadline. The precise Bash selector command is pre-authorized; editing, PowerShell and built-in network tools are denied by the declared profile. Genuine missing information and contradictory business rules produce unsuccessful task outcomes.

The Argus collector remains running as PID30836 using C:/GIT/Argus/.worktrees/argus-local, which contains the actual Decision Plane implementation. H2 is enabled; H1 is disabled because it needs genuine human decisions. Probe sampling1, residual0.5; max96shadowcalls/rolling24h; min12minutes; recorded shadow cost capUSD10/day. Workload calls are additional. Keep this machine and Argus running; start-collector.ps1 safely refuses duplicate launches. Source code was not modified.

## Actual runtime evidence

Four scheduled instances were recorded by the final audit. The fixed-slot instance6467c389-2a68-4d36-b2da-7e118ed360b3 started at10:24:12.838Z,12.838seconds after its intended slot. Haiku run96c4b36e-2ade-40cd-bc12-f886418f23e9 executed the selector with no permission denials, selected waitlist, answeredB correctly, and completed at10:24:24.090Z. A prior corrected Haiku run9b467543-6f92-434d-ac12-0477ebe37482 legitimately could not calculate an exact revenue because ticketPriceSek was null.

Two real H2 assessments were matched to collector attempts and digest-verified retained journal snapshots: a termination probe for first runfa25fb30-37e3-4d20-8e3a-ff090cf7363a and residual cause for permission-denied run070e00ab-ada5-4207-a1d7-840d798e537d. The latter's top descriptive category is environment. Journal/ledger history is complete, with no integrity findings or gaps.

The initially unscoped Haiku command was denied and the model incorrectly inferred a missing environment variable. Logs showed the selector never ran; its absence claim was not evidence. The precise command allowance fixed the failure, verified first by a separate diagnostic then by actual scheduled tasks. Evidence remains in permission-diagnosis.json and selector-permission-check.json; the diagnostic was never inserted into Argus run stores or collected samples.

Native scheduling enumeration proves120slots across a normal24-hour day, exactly5perhour. Native interval scheduling had12.5minute observed starts; fixed clock slots now avoid accumulating drift. The bounded verifier session83212 completed successfully; it is no longer running. Argus itself remains alive.

## Validation and limits

44existing H2 collector/report tests and53existing scheduler/runtime tests passed, with no failures. Node syntax checks and allfive selector fixtures passed. The single-page HTML structure and its relative evidence links were checked. Browser URL policy prevented rendering the local file; no workaround was attempted.

Parallel agents audited H1/H2 purposes and eligibility. ECE requires200answered probes per exact provider/question identity and reliability bins require20each. At most192shadowcalls fit in48hours, before competition, abstentions or failures. First-two-day data can support operational and hypothesis review; full calibration requires more samples. Residual correctness remains unmeasured without references. Controlled cases do not establish production failure rates or broad termination-class coverage. H2 tables aggregate all eligible pipelines; retained feeder IDs are separately matched in runtime-evidence.json.

The current one-page report is report.html. Refresh with node docs/argus/shadow-feeder/refresh-evidence.mjs in a shell carrying the existing Argus token; credentials are not printed. All requested repository files are staged for IDE review, left uncommitted. Preserve unrelated preexisting staged knowledge-loop work. No commit, push or PR was performed.
