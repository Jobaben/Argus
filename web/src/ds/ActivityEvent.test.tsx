import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityEvent } from "./ActivityEvent";

describe("ActivityEvent", () => {
  it("renders time and content", () => {
    render(<ActivityEvent time="18:10">deploy-bot failed</ActivityEvent>);
    expect(screen.getByText("18:10")).toBeInTheDocument();
    expect(screen.getByText("deploy-bot failed")).toBeInTheDocument();
  });
});
