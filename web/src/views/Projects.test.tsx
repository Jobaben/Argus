import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project } from "../useProjects";
import Projects from "./Projects";

const mockState: { projects: Project[]; loading: boolean; error: string | null } = {
  projects: [],
  loading: false,
  error: null,
};

vi.mock("../useProjects", () => ({
  useProjects: () => ({ ...mockState, refresh: vi.fn() }),
}));

const project = (over: Partial<Project> = {}): Project => ({
  id: "-home-me-api",
  label: "/home/me/api",
  sessionCount: 3,
  lastActivity: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  ...over,
});

describe("Projects", () => {
  beforeEach(() => {
    mockState.projects = [];
    mockState.loading = false;
    mockState.error = null;
  });

  it("leads with the directory name and keeps the full path available", () => {
    mockState.projects = [project()];
    render(<Projects />);
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getAllByTitle("/home/me/api").length).toBeGreaterThan(0);
  });

  it("renders a live relative timestamp rather than a frozen one", () => {
    // This used to be a local formatter that read the clock during render and
    // never revisited it.
    mockState.projects = [project()];
    render(<Projects />);
    // The shared clock quantises to a 15s tick, so the minute can land either side.
    expect(screen.getByText(/(2h|1h 59m) ago/)).toBeInTheDocument();
  });

  it("pluralises the session count", () => {
    mockState.projects = [project({ sessionCount: 1 })];
    render(<Projects />);
    expect(screen.getByText("1 session")).toBeInTheDocument();
  });

  it("shows the empty state and surfaces an error", () => {
    render(<Projects />);
    expect(screen.getByText(/No projects found yet/)).toBeInTheDocument();
    mockState.error = "boom";
    render(<Projects />);
    expect(screen.getByText(/Couldn't load projects: boom/)).toBeInTheDocument();
  });
});
