import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, ButtonLink } from "./Button";
import { Icon } from "./Icon";

/**
 * A per-route error boundary.
 *
 * Argus renders data it does not own — transcripts written by another machine,
 * job files from a newer CLI, run envelopes from an interrupted process. A
 * single unexpected shape in one view should cost that view, not the whole
 * dashboard: without a boundary, React unmounts the entire tree and the user
 * gets a blank page with no way back, losing the nav, the palette, and any
 * chance of reading a different tab to work out what happened.
 *
 * Reset is keyed on the route (see `resetKey`), so navigating away and back
 * clears the error without a reload, and "Try again" re-mounts the subtree for
 * the case where the failure was transient.
 */
interface Props {
  children: ReactNode;
  /** Human-readable name of what failed, for the message. */
  label: string;
  /** Changing this clears the error — pass the current route. */
  resetKey: string;
}

interface State {
  error: Error | null;
  /** Bumped by "Try again" to force a fresh subtree. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    // A different route means a different subtree; carrying the old error over
    // would make an unrelated view look broken.
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place a client-side stack survives; keep the
    // component stack with it, since the message alone rarely locates the row
    // that had the unexpected shape.
    console.error(`[argus] ${this.props.label} view crashed:`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return <div key={this.state.attempt}>{this.props.children}</div>;
    }
    return (
      <div className="mx-auto max-w-[1600px] px-4 py-10 sm:px-6">
        <div
          role="alert"
          className="max-w-3xl rounded-panel border border-fail/35 bg-gradient-to-b from-fail/[0.08] to-surface px-5 py-5 text-sm shadow-raised sm:px-6"
        >
          <div className="flex items-start gap-3">
            <Icon name="alert" size={20} className="mt-0.5 text-fail" />
            <div className="min-w-0 flex-1">
              <h2 className="text-heading font-semibold text-ink">
                Something broke in {this.props.label}
              </h2>
              <p className="mt-1.5 max-w-prose text-small leading-relaxed text-ink-dim">
                The rest of Argus is unaffected — the navigation, the command palette and every
                other view still work. This is almost always an unexpected shape in the data this
                view reads.
              </p>
            </div>
          </div>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-ground-2/80 p-3 font-mono text-caption text-fail-ink">
            {error.message}
          </pre>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" icon="retry" onClick={this.retry}>
              Try again
            </Button>
            <ButtonLink href="#/command" variant="ghost" size="sm">
              Command Center
            </ButtonLink>
            <span className="text-caption text-ink-faint">
              The full stack is in the browser console.
            </span>
          </div>
        </div>
      </div>
    );
  }
}
