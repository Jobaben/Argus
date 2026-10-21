/**
 * The icon set: one stroke weight, one grid, one module.
 *
 * Every icon in the app used to be a Unicode glyph — ◔ for the bell, ⌕ for
 * search, ☰ ✕ ⋯ ▾ ▶ — which meant every icon was drawn by whichever fallback
 * font the operating system found, at whatever size and baseline it chose. On
 * Linux the bell rendered as a three-pixel dot. These are drawn on a 24px grid
 * with a 1.75 stroke and round joins, the same geometry as Hellix's terminals,
 * so an icon beside a label looks like it was set in the same face.
 *
 * Paths, not components: the whole set is a few kilobytes of strings in the
 * shell, and one `<path>` per icon (circles are written as two arcs) keeps the
 * DOM to two nodes however intricate the drawing.
 */
const PATHS = {
  search: "M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13Z M20 20l-4.4-4.4",
  bell: "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.75h-15L6 16.5Z M10 21h4",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  more: "M6.9 12a.9.9 0 1 1-1.8 0a.9.9 0 0 1 1.8 0Z M12.9 12a.9.9 0 1 1-1.8 0a.9.9 0 0 1 1.8 0Z M18.9 12a.9.9 0 1 1-1.8 0a.9.9 0 0 1 1.8 0Z",
  "chevron-down": "m6.5 9.5 5.5 5.5 5.5-5.5",
  "chevron-up": "m6.5 14.5 5.5-5.5 5.5 5.5",
  "chevron-right": "m9.5 6.5 5.5 5.5-5.5 5.5",
  "chevron-left": "m14.5 6.5-5.5 5.5 5.5 5.5",
  "arrow-right": "M5 12h14M13.5 6.5 19 12l-5.5 5.5",
  "arrow-up": "M12 19V5M6.5 10.5 12 5l5.5 5.5",
  "arrow-down": "M12 5v14M6.5 13.5 12 19l5.5-5.5",
  external: "M8 16 16.5 7.5M9.5 7.5h7v7",
  check: "m5 12.5 4.5 4.5L19 7.5",
  "check-circle": "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z m-3.5 8.75 2.5 2.5 4.75-5",
  "x-circle": "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z M9.25 9.25l5.5 5.5m0-5.5-5.5 5.5",
  alert:
    "M10.3 4.5a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3l7-12.1Z M12 9.5v4 M12 16.6v.4",
  info: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z M12 11v5 M12 7.9v.4",
  play: "M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7Z",
  pause: "M9 5.5v13M15 5.5v13",
  stop: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z",
  retry: "M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 8.8 M4.5 4.5v4.3h4.3",
  plus: "M12 5v14M5 12h14",
  edit: "M15 5.5 18.5 9 8.5 19H5v-3.5l10-10Z M13 7.5l3.5 3.5",
  trash:
    "M4.5 7h15 M9.5 7V5h5v2 M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7 M10 11v5M14 11v5",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z M12 7.5V12l3 2",
  calendar:
    "M5.5 5.5h13a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z M4.5 10h15 M8.5 3.5v4M15.5 3.5v4",
  /** A person with a check: the gate, where a human decides. */
  approve:
    "M9.5 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7Z M3.5 20c.6-3.2 3-5 6-5s5.4 1.8 6 5 M15.5 11.5l2 2 4-4",
  /** Three nodes, two edges: a pipeline. */
  pipeline:
    "M8.5 6a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z M8.5 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z M20.5 12a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0Z M6 8.5v7 M8.4 6.8c3.3.5 6 2 7.3 3.6 M8.4 17.2c3.3-.5 6-2 7.3-3.6",
  terminal:
    "M5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z M8 9.5l3 2.5-3 2.5 M13 15h3.5",
  file: "M6.5 3.5h7.5l4.5 4.5v11.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z M13.5 3.5v5h5",
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z M14.75 12a2.75 2.75 0 1 1-5.5 0a2.75 2.75 0 0 1 5.5 0Z",
  copy: "M9.5 8.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3",
  logout: "M9.5 4.5h-4v15h4 M14 8l4 4-4 4 M18 12H9",
  user: "M12 11.5a4 4 0 1 0 0-8a4 4 0 0 0 0 8Z M4.5 20.5c.8-3.5 3.7-5.5 7.5-5.5s6.7 2 7.5 5.5",
  bolt: "M13 3 5 13.5h6.5L11 21l8-10.5h-6.5L13 3Z",
  inbox: "M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20",
  activity: "M3 12h4l2.5-6.5 5 13 2.5-6.5h4",
  coin: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17Z M14.5 9.25c-.4-.9-1.4-1.5-2.6-1.5-1.5 0-2.6.8-2.6 1.9 0 2.6 5.4 1.4 5.4 4.1 0 1.2-1.2 2-2.9 2-1.4 0-2.5-.6-2.8-1.6 M12 6.5v1.25M12 16.25v1.25",
  keyboard:
    "M4.5 6.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M8 14h8",
  sliders: "M4 7h9.5M17.5 7H20M4 17h2.5M10.5 17H20 M15.5 5v4M8.5 15v4",
  sparkle:
    "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z M18.5 16v4M16.5 18h4",
  history: "M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 8.8 M4.5 4.5v4.3h4.3 M12 8v4l2.5 1.5",
  /** Play it back: a turn of the dial around a small play mark — distinct from
   *  `play`, which starts something new. */
  replay:
    "M4.5 12a7.5 7.5 0 1 0 2.4-5.5L4.5 8.8 M4.5 4.5v4.3h4.3 M10.5 9.6v4.8a.5.5 0 0 0 .8.4l3.6-2.4a.5.5 0 0 0 0-.8l-3.6-2.4a.5.5 0 0 0-.8.4Z",
  dot: "M14 12a2 2 0 1 1-4 0a2 2 0 0 1 4 0Z",
  minus: "M5 12h14",
  /** Plain shapes, for marks where the *shape* is the category (the Knowledge
   *  view's claim kinds), so colour stays free to mean status. */
  diamond: "M12 4.5 19.5 12 12 19.5 4.5 12 12 4.5Z",
  square: "M7 6.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5V7a.5.5 0 0 1 .5-.5Z",
  "circle-dot":
    "M12 5.25a6.75 6.75 0 1 0 0 13.5a6.75 6.75 0 0 0 0-13.5Z M13.1 12a1.1 1.1 0 1 1-2.2 0a1.1 1.1 0 0 1 2.2 0Z",
  "circle-dashed":
    "M13.17 5.35A6.75 6.75 0 0 1 17.17 7.66 M18.34 9.69A6.75 6.75 0 0 1 18.34 14.31 M17.17 16.34A6.75 6.75 0 0 1 13.17 18.65 M10.83 18.65A6.75 6.75 0 0 1 6.83 16.34 M5.66 14.31A6.75 6.75 0 0 1 5.66 9.69 M6.83 7.66A6.75 6.75 0 0 1 10.83 5.35",
  triangle: "M12 5.5l7 12.5H5l7-12.5Z",
  star: "M12 4.75 14 9.75l5.37.36-4.14 3.44 1.33 5.22L12 15.9l-4.56 2.87 1.33-5.22-4.14-3.44L10 9.75 12 4.75Z",
  shield: "M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6l7-2.5Z M9 12l2.2 2.2L15.5 10",
  layers: "M12 4 3.5 8.5 12 13l8.5-4.5L12 4Z M3.5 12.5 12 17l8.5-4.5 M3.5 16 12 20.5l8.5-4.5",
  folder: "M4.5 6.5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-11Z",
  link: "M10 14a4 4 0 0 0 5.7.3l2.8-2.8a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7-.3l-2.8 2.8a4 4 0 0 0 5.7 5.7l1-1",
  /** Transport: to the previous / next event on a recording. */
  "skip-back":
    "M6.5 6v12 M17.5 6.6v10.8a.7.7 0 0 1-1.1.6l-8-5.4a.7.7 0 0 1 0-1.2l8-5.4a.7.7 0 0 1 1.1.6Z",
  "skip-forward":
    "M17.5 6v12 M6.5 6.6v10.8a.7.7 0 0 0 1.1.6l8-5.4a.7.7 0 0 0 0-1.2l-8-5.4a.7.7 0 0 0-1.1.6Z",
  /** Where something began: a run's first event. */
  flag: "M5.5 20.5v-16 M5.5 4.5h11l-2.5 4 2.5 4h-11",
  /** A speech bubble: a message in a transcript. */
  message:
    "M5.5 5h13a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16h-.5A1.5 1.5 0 0 1 4 14.5v-8A1.5 1.5 0 0 1 5.5 5Z",
  /** The bell, struck through: quiet hours held a notification back. */
  "bell-off": "M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.75h-15L6 16.5Z M10 21h4 M4.5 4.5l15 15",
  /** On/off: whether a pipeline's trigger may fire at all. */
  power: "M12 3.5v8 M17.3 7.2a7.5 7.5 0 1 1-10.6 0",
  /** A dial: a score read against a scale (a run's verdict). */
  gauge: "M6.34 18.66a8 8 0 1 1 11.32 0 M12 13l3.25-3.25",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className = "",
  label,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** An accessible name, for the rare icon that stands alone and means
   *  something. Omit it (the default) and the icon is decoration. */
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
