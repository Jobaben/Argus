import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminAuthPanel } from "./AdminAuthPanel";

const noop = async () => {};

describe("AdminAuthPanel", () => {
  it("renders the bootstrap form when unconfigured", () => {
    render(
      <AdminAuthPanel configured={false} onLogin={noop} onSetup={noop} onRegister={noop} />,
    );
    expect(screen.getByRole("form", { name: /create the root account/i })).toBeTruthy();
  });

  it("lets a visitor switch to registration and shows the pending notice", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    render(
      <AdminAuthPanel configured={true} onLogin={noop} onSetup={noop} onRegister={onRegister} />,
    );
    // Login is the default when configured.
    expect(screen.getByRole("form", { name: /login/i })).toBeTruthy();

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
});
