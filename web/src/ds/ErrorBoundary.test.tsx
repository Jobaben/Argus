import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ throws }: { throws: boolean }): React.ReactElement {
  if (throws) throw new Error("Cannot read properties of undefined (reading 'phases')");
  return <p>the view</p>;
}

beforeEach(() => {
  // React logs every caught error; the boundary logs its own line. Neither is
  // interesting here and both are noisy.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary label="Command Center" resetKey="command">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("the view")).toBeInTheDocument();
  });

  it("names the view that failed and shows the message, as an alert", () => {
    render(
      <ErrorBoundary label="Command Center" resetKey="command">
        <Boom throws />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something broke in Command Center");
    expect(alert).toHaveTextContent("reading 'phases'");
  });

  it("promises the rest of the app still works, and offers a way out", () => {
    render(
      <ErrorBoundary label="Chronicle" resetKey="chronicle">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/rest of Argus is unaffected/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /command center/i })).toHaveAttribute(
      "href",
      "#/command",
    );
  });

  it("logs the error and the component stack for diagnosis", () => {
    render(
      <ErrorBoundary label="Monitors" resetKey="monitors">
        <Boom throws />
      </ErrorBoundary>,
    );
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.flat();
    expect(logged.some((arg) => String(arg).includes("Monitors view crashed"))).toBe(true);
  });

  it("stays latched until Try again, then renders the recovered view", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ErrorBoundary label="Issues" resetKey="issues">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The underlying cause is fixed, but a boundary cannot know that — it stays
    // latched rather than silently re-rendering a subtree that just threw.
    rerender(
      <ErrorBoundary label="Issues" resetKey="issues">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("the view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the error when the route changes, so an unrelated view is not blamed", () => {
    const { rerender } = render(
      <ErrorBoundary label="Command Center" resetKey="command">
        <Boom throws />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    rerender(
      <ErrorBoundary label="Monitors" resetKey="monitors">
        <Boom throws={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("the view")).toBeInTheDocument();
  });
});
