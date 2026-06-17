import { useState } from "react";
import { useSearch, type SearchResult } from "../useSearch";

const TYPE_STYLE: Record<string, string> = {
  user: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  assistant: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
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
      <mark
        key={key++}
        className="rounded bg-amber-400/25 px-0.5 text-amber-200"
      >
        {text.slice(found, found + q.length)}
      </mark>,
    );
    i = found + q.length;
  }
  return <>{parts}</>;
}

function ResultRow({ result, query }: { result: SearchResult; query: string }) {
  const pill =
    TYPE_STYLE[result.type] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30";
  return (
    <article className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <header className="flex items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-medium uppercase tracking-wide ring-1 ${pill}`}
        >
          {result.type}
        </span>
        <span className="truncate font-mono text-white/40">
          {result.projectLabel}
        </span>
        <span className="ml-auto truncate font-mono text-white/30">
          {result.sessionId.slice(0, 8)}
        </span>
      </header>
      <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-white/75">
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
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">Search</h2>
        <p className="mt-1 text-sm text-white/45">
          Plain-text search across every Claude Code transcript
        </p>
      </header>

      <div className="mb-6">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search transcripts…"
          className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/25 focus:bg-white/[0.05]"
        />
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {!trimmed ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          Type to search across transcripts.
        </div>
      ) : loading ? (
        <p className="text-white/40">Searching…</p>
      ) : results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No matches for “{trimmed}”.
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-white/40">
            {results.length} match{results.length === 1 ? "" : "es"}
          </p>
          <div className="flex flex-col gap-3">
            {results.map((r, i) => (
              <ResultRow
                key={`${r.project}/${r.sessionId}/${i}`}
                result={r}
                query={trimmed}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
