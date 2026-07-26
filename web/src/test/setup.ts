import "@testing-library/jest-dom/vitest";

// jsdom implements layout as a no-op, so it ships no `scrollIntoView`. Every
// real browser has had it for a decade, and keeping the product code free of
// `?.` guards for an environment gap is worth one line here.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* layout is not simulated in jsdom */
  };
}
