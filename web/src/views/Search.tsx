import { useState } from "react";
import { useSearch, type SearchResult } from "../useSearch";
import { AlertStrip, EmptyState, Page } from "../ds";

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

export default function Search() {
  const [input, setInput] = useState("");
  const { results, loading, error } = useSearch(input);
  const trimmed = input.trim();

  return (
    <Page title="Search">
      <p className="mb-6 text-sm text-ink-faint">
        Plain-text search across every Claude Code transcript
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

      {!trimmed ? (
        <EmptyState>Type to search across transcripts.</EmptyState>
      ) : loading ? (
        <p className="text-ink-faint">Searching…</p>
      ) : results.length === 0 ? (
        <EmptyState>No matches for "{trimmed}".</EmptyState>
      ) : (
        <>
          <p className="mb-3 text-xs text-ink-faint">
            {results.length} match{results.length === 1 ? "" : "es"}
          </p>
          <div className="flex flex-col gap-3">
            {results.map((r, i) => (
              <ResultRow key={`${r.project}/${r.sessionId}/${i}`} result={r} query={trimmed} />
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
