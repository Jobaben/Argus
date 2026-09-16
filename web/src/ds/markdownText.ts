/**
 * The two decisions the Markdown renderer makes about text it did not write,
 * kept apart from the component so they can be imported (and tested) without
 * dragging React Fast Refresh into a file that also exports plain functions.
 */

/** Which artifact paths get the rendered view; everything else is raw text. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

/** A link keeps its `href` only for `http:`, `https:` and `mailto:`. */
export function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  return SAFE_SCHEMES.test(trimmed) ? trimmed : null;
}
