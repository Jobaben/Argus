import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./views/AdminAuthPanel", async () => {
  throw new Error("Sign-in chunk unavailable");
});

it("retains the sign-in wall and avoids data reads when the auth import fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({ configured: true, authenticated: false, sessionRequired: true }),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    render(<App />);
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Sign in");
  expect(
    screen.getByText("This server requires an account. Sign in to see the dashboard."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Login" })).toBeNull();
  expect(fetchMock.mock.calls).toHaveLength(1);
});
