import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { IrisMark } from "./IrisMark";

describe("IrisMark", () => {
  it("renders a sized canvas", () => {
    const { container } = render(<IrisMark size={40} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveAttribute("width", "40");
    expect(canvas).toHaveAttribute("height", "40");
  });
});
