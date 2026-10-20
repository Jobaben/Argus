import { useRef, useState } from "react";
import { useSearch, type SearchResult } from "../useSearch";
import { useVaultSearch } from "../useVault";
import {
  AlertStrip,
  chipClass,
  EmptyState,
  fieldClass,
  Handoff,
  Icon,
  IconButton,
  Page,
  Skeleton,
  TimeAgo,
} from "../ds";
import type { VaultSearchHit } from "../types";
import { formatKeys } from "../cmd/keys";

/** The palette chord as this platform spells it: ⌘K, or Ctrl K. */
const PALETTE_KEYS = formatKeys(
  "mod+k",
  typeof navigator === "undefined" ? "" : navigator.platform,
)[0];

/** Who wrote the matching line. A neutral chip: the speaker is a category, and
 *  the blue and green this used to wear mean "queued" and "done". */
function typeLabel(type: string): string {
  if (type === "user") return "User";
  if (type === "assistant") return "Assistant";
  const words = type.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The query, marked where it occurs. The mark is the eye's cyan — the colour of
 * focus and selection — rather than the amber it was, which on this dashboard
 * means "working". No side padding: a mark inside a word ("pruneRuns") must not
 * open a gap in it.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(lowerQ, i);
    if (found === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (found > i) parts.push(text.slice(i, found));
    parts.push(
      <mark
        key={key++}
        className="rounded-sm bg-eye/20 text-ink shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--color-eye)_55%,transparent)] box-decoration-clone"
      >
        {text.slice(found, found + q.length)}
      </mark>,
    );
    i = found + q.length;
  }
  return <>{parts}</>;
}

/**
 * One transcript hit, and a way into it. These rows used to be inert cards
 * showing eight characters of a session id; the transcript they matched is one
 * route away, so the row is the link to it.
 */
function ResultRow({ result, query }: { result: SearchResult; query: string }) {
  return (
    <a
      href={`#/sessions/${encodeURIComponent(result.project)}/${encodeURIComponent(result.sessionId)}`}
      className="group block px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-surface-2/60"
    >
      <div className="flex min-w-0 items-center gap-2 text-caption text-ink-faint">
        <span className={chipClass()}>{typeLabel(result.type)}</span>
        <span className="min-w-0 truncate font-mono">{result.projectLabel}</span>
        <span className="ml-auto hidden shrink-0 font-mono sm:inline">
          {result.sessionId.slice(0, 8)}
        </span>
        <Icon
          name="chevron-right"
          size={15}
          className="ml-auto shrink-0 transition-transform duration-(--duration-quick) group-hover:translate-x-0.5 sm:ml-0"
        />
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-small leading-relaxed text-ink-dim">
        <Highlight text={result.snippet} query={query} />
      </p>
    </a>
  );
}

/**
 * The Vault's half of the search page.
 *
 * Two indexes answer two different questions, and conflating them would make
 * both worse: the transcript scan reads what was *said*, the Vault reads what
 * Argus *did* — and, unlike the scan, it still holds the runs the JSON files
 * have pruned. They are shown as separate sections for that reason.
 */
function VaultHitRow({ hit, query }: { hit: VaultSearchHit; query: string }) {
  return (
    <a
      href={hit.href}
      className="group block px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-surface-2/60"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          name={hit.kind === "run" ? "history" : "bell"}
          size={14}
          className="shrink-0 text-ink-faint"
        />
        <span className="sr-only">{hit.kind === "run" ? "Run:" : "Event:"}</span>
        <span className="min-w-0 flex-1 truncate text-small font-semibold text-ink">
          {hit.title}
        </span>
        <span className="shrink-0 text-caption">
          <TimeAgo iso={hit.at} />
        </span>
        <Icon
          name="chevron-right"
          size={15}
          className="shrink-0 text-ink-faint transition-transform duration-(--duration-quick) group-hover:translate-x-0.5"
        />
      </div>
      <p className="mt-1 line-clamp-2 pl-[22px] text-caption leading-relaxed text-ink-dim">
        {hit.related && (
          <span
            className={`${chipClass()} mr-1.5 align-[1px]`}
            title="Matched a term that co-occurs with your query in this machine's history, not the query itself"
          >
            related
          </span>
        )}
        <Highlight text={hit.snippet} query={query} />
      </p>
    </a>
  );
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h2 className="eyebrow">{title}</h2>
      {children}
    </div>
  );
}

