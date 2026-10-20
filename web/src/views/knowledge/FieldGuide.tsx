import { Drawer } from "../../ds/Drawer";
import { Icon } from "../../ds";
import {
  AXES,
  KIND_TERMS,
  TERMS,
  type GlossaryAxis,
  type GlossaryEntry,
  type TermId,
} from "../knowledgeGlossary";
import { FLAGGED, KIND_ORDER } from "../knowledgeModel";
import { ExceptionBadge, KindMark } from "./marks";
import { Legend, type LegendItem } from "../../ds/Legend";

function termItem(id: TermId): LegendItem {
  const t = TERMS[id];
  const tone = FLAGGED[id];
  return {
    key: id,
    // A term that never flags a row is drawn as nothing at all, which is the
    // point: normal says nothing.
    mark: tone ? (
      <ExceptionBadge term={id} tone={tone} />
    ) : (
      <span className="text-caption text-ink-faint">no mark</span>
    ),
    label: t.term,
    description: t.definition,
    note: t.note,
  };
}

function itemsFor(axis: GlossaryAxis): LegendItem[] {
  if (axis === "kind") {
    return KIND_ORDER.map((kind) => ({
      key: kind,
      mark: <KindMark kind={kind} size={16} />,
      label: KIND_TERMS[kind].term,
      description: KIND_TERMS[kind].definition,
    }));
  }
  return (Object.entries(TERMS) as Array<[TermId, GlossaryEntry]>)
    .filter(([, t]) => t.axis === axis)
    .map(([id]) => termItem(id));
}

/**
 * "How to read this page": every mark and word on it, grouped by the question
 * it answers, each mark drawn exactly as the page draws it.
 */
export function FieldGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="How to read this page"
      subtitle="Knowledge Ledger field guide"
    >
      <div className="flex flex-col gap-8">
        <p className="text-body leading-relaxed text-ink-dim">
          The ledger records what Argus believes, the evidence behind it, and who relied on it. This
          page is quiet on purpose:{" "}
          <span className="font-semibold text-ink">normal says nothing</span>. A claim that is
          active and supported carries no badge at all, so anything coloured is something worth a
          look.
        </p>
        {AXES.map(({ axis, title, question }) => (
          <section key={axis} className="border-t border-line pt-5">
            <h3 className="text-heading font-semibold text-ink">{title}</h3>
            <p className="mb-4 mt-0.5 text-small text-ink-faint">{question}</p>
            <Legend label={title} items={itemsFor(axis)} wideMarks={axis !== "kind"} />
          </section>
        ))}
        <p className="flex items-center gap-2 text-caption text-ink-faint">
          <Icon name="file" size={14} />
          Definitions: <span className="font-mono">docs/KNOWLEDGE-LEDGER.md</span>
        </p>
      </div>
    </Drawer>
  );
}
