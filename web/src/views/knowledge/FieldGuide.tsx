import { Drawer } from "../../ds/Drawer";
import { Legend, type LegendItem } from "../../ds";
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

function termItem(id: TermId): LegendItem {
  const t = TERMS[id];
  const tone = FLAGGED[id];
  return {
    key: id,
    mark: tone ? (
      <ExceptionBadge term={id} tone={tone} />
    ) : (
      <span className="text-ink-faint">–</span>
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
      mark: <KindMark kind={kind} className="text-[15px]" />,
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
        <p className="text-[14px] leading-relaxed text-ink-dim">
          The ledger records what Argus believes, the evidence behind it, and who relied on it. This
          page is quiet on purpose: <span className="text-ink">normal says nothing</span>. A claim
          that is active and supported carries no badge at all, so anything coloured is something
          worth a look.
        </p>
        {AXES.map(({ axis, title, question }) => (
          <section key={axis}>
            <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-eye">
              {title}
            </h3>
            <p className="mb-3 mt-1 text-[13px] text-ink-faint">{question}</p>
            <Legend label={title} items={itemsFor(axis)} wideMarks={axis !== "kind"} />
          </section>
        ))}
        <p className="font-mono text-[11px] text-ink-faint">
          Definitions: docs/KNOWLEDGE-LEDGER.md
        </p>
      </div>
    </Drawer>
  );
}
