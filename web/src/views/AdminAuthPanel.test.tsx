import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminAuthPanel } from "./AdminAuthPanel";

const noop = async () => {};

describe("AdminAuthPanel", () => {
  it("renders the bootstrap form when unconfigured", () => {
    render(<AdminAuthPanel configured={false} onLogin={noop} onSetup={noop} onRegister={noop} />);
    expect(screen.getByRole("form", { name: /create the root account/i })).toBeTruthy();
  });

  it("lets a visitor switch to registration and shows the pending notice", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    render(
      <AdminAuthPanel configured={true} onLogin={noop} onSetup={noop} onRegister={onRegister} />,
    );
    // Signing in is the default when configured.
    expect(screen.getByRole("form", { name: "Sign in" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /request an account/i }));
    await userEvent.type(screen.getByPlaceholderText(/username/i), "alice");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "alice password!");
    await userEvent.click(screen.getByRole("button", { name: /request account/i }));

    expect(onRegister).toHaveBeenCalledWith("alice", "alice password!");
    expect(await screen.findByText(/awaiting root approval/i)).toBeTruthy();
  });

  it("surfaces registration errors", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("username is already taken"));
    render(
      <AdminAuthPanel configured={true} onLogin={noop} onSetup={noop} onRegister={onRegister} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /request an account/i }));
    await userEvent.type(screen.getByPlaceholderText(/username/i), "alice");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "alice password!");
    await userEvent.click(screen.getByRole("button", { name: /request account/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already taken/i);
  });

  it("calls signing in what its button calls it, both ways", async () => {
    // The heading said "Login" over a "Sign in" button, and the way back from
    // registering said "Back to login".
    const user = userEvent.setup();
    render(<AdminAuthPanel configured={true} onLogin={noop} onSetup={noop} onRegister={noop} />);
    expect(screen.getByRole("heading", { level: 3, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /request an account/i }));
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByRole("form", { name: "Sign in" })).toBeInTheDocument();
  });

  it("starts a server's refusal as a sentence", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn().mockRejectedValue(new Error("invalid username or password"));
    render(<AdminAuthPanel configured={true} onLogin={onLogin} onSetup={noop} onRegister={noop} />);
    await user.type(screen.getByLabelText("Username"), "nobody");
    await user.type(screen.getByLabelText(/^password/i), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password");
  });

  it("opens focused, under an h2, where it is the page's main form", () => {
    render(
      <AdminAuthPanel
        configured={true}
        onLogin={noop}
        onSetup={noop}
        onRegister={noop}
        autoFocus
        headingLevel={2}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveFocus();
  });

  it("leaves focus alone and offers no Cancel unless asked to", () => {
    render(<AdminAuthPanel configured={true} onLogin={noop} onSetup={noop} onRegister={noop} />);
    expect(screen.getByLabelText("Username")).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("closes from Cancel or Escape when it was opened in place of something", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AdminAuthPanel
        configured={true}
        onLogin={noop}
        onSetup={noop}
        onRegister={noop}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByLabelText("Username"));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    // Escape that only drops an input method's half-typed word keeps the form.
    fireEvent.keyDown(screen.getByLabelText("Username"), { key: "Escape", isComposing: true });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
