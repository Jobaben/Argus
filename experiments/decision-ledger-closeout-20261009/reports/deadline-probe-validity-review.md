# Deadline probe validity review

At 2026-10-09T00:43:20.808Z, native assessment DA-uaffv7M-3hUV3f5m for run a0a71822-d824-4b5b-879e-0fda9e31d120 correctly favored deadline (0.85) against an actual recorded timed-out termination. Snapshot 3f801b836ae77b6a02ff1cc0913f9544994af2d6ca3c7145ef66837635d963b4 passes hash and byte-size checks.

The retained input includes scheduleName: “Decision closeout D1 - deadline · Controlled case D1”. Its rationale explicitly says: “Schedule name explicitly references 'deadline'”. The expected class therefore reaches the judge through metadata, and the judge demonstrably uses it. This answer proves the live collection path for a real deadline; it does not prove independent deadline recognition, calibration, or consumer safety.

Other case names also reveal intended strata. Intended labels must never replace observed references: D3 and D4 completed normally despite names containing deadline. Inspect their actual native assessments as collection progresses.

Future consumer acceptance must use neutral names, audit the exact frozen projection for label hints, keep references out of judge inputs, and evaluate on appropriate independently labeled held-out cases. Preserve this cohort as historical evidence; do not silently rename it, restart collection, or count model opinions as human cause labels.

## 03:13 Stockholm follow-up

The second genuine timeout assessment DA-yyHxzh_GNAq9rcQO also explicitly cites the schedule name containing deadline and assigns deadline probability 0.80. Both timeout answers retain the same evaluation-validity limitation. D3 probe DA-shE6zk8eQpsASMdW correctly favors ended-normally (0.70) for a process that completed with an honest infeasibility explanation, despite its intended deadline name. This is useful observed separation of process termination from task success, but does not remove the metadata contamination or establish generalization. D3 residual DA-hJlqDkT4FnFMjpSI is a model inference, with no human reference label.
