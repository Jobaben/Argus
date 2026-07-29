import { useState } from "react";
import { useSearch, type SearchResult } from "../useSearch";
import { useVaultSearch } from "../useVault";
import { AlertStrip, EmptyState, Handoff, Page, SkeletonRows, TimeAgo } from "../ds";
import type { VaultSearchHit } from "../types";

const TYPE_STYLE: Record<string, string> = {
  user: "bg-queue/12 text-queue ring-queue/30",
  assistant: "bg-ok/12 text-ok ring-ok/20",
};

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
      <mark key={key++} className="rounded bg-run/20 px-0.5 text-run">
        {text.slice(found, found + q.length)}
      </mark>,
    );
    i = found + q.length;
  }
  return <>{parts}</>;
}

function ResultRow({ result, query }: { result: SearchResult; query: string }) {
  const pill = TYPE_STYLE[result.type] ?? "bg-idle/12 text-idle ring-idle/30";
  return (
    <article className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-medium uppercase tracking-wide ring-1 ${pill}`}
        >
          {result.type}
        </span>
        <span className="truncate font-mono text-ink-faint">{result.projectLabel}</span>
        <span className="ml-auto truncate font-mono text-ink-faint">
          {result.sessionId.slice(0, 8)}
        </span>
      </header>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-ink-dim">
        <Highlight text={result.snippet} query={query} />
      </pre>
    </article>
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
function VaultHitRow({ hit }: { hit: VaultSearchHit }) {
  return (
    <a
      href={hit.href}
      className="block rounded-xl border border-line bg-surface p-3 transition hover:border-eye/40"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          {hit.kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{hit.title}</span>
        {hit.related && (
          <span
            className="rounded-full bg-eye/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-eye"
            title="Matched a term that co-occurs with your query in this machine's history, not the query itself"
          >
            related
          </span>
        )}
        <span className="font-mono text-[10px] text-ink-faint">
          <TimeAgo iso={hit.at} />
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-ink-dim">{hit.snippet}</p>
    </a>
  );
}

function VaultResults({ query }: { query: string }) {
  const { response, loading, error } = useVaultSearch(query);
  if (!query || query.length < 2) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
        Run history · indexed
      </h2>
      {error ? (
        <p className="text-xs text-fail">Couldn&apos;t reach the Vault: {error}</p>
      ) : !response.available && !loading ? (
        <p className="text-xs text-ink-faint">
          {response.detail || "The Vault is unavailable, so only transcripts were searched."}
        </p>
      ) : loading && response.hits.length === 0 ? (
        <SkeletonRows count={2} />
      ) : response.hits.length === 0 ? (
        <p className="text-xs text-ink-faint">{response.detail}</p>
      ) : (
        <>
          {response.relatedTerms.length > 0 && (
            <p className="mb-2 text-xs text-ink-faint">
              Also searched <span className="text-ink-dim">{response.relatedTerms.join(", ")}</span>{" "}
              — terms that co-occur with your query in this machine&apos;s own history, not a
              general language model.
            </p>
          )}
          <div className="flex flex-col gap-2">
            {response.hits.map((h) => (
              <VaultHitRow key={`${h.kind}:${h.ref}`} hit={h} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default function Search() {
  const [input, setInput] = useState("");
  const { results, loading, error, truncated } = useSearch(input);
  const trimmed = input.trim();

  return (
    <Page title="Search">
      <p className="mb-6 text-sm text-ink-faint">
        Indexed search over Argus&apos;s own run history, and a plain-text scan of every Claude Code
        transcript
      </p>

      <div className="mb-6">
        <label htmlFor="transcript-search" className="sr-only">
          Search transcripts
        </label>
        <input
          id="transcript-search"
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search transcripts…"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-ink placeholder:text-ink-faint transition focus:border-eye/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-eye/40"
        />
      </div>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      <VaultResults query={trimmed} />

      {!trimmed ? (
        <EmptyState>
          <p className="text-sm text-ink-dim">Type to search across transcripts.</p>
          <p className="mx-auto mt-2 max-w-md text-xs">
            Two indexes. The Vault answers from every run and alert Argus has recorded, including
            the ones the JSON files have since pruned. The transcript scan is plain-text and
            case-insensitive over the message text of every session Claude Code has written; newest
            transcripts are read first, so a recent phrase comes back immediately.
          </p>
        </EmptyState>
      ) : (
        <Handoff busy={loading} label="matches" skeleton={<SkeletonRows count={4} />}>
          {results.length === 0 ? (
            <div role="status">
              <EmptyState>
                <p className="text-sm text-ink-dim">No matches for &ldquo;{trimmed}&rdquo;.</p>
                <p className="mt-2 text-xs">
                  The search is literal, not fuzzy — try a shorter fragment, or ⌘K to jump to a
                  pipeline, schedule or session by name.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              {/* The scan stops at a cap; saying "100 matches" would turn a ceiling
              into a count the reader would take literally. */}
              <p role="status" className="mb-3 text-xs text-ink-faint">
                {truncated ? (
                  <>
                    first <span className="text-ink-dim">{results.length}</span> matches — narrow
                    the query to see the most relevant ones
                  </>
                ) : (
                  <>
                    {results.length} match{results.length === 1 ? "" : "es"}
                  </>
                )}
              </p>
              <div className="flex flex-col gap-3">
                {results.map((r, i) => (
                  <ResultRow key={`${r.project}/${r.sessionId}/${i}`} result={r} query={trimmed} />
                ))}
              </div>
            </>
          )}
        </Handoff>
      )}
    </Page>
  );
}
