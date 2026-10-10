import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";

const chunk = vi.hoisted(() => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  return { pending, resolve, loaded: false };
});

vi.mock("./views/AdminAuthPanel", () => ({
  AdminAuthPanel: () => {
    if (!chunk.loaded) throw chunk.pending;
    return <form aria-label="Login" />;
  },
}));

it("keeps the sign-in wall and data isolation while the auth panel loads", async () => {
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
  expect(
    screen.getByText("This server requires an account. Sign in to see the dashboard."),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading sign in");
  expect(screen.queryByRole("link", { name: "Command Center" })).toBeNull();
  expect(fetchMock.mock.calls).toHaveLength(1);
  await act(async () => {
    chunk.loaded = true;
    chunk.resolve();
    await chunk.pending;
  });
  expect(await screen.findByRole("form", { name: "Login" })).toBeInTheDocument();
  expect(screen.queryByRole("status")).toBeNull();
  expect(fetchMock.mock.calls).toHaveLength(1);
});
