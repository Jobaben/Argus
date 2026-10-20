import { InfoTip, Page, Tabs } from "../ds";
import { useHashRoute } from "../useHashRoute";
import { MonitorsPanel } from "./Monitors";
import { WatchtowerPanel } from "./Watchtower";

/**
 * Health: one page for the two read-only views of how schedules are doing.
 *
 * Monitors answers "did it run" and Watchtower answers "did it run the way it
 * usually runs". They were two tabs in the bar, both per-schedule, both
 * read-only, both about the same objects — a reader checking on a schedule
 * had to visit both to know it was well. One page with a switch keeps the
 * two questions distinct without making them two destinations.
 *
 * The sub-tab is in the hash (`#/health`, `#/health/watchtower`), so links
 * from the Briefing, the situation strip and the notification bell land on
 * the half they mean, and a reload keeps it.
 *
 * Health is a destination in its own right, not a drill-down from the
 * Scheduler, so it carries no breadcrumb. The two halves are link tabs — they
 * change the URL — rather than the segmented control that filters *within* a
 * view, so the page no longer has two switchers that look alike and behave
 * differently.
 */
type Panel = "monitors" | "watchtower";

const PANELS: { id: Panel; label: string; href: string }[] = [
  { id: "monitors", label: "Monitors", href: "#/health" },
  { id: "watchtower", label: "Watchtower", href: "#/health/watchtower" },
];

/** Each half's own explanation, on demand at the end of the tab rule: the
 *  paragraph that used to open the panel and push the counters down. */
function About({ panel }: { panel: Panel }) {
  if (panel === "watchtower") {
    return (
      <InfoTip
        title="How Watchtower works"
        align="end"
        trigger={<span className="text-caption text-ink-faint">How Watchtower works</span>}
      >
        Watchtower learns an envelope — the median and the 5th–95th percentile — from each
        schedule's and each pipeline phase's own successful runs, then flags the runs that leave it:
        a run that succeeded but took four times as long, or cost four times as much, as it usually
        does.
      </InfoTip>
    );
  }
  return (
    <InfoTip
      title="How monitors work"
      align="end"
      trigger={<span className="text-caption text-ink-faint">How monitors work</span>}
    >
      A dead-man's switch over your schedules. Argus records the slots each schedule expected, so a
      monitor goes down when a slot passes and nothing ran — even if Argus itself was asleep at the
      time. A run that never happened is as visible as one that failed.
    </InfoTip>
  );
}

export default function Health() {
  // Any second segment other than "watchtower" is Monitors: the default half.
  const segments = useHashRoute();
  const panel: Panel = segments[1] === "watchtower" ? "watchtower" : "monitors";
  return (
    <Page
      title="Health"
      subtitle="Is anything quietly broken? Monitors check that every schedule ran; Watchtower checks that it ran the way it usually does."
    >
      <Tabs label="Health views" items={PANELS} active={panel} trailing={<About panel={panel} />} />
      {panel === "watchtower" ? <WatchtowerPanel /> : <MonitorsPanel />}
    </Page>
  );
}
