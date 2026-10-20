export * from "./status";
export * from "./format";
export { IrisMark } from "./IrisMark";
export { Card } from "./Card";
export { Section } from "./Section";
export { EmptyState } from "./EmptyState";
export {
  Handoff,
  Loading,
  Skeleton,
  SkeletonBoardCard,
  SkeletonCounters,
  SkeletonGrid,
  SkeletonRows,
  SkeletonText,
  SkeletonTile,
} from "./Skeleton";
// Drawer stays out of this eager barrel so its shell loads with lazy drawers.
// So do the pieces only lazy routes use — the form pickers (RubricFields,
// ModelSelect, RuntimeSelect, ReasoningEffortSelect, TriggerFields),
// RuntimeBadge, HeartbeatBar, Legend, Tabs, InfoTip and chronicleLayout:
// import them from their own modules. A re-export here pulls a module into
// the shell's chunk even when nothing eager uses it.
// `Markdown` is deliberately not re-exported here: it carries the `marked`
// lexer, and the barrel is imported by the eager shell. Import it from
// "./Markdown" inside a lazily-loaded view instead.
export { isMarkdown, safeHref } from "./markdownText";
export { ErrorBoundary } from "./ErrorBoundary";
export { Page } from "./Page";
export type { Crumb } from "./Page";
export { TimeAgo } from "./TimeAgo";
export { useClock, useTicker, CLOCK_TICK_MS } from "./clock";
export { StatusPill } from "./StatusPill";
export { Meter } from "./Meter";
export type { MeterProps } from "./Meter";
export { ConnectionPill } from "./ConnectionPill";
export { HealthCounter } from "./HealthCounter";
export { AgentTile } from "./AgentTile";
export { SweepBar } from "./SweepBar";
export { AlertStrip } from "./AlertStrip";
export { ToastRegion } from "./Toast";
export type { ToastItem } from "./Toast";
export { ActivityEvent } from "./ActivityEvent";
export * from "./overviewRow";
export * from "./routes";
export * from "./rail";
export {
  useCountUp,
  useChangeFlash,
  staggerDelay,
  prefersReducedMotion,
  syncedDelay,
  useSyncedDelay,
  DURATION,
  EASE,
} from "./motion";
export { usePresence, useSurfaceMotion, useListPresence, SURFACE } from "./presence";
export type { SurfaceMotion, PresentItem } from "./presence";
export { useFlip } from "./flip";
export { routeDirection } from "./direction";
export type { RouteDirection, RouteRole } from "./direction";
export {
  startViewTransition,
  setRouteDirection,
  supportsViewTransitions,
  transitionName,
} from "./viewTransition";
export {
  SPRING,
  springLinear,
  springValue,
  springDurationMs,
  settleFrom,
  settleDuration,
} from "./spring";
export { createVelocityTracker, flickOutcome } from "./gesture";
export { MoreMenu } from "./MoreMenu";
export type { MoreItem } from "./MoreMenu";
export { slugify } from "./slug";
export { SegmentedControl } from "./SegmentedControl";
export type { Segment } from "./SegmentedControl";
export { Icon } from "./Icon";
export type { IconName } from "./Icon";
export { Button, ButtonLink, IconButton } from "./Button";
export { buttonClass, chipClass, fieldClass, labelClass } from "./controls";
export type { ButtonVariant, ButtonSize } from "./controls";
