import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  // The button that was pressed is gone with the empty state, so focus would
  // fall back to the top of the document; it goes to the first field instead.
  useEffect(() => {
    if (open) formRef.current?.querySelector("input")?.focus();
  }, [open]);

  if (open) {
    return (
      <div ref={formRef}>
        <AdminAuthPanel
          configured={configured}
          onLogin={onLogin}
          onSetup={onSetup}
          onRegister={onRegister}
          purpose={purpose}
        />
      </div>
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
          onClick={() => setOpen(true)}
        >
          {configured ? signInLabel : "Create the root account"}
        </Button>
      }
    >
      {children}
    </EmptyState>
  );
}
