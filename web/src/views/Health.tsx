import { Page } from "../ds";
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
 */
type Panel = "monitors" | "watchtower";

const PANELS: { id: Panel; label: string; href: string }[] = [
  { id: "monitors", label: "Monitors", href: "#/health" },
  { id: "watchtower", label: "Watchtower", href: "#/health/watchtower" },
];

export default function Health() {
  // Any second segment other than "watchtower" is Monitors: the default half.
  const segments = useHashRoute();
  const panel: Panel = segments[1] === "watchtower" ? "watchtower" : "monitors";
  return (
    <Page title="Health" crumbs={[{ label: "Scheduler", href: "#/schedules" }]}>
      <nav aria-label="Health views" className="mb-6 flex items-center gap-1">
        {PANELS.map((p) => (
          <a
            key={p.id}
            href={p.href}
            aria-current={panel === p.id ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              panel === p.id ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
            }`}
          >
            {p.label}
          </a>
        ))}
      </nav>
      {panel === "watchtower" ? <WatchtowerPanel /> : <MonitorsPanel />}
    </Page>
  );
}
