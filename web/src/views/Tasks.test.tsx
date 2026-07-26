import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "../useTasks";
import Tasks from "./Tasks";

const mockState: { tasks: Task[]; loading: boolean; error: string | null } = {
  tasks: [],
  loading: false,
  error: null,
};

vi.mock("../useTasks", () => ({
  useTasks: () => ({ ...mockState, refresh: vi.fn() }),
}));

const task = (over: Partial<Task> = {}): Task => ({
  id: "refactor-auth",
  highwatermark: 4,
  fileCount: 12,
  locked: false,
  updatedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
  ...over,
});

describe("Tasks", () => {
  beforeEach(() => {
    mockState.tasks = [];
    mockState.loading = false;
    mockState.error = null;
  });

  it("shows the id, watermark, file count and lock state", () => {
    mockState.tasks = [task({ locked: true })];
    render(<Tasks />);
    expect(screen.getByText("refactor-auth")).toBeInTheDocument();
    expect(screen.getByText("hwm 4")).toBeInTheDocument();
    expect(screen.getByText("12 files")).toBeInTheDocument();
    expect(screen.getByText("locked")).toBeInTheDocument();
  });

  it("renders a live relative timestamp rather than a frozen one", () => {
    mockState.tasks = [task()];
    render(<Tasks />);
    // The shared clock quantises to a 15s tick, so the minute can land either side.
    expect(screen.getByText(/1h (29|30)m ago/)).toBeInTheDocument();
  });

  it("omits the watermark chip when there is none", () => {
    mockState.tasks = [task({ highwatermark: null })];
    render(<Tasks />);
    expect(screen.queryByText(/hwm/)).toBeNull();
  });

  it("shows the empty state and surfaces an error", () => {
    render(<Tasks />);
    expect(screen.getByText(/No task directories found yet/)).toBeInTheDocument();
    mockState.error = "boom";
    render(<Tasks />);
    expect(screen.getByText(/Couldn't reach the Argus server: boom/)).toBeInTheDocument();
  });
});
