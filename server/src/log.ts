/**
 * One logger for the whole server.
 *
 * Argus runs unattended — it fires agents that spend money while nobody is
 * watching — so when something goes wrong the log is the only witness. Ad-hoc
 * `console.error("[argus] thing failed:", e)` calls were readable but not
 * greppable, not filterable, and dropped the one field that makes an incident
 * reconstructible: which request the failure belonged to.
 *
 * Two output modes, same call sites:
 *
 * - **text** (default) — `18:04:12 WARN  budget check failed  err=EACCES`,
 *   aligned and skimmable for someone watching a terminal.
 * - **json** (`ARGUS_LOG_FORMAT=json`) — one JSON object per line, for anyone
 *   shipping this into a log pipeline.
 *
 * `ARGUS_LOG_LEVEL` (debug|info|warn|error|silent) gates output; the default is
 * `info`, so per-request lines stay off until asked for.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger that stamps `fields` onto every line — e.g. a request id. */
  child(fields: Fields): Logger;
}

function resolveLevel(raw: string | undefined): LogLevel {
  const v = (raw ?? "").trim().toLowerCase();
  return v in ORDER ? (v as LogLevel) : "info";
}

/** Errors do not survive JSON.stringify; keep the message and the stack. */
function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  return value;
}

/** `key=value`, quoting only when the value would otherwise be ambiguous. */
function renderField(key: string, value: unknown): string {
  const v = normalize(value);
  if (v instanceof Object) {
    const err = v as { message?: string };
    if (typeof err.message === "string") return `${key}=${JSON.stringify(err.message)}`;
    return `${key}=${JSON.stringify(v)}`;
  }
  const s = String(v);
  return /[\s"]/.test(s) ? `${key}=${JSON.stringify(s)}` : `${key}=${s}`;
}

const PAD: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

export interface LoggerOptions {
  level?: LogLevel;
  format?: "text" | "json";
  /** Injectable sink, so tests can capture instead of writing to the console. */
  write?: (level: Exclude<LogLevel, "silent">, line: string) => void;
  now?: () => Date;
  base?: Fields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? resolveLevel(process.env.ARGUS_LOG_LEVEL);
  const format =
    opts.format ?? (process.env.ARGUS_LOG_FORMAT === "json" ? "json" : ("text" as const));
  const now = opts.now ?? (() => new Date());
  const base = opts.base ?? {};
  const write =
    opts.write ??
    ((lvl, line) => {
      if (lvl === "error") console.error(line);
      else if (lvl === "warn") console.warn(line);
      else console.log(line);
    });

  function emit(lvl: Exclude<LogLevel, "silent">, msg: string, fields?: Fields): void {
    if (ORDER[lvl] < ORDER[level]) return;
    const all = { ...base, ...fields };
    if (format === "json") {
      const record: Fields = { ts: now().toISOString(), level: lvl, msg };
      for (const [k, v] of Object.entries(all)) record[k] = normalize(v);
      write(lvl, JSON.stringify(record));
      return;
    }
    const time = now().toISOString().slice(11, 19);
    const rendered = Object.entries(all).map(([k, v]) => renderField(k, v));
    write(lvl, [`${time} ${PAD[lvl]} ${msg}`, ...rendered].join("  "));
  }

  const logger: Logger = {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, level, format, base: { ...base, ...fields } }),
  };
  return logger;
}

/** The process-wide logger. Modules import this; tests build their own. */
export const log: Logger = createLogger();
