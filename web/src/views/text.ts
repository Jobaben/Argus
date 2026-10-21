/**
 * Server text as a label. Detail lines, incident notes and issue titles are
 * written by the server as clauses ("last completed run failed", "exit code
 * 1") meant to follow something else, and printed as they came they were the
 * one lower-case line on a sentence-case screen. Capitalised here, at the
 * edge, rather than on the server: stored values (an issue's title is part of
 * what people search and file it by) stay exactly as they were recorded.
 */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
