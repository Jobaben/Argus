import { Fragment, useMemo, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { safeHref } from "./markdownText";

/**
 * Markdown as React elements, for artifacts an agent wrote.
 *
 * `marked` only *lexes* here. Its tokens are mapped straight to elements, so no
 * HTML string is ever built and nothing is ever set as `innerHTML` — which is
 * what makes rendering agent-authored text safe without a sanitizer:
 *
 *  - raw HTML in the source (`<script>`, `<img onerror>`) renders as visible
 *    text, never as markup;
 *  - a link keeps its `href` only for `http:`, `https:` and `mailto:`; any
 *    other scheme renders as plain text;
 *  - an image never loads — viewing a review must not make the browser fetch
 *    from wherever an agent pointed — so it renders as its alt text.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/** Markdown decodes entity references; `marked` leaves them for an HTML
 *  renderer to pass through, so the few common ones are decoded here. */
function unescapeText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m] ?? m);
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-5 mb-2 text-[17px] font-semibold text-ink first:mt-0",
  2: "mt-5 mb-2 text-[15px] font-semibold text-ink first:mt-0",
  3: "mt-4 mb-1.5 text-[13.5px] font-semibold text-ink first:mt-0",
  4: "mt-3 mb-1 text-[12.5px] font-semibold uppercase tracking-[0.04em] text-ink-dim first:mt-0",
  5: "mt-3 mb-1 text-[12px] font-semibold text-ink-dim first:mt-0",
  6: "mt-3 mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint first:mt-0",
};

function renderInline(tokens: Token[] | undefined): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => <Fragment key={i}>{inline(t)}</Fragment>);
}

function inline(token: Token): ReactNode {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      // A list item's first line is a `text` token that carries its own inline
      // tokens; a leaf `text` token is just the words.
      return t.tokens ? renderInline(t.tokens) : unescapeText(t.text);
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong":
      return <strong className="font-semibold text-ink">{renderInline(token.tokens)}</strong>;
    case "em":
      return <em>{renderInline(token.tokens)}</em>;
    case "del":
      return <del className="text-ink-faint">{renderInline(token.tokens)}</del>;
    case "codespan":
      return (
        <code className="rounded bg-surface-2 px-1 py-px font-mono text-[0.92em] text-ink">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case "br":
      return <br />;
    case "link": {
      const t = token as Tokens.Link;
      const href = safeHref(t.href);
      if (!href) return <span>{renderInline(t.tokens)}</span>;
      return (
        <a
          href={href}
          title={t.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="text-queue underline decoration-queue/40 underline-offset-2 hover:decoration-queue"
        >
          {renderInline(t.tokens)}
        </a>
      );
    }
    case "image": {
      const t = token as Tokens.Image;
      return (
        <span
          data-testid="md-image"
          title={t.href}
          className="rounded border border-dashed border-line px-1.5 py-px font-mono text-[0.85em] text-ink-faint"
        >
          [image: {t.text || "untitled"}]
        </span>
      );
    }
    case "html":
      // Never markup. The text is what the agent wrote, shown as such.
      return <span className="font-mono text-ink-faint">{(token as Tokens.HTML).text}</span>;
    default:
      return "raw" in token ? (token as { raw: string }).raw : null;
  }
}

function block(token: Token, key: number): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const t = token as Tokens.Heading;
      const depth = Math.min(6, Math.max(1, t.depth));
      const Tag = `h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={key} className={HEADING_CLASS[depth]}>
          {renderInline(t.tokens)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="my-2 leading-relaxed">
          {renderInline((token as Tokens.Paragraph).tokens)}
        </p>
      );
    case "text": {
      // A tight list item's body arrives as a bare text token at block level.
      const t = token as Tokens.Text;
      return (
        <Fragment key={key}>{t.tokens ? renderInline(t.tokens) : unescapeText(t.text)}</Fragment>
      );
    }
    case "code": {
      const t = token as Tokens.Code;
      return (
        <pre
          key={key}
          data-lang={t.lang || undefined}
          className="my-2 overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed text-ink-dim"
        >
          <code>{t.text}</code>
        </pre>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key} className="my-2 border-l-2 border-line pl-3 text-ink-dim [&>p]:my-1">
          {renderBlocks((token as Tokens.Blockquote).tokens)}
        </blockquote>
      );
    case "list": {
      const t = token as Tokens.List;
      const Tag = t.ordered ? "ol" : "ul";
      const start = t.ordered && t.start !== "" && t.start !== 1 ? Number(t.start) : undefined;
      return (
        <Tag
          key={key}
          start={start}
          className={`my-2 pl-5 ${t.ordered ? "list-decimal" : "list-disc"} marker:text-ink-faint [&_ul]:my-0.5 [&_ol]:my-0.5`}
        >
          {t.items.map((item, i) => (
            <li key={i} className="my-0.5 leading-relaxed">
              {item.task && (
                <input
                  type="checkbox"
                  checked={Boolean(item.checked)}
                  readOnly
                  disabled
                  aria-label={item.checked ? "done" : "not done"}
                  className="mr-1.5 align-[-1px]"
                />
              )}
              {renderBlocks(item.tokens)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table": {
      const t = token as Tokens.Table;
      const alignClass = (a: string | null) =>
        a === "center" ? "text-center" : a === "right" ? "text-right" : "text-left";
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th
                    key={i}
                    className={`border-b border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint ${alignClass(cell.align)}`}
                  >
                    {renderInline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r} className="border-b border-line/50 last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className={`px-2 py-1 align-top ${alignClass(cell.align)}`}>
                      {renderInline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      return <hr key={key} className="my-4 border-line" />;
    case "html":
      // A block of raw HTML shows as what it is: text the agent wrote.
      return (
        <pre
          key={key}
          data-testid="md-raw-html"
          className="my-2 overflow-x-auto rounded-lg border border-dashed border-line p-2 font-mono text-[11px] text-ink-faint"
        >
          {(token as Tokens.HTML).text.trimEnd()}
        </pre>
      );
    case "def":
      return null;
    default:
      return (
        <p key={key} className="my-2 leading-relaxed">
          {"raw" in token ? (token as { raw: string }).raw : null}
        </p>
      );
  }
}

function renderBlocks(tokens: Token[] | undefined): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => block(t, i));
}

export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  const tokens = useMemo(() => marked.lexer(source, { gfm: true }), [source]);
  return (
    <div data-testid="markdown" className={`text-[12.5px] text-ink-dim ${className}`}>
      {renderBlocks(tokens)}
    </div>
  );
}
