import { useState, type ReactNode } from "react";
import { Button, EmptyState, type IconName } from "../ds";
import { AdminAuthPanel, type AuthPurpose } from "./AdminAuthPanel";

/**
 * An empty page whose next step is an account: what would be here, and the way
 * to the form that makes it possible, in one region.
 *
 * Pipelines used to stack the sign-in form above an empty state that said "sign
 * in above" — two regions making one point — and Users sent the reader to
 * another tab for a form it could have shown. The empty state now explains,
 * and its action opens the form in its place, with the caret in its first
 * field, so the page says one thing at a time.
 *
 * Opened by mistake, it closes again: Cancel, or Escape, puts the empty state
 * back — on Pipelines that is also the explanation of what a pipeline is,
 * which the form had replaced — with focus on the action that opened it.
 */
export function AccountPrompt({
  configured,
  onLogin,
  onSetup,
  onRegister,
  icon,
  title,
  signInLabel = "Sign in",
  purpose,
  children,
}: {
  /** Whether a root account exists. Without one, the form creates it. */
  configured: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onSetup: (username: string, password: string) => Promise<void>;
  onRegister: (username: string, password: string) => Promise<void>;
  icon: IconName;
  title: ReactNode;
  /** The action's words on a configured server. */
  signInLabel?: string;
  /** What the account is for, for the form's first line. */
  purpose?: AuthPurpose;
  children: ReactNode;
}) {
  // "cancelled" is closed again after being open. The button that was pressed
  // goes with the empty state and comes back with it, so each way focus would
  // fall to the top of the document; it goes to the form's first field on the
  // way in, and to the re-mounted button on the way out.
  const [state, setState] = useState<"closed" | "open" | "cancelled">("closed");

  if (state === "open") {
    return (
      <AdminAuthPanel
        configured={configured}
        onLogin={onLogin}
        onSetup={onSetup}
        onRegister={onRegister}
        purpose={purpose}
        autoFocus
        // The form stands in for the page's empty state, directly under its h1.
        headingLevel={2}
        onCancel={() => setState("cancelled")}
      />
    );
  }
  return (
    <EmptyState
      icon={icon}
      title={title}
      action={
        <Button
          variant="primary"
          icon={configured ? "user" : "shield"}
          autoFocus={state === "cancelled"}
          onClick={() => setState("open")}
        >
          {configured ? signInLabel : "Create the root account"}
        </Button>
      }
    >
      {children}
    </EmptyState>
  );
}
