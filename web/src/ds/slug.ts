/**
 * Lowercase slug, matching the server's criterion-id rule.
 *
 * Applied as the user types rather than validated on submit, so a rubric field
 * cannot hold something the server will reject — the rule is visible in the
 * field's behaviour instead of in an error message after the fact.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);
}
