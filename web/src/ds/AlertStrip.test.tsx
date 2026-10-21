import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertStrip } from "./AlertStrip";

describe("AlertStrip", () => {
  it("renders subject, message and a Failed badge for a failed run", () => {
    render(
      <AlertStrip
        tone="failed"
        subject="deploy-bot"
        message="exit 1 · ActiveMQ refused"
        when="4m ago"
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("deploy-bot")).toBeInTheDocument();
    expect(screen.getByText(/ActiveMQ refused/)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("does not call an error a failed run", () => {
    // A load error is Argus losing the server, not an agent failing: no
    // "Failed" badge, and room for the control that fixes it.
    render(
      <AlertStrip
        subject="Monitors"
        message="Couldn't load monitors: HTTP 500"
        action={<button type="button">Retry</button>}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/couldn't load monitors/i);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