const LIST =
  "divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised";

/** A results panel before it has rows. */
function SkeletonResults({ rows }: { rows: number }) {
  return (
    <div className="divide-y divide-line rounded-tile border border-line bg-surface">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2.5 px-4 py-3.5">
          <Skeleton className="h-2.5 w-1/3" />
          <Skeleton className={`h-3 ${i % 2 ? "w-3/5" : "w-4/5"}`} />
        </div>
      ))}
    </div>
  );
}

/** The Vault saying something other than results: unavailable, or nothing found. */
function VaultNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-tile border border-line bg-surface/50 px-4 py-3 text-caption text-ink-faint">
      <Icon name="info" size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function VaultResults({
  query,
  vault: { response, loading, error },
}: {
  query: string;
  vault: ReturnType<typeof useVaultSearch>;
}) {
  // The Vault's own conditions — unreachable, unavailable, nothing found — are
  // said under its own heading, not across the page: the transcript half of the
  // page may still be answering.
  return (
    <section aria-label="Run history">
      <SectionHead title="Run history">
        <span className="text-caption text-ink-faint">Indexed by the Vault</span>
      </SectionHead>
      {error ? (
        <AlertStrip subject="Vault" message={`Couldn't reach the Vault: ${error}`} />
      ) : !response.available && !loading ? (
        <VaultNote>
          {response.detail || "The Vault is unavailable, so only transcripts were searched."}
        </VaultNote>
      ) : loading && response.hits.length === 0 ? (
        <SkeletonResults rows={2} />
      ) : response.hits.length === 0 ? (
        <VaultNote>{response.detail || "No run or alert in the Vault mentions that."}</VaultNote>
      ) : (
        <>
          {response.relatedTerms.length > 0 && (
            <p className="mb-2 flex items-start gap-2 text-caption text-ink-faint">
              <Icon name="sparkle" size={14} className="mt-px shrink-0" />
              <span>
                Also searched{" "}
                <span className="text-ink-dim">{response.relatedTerms.join(", ")}</span> — terms
                that co-occur with your query in this machine&apos;s own history, not a general
                language model.
              </span>
            </p>
          )}
          <div className={LIST}>
            {response.hits.map((h) => (
              <VaultHitRow key={`${h.kind}:${h.ref}`} hit={h} query={query} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Before a query: what the two indexes are, so "no matches" later is
 *  unambiguous about which one came up empty. */
function SearchIntro() {
  return (
    <div className="rounded-tile border border-line bg-surface/50 p-5 sm:p-6">
      <div className="grid gap-5 sm:grid-cols-2 sm:gap-8">
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-dim">
            <Icon name="history" size={17} />
          </span>
          <div>
            <h2 className="text-heading font-semibold text-ink">Run history</h2>
            <p className="mt-1 text-small text-ink-dim">
              The Vault answers from every run and alert Argus has recorded, including the ones the
              JSON files have since pruned.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-dim">
            <Icon name="terminal" size={17} />
          </span>
          <div>
            <h2 className="text-heading font-semibold text-ink">Transcripts</h2>
            <p className="mt-1 text-small text-ink-dim">
              A scan that is plain-text and case-insensitive over the message text of every session
              Claude Code has written. Newest transcripts are read before older ones, so a recent
              phrase comes back immediately.
            </p>
          </div>
        </div>
      </div>
      {/* A keyboard chord is no help on a phone. */}
      <p className="mt-5 hidden flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-4 text-caption text-ink-faint sm:flex">
        Looking for a pipeline, schedule or session by name? Press
        <kbd className="kbd">{PALETTE_KEYS}</kbd>
        to jump straight to it.
      </p>
    </div>
  );
}

/** The transcript scan's half of the page: its failure, its empty answer, or
 *  its matches. */
function TranscriptResults({
  query,
  search: { results, loading, error, truncated },
}: {
  query: string;
  search: ReturnType<typeof useSearch>;
}) {
  return (
    <section aria-label="Transcripts" className="min-w-0">
      <SectionHead title="Transcripts">
        {/* The scan stops at a cap; saying "100 matches" would turn a ceiling
            into a count the reader would take literally. */}
        {!error && results.length > 0 && (
          <p role="status" className="text-caption text-ink-faint">
            {truncated ? (
              <>
                first <span className="text-ink-dim">{results.length}</span> matches — narrow the
                query to see the most relevant ones
              </>
            ) : (
              <>
                {results.length} match{results.length === 1 ? "" : "es"}
              </>
            )}
          </p>
        )}
      </SectionHead>
      <Handoff busy={loading} label="matches" skeleton={<SkeletonResults rows={4} />}>
        {/* The scan's failure sits where its results would have, beside the
            Vault's own answer — one index failing is not the page failing, and
            a "no matches" under it would be a false claim. */}
        {error ? (
          <AlertStrip
            subject="Transcript scan"
            message={`Couldn't reach the Argus server: ${error}`}
          />
        ) : results.length === 0 ? (
          <div role="status">
            <EmptyState compact icon="search" title={<>No matches for &ldquo;{query}&rdquo;.</>}>
              The search is literal, not fuzzy — try a shorter fragment
              <span className="hidden sm:inline">
                , or press <kbd className="kbd">{PALETTE_KEYS}</kbd> to jump to a pipeline, schedule
                or session by name
              </span>
              .
            </EmptyState>
          </div>
        ) : (
          <div className={LIST}>
            {results.map((r, i) => (
              <ResultRow key={`${r.project}/${r.sessionId}/${i}`} result={r} query={query} />
            ))}
          </div>
        )}
      </Handoff>
    </section>
  );
}

/** The browser's own clear glyph is a bold white ✕ outside the icon set; the
 *  field draws its own clear button instead. */
const SEARCH_FIELD = "[&::-webkit-search-cancel-button]:appearance-none";

export default function Search() {
  const [input, setInput] = useState("");
  // The clear button goes with the text it clears; focus goes back to the
  // field rather than falling to the page.
  const field = useRef<HTMLInputElement>(null);
  const search = useSearch(input);
  const trimmed = input.trim();
  const vault = useVaultSearch(trimmed);
  const searchVault = trimmed.length >= 2;

  // One column, the answer first. Run history leads, as it does in the intro
  // and the subtitle — unless it has settled with nothing to show while the
  // scan has matches, in which case the matches lead and the Vault's "nothing"
  // follows them. Only once it has settled: flipping the order while the Vault
  // is still answering would move the list out from under the reader.
  const vaultSettledEmpty =
    !searchVault ||
    (!vault.loading &&
      (vault.error != null || !vault.response.available || vault.response.hits.length === 0));
  const transcriptsFirst = vaultSettledEmpty && !search.error && search.results.length > 0;

  const transcripts = <TranscriptResults query={trimmed} search={search} />;

  return (
    <Page
      title="Search"
      subtitle="Indexed search over Argus's own run history, and a plain-text scan of every Claude Code transcript."
    >
      {/* A reading measure, shared by the field and the results under it: at
          the page's full width a snippet is one line two hand-spans long. */}
      <div className="max-w-5xl">
        <div className="relative mb-6">
          <label htmlFor="transcript-search" className="sr-only">
            Search run history and transcripts
          </label>
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            ref={field}
            id="transcript-search"
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search runs, alerts and transcripts…"
            className={`${fieldClass} ${SEARCH_FIELD} h-11 w-full pl-11 text-body! ${
              input ? "pr-12" : "pr-3"
            }`}
          />
          {input && (
            <span className="absolute inset-y-0 right-1.5 flex items-center">
              <IconButton
                icon="close"
                label="Clear the search"
                onClick={() => {
                  setInput("");
                  field.current?.focus();
                }}
              />
            </span>
          )}
        </div>

        {!trimmed ? (
          <SearchIntro />
        ) : (
          <div className="flex flex-col gap-8">
            {transcriptsFirst && transcripts}
            {searchVault && <VaultResults query={trimmed} vault={vault} />}
            {!transcriptsFirst && transcripts}
          </div>
        )}
      </div>
    </Page>
  );
}
