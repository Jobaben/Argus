import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { log as defaultLog, type Logger } from "./log.js";

/**
 * Per-request logging with a correlation id.
 *
 * Every request gets an id, echoed back as `x-request-id` so a UI bug report
 * ("the board went blank at 14:02") can be tied to the exact server-side line,
 * including the one an unhandled route error wrote. The id is honoured if the
 * caller already sent one, so a proxy's trace id wins over ours.
 *
 * Volume discipline matters more than completeness here: a live dashboard fires
 * dozens of GETs a minute, so successful reads log at `debug` and stay silent
 * by default. Client errors log at `warn`, server errors at `error` — those you
 * always want, unasked.
 */

export interface RequestLogOptions {
  logger?: Logger;
  /** Injectable clock for tests; must be monotonic-ish, milliseconds. */
  clock?: () => number;
  /** Injectable id source for tests. */
  newId?: () => string;
}

/**
 * Set by the middleware so handlers and the error boundary can log in context.
 * Declared as a Hono context-variable augmentation rather than an app generic,
 * so `c.get("log")` is typed everywhere without threading a type parameter
 * through every route signature.
 */
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    log: Logger;
  }
}

export function requestLog(opts: RequestLogOptions = {}): MiddlewareHandler {
  const base = opts.logger ?? defaultLog;
  const clock = opts.clock ?? (() => Date.now());
  const newId = opts.newId ?? (() => randomUUID().slice(0, 8));

  return async (c, next) => {
    const requestId = c.req.header("x-request-id")?.slice(0, 64) || newId();
    const scoped = base.child({ reqId: requestId });
    c.set("requestId", requestId);
    c.set("log", scoped);
    c.header("x-request-id", requestId);

    const started = clock();
    await next();
    const ms = clock() - started;
    const status = c.res.status;
    const fields = { method: c.req.method, path: c.req.path, status, ms };

    if (status >= 500) scoped.error("request failed", fields);
    else if (status >= 400) scoped.warn("request rejected", fields);
    else scoped.debug("request", fields);
  };
}
