import type { PipelineState } from "./pipeline";

export const STUB_PIPELINE: PipelineState = {
  feature: "scheduler-prune",
  phases: [
    {
      id: "brainstorm", index: 1, name: "Brainstorm",
      tiles: [{ jobShort: "7a1b", name: "idea-sweep", subId: "9 directions", status: "done", detail: "Converged on prune-by-age + dead-letter requeue.", tokens: 48000, costUsd: 0.71, updatedAt: null }],
    },
    {
      id: "design", index: 2, name: "Design",
      tiles: [{ jobShort: "7a2c", name: "design-doc", subId: "4 diagrams", status: "done", detail: "Sequence + state model approved.", tokens: 72000, costUsd: 1.08, updatedAt: null }],
    },
    {
      id: "spec", index: 3, name: "Write spec",
      tiles: [{ jobShort: "7b04", name: "spec-author", subId: "SPEC-218", status: "done", detail: "Acceptance criteria + edge cases written.", tokens: 61000, costUsd: 0.92, updatedAt: null }],
    },
    {
      id: "plan", index: 4, name: "Impl plan",
      tiles: [{ jobShort: "7b91", name: "plan-author", subId: "PLAN-218", status: "await", detail: "8-step plan ready · approve to start, or send back to revise.", tokens: 34000, costUsd: 0.51, updatedAt: null }],
    },
    {
      id: "implement", index: 5, name: "Implement",
      tiles: [
        { jobShort: "2c8d44", name: "dev · TDD", subId: "task 3", status: "working", detail: "red → green on scheduler-prune test · 2 in flight", tokens: 88000, costUsd: 1.32, updatedAt: null },
        { jobShort: null, name: "migration-gen", subId: "task 5", status: "queued", detail: "Waits on plan task 6 · dead-letter migration.", tokens: 0, costUsd: 0, updatedAt: null },
      ],
    },
    {
      id: "review", index: 6, name: "Review",
      tiles: [
        { jobShort: "5e30", name: "code-review", subId: "PR #482", status: "working", detail: "Scanning diff (8 files) · pass 2/3.", tokens: 53000, costUsd: 0.8, updatedAt: null },
        { jobShort: "5e31", name: "ci-gate", subId: "PR #480", status: "failed", detail: "exit 1 — 2 flaky tests on requeue path.", tokens: 41000, costUsd: 0.62, updatedAt: null },
      ],
    },
    {
      id: "approve", index: 7, name: "Approve · iterate",
      tiles: [
        { jobShort: "5e30", name: "code-review", subId: "PR #482", status: "await", detail: "Review passed · awaiting sign-off to squash-merge.", tokens: 53000, costUsd: 0.8, updatedAt: null },
        { jobShort: "6f12", name: "merge-bot", subId: "PR #479", status: "done", detail: "Squash-merged to main. Release event published.", tokens: 96000, costUsd: 1.44, updatedAt: null },
      ],
    },
  ],
};

/**
 * Stub feed for the Command Center board. The return shape is the data
 * contract a future "derive pipeline from ~/.claude" implementation must
 * satisfy; the board UI does not change when the source becomes real.
 */
export function usePipeline(): PipelineState {
  return STUB_PIPELINE;
}
