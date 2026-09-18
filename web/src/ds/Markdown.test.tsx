import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { isMarkdown, safeHref } from "./markdownText";

describe("isMarkdown", () => {
  it("matches .md and .markdown in any case, nothing else", () => {
    expect(isMarkdown("report.md")).toBe(true);
    expect(isMarkdown("notes/README.MD")).toBe(true);
    expect(isMarkdown("a.markdown")).toBe(true);
    expect(isMarkdown("a.txt")).toBe(false);
    expect(isMarkdown("md")).toBe(false);
    expect(isMarkdown("a.md.bak")).toBe(false);
  });
});

describe("safeHref", () => {
  it("keeps http, https and mailto; drops everything else", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("http://x")).toBe("http://x");
    expect(safeHref("mailto:a@b")).toBe("mailto:a@b");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});

describe("Markdown", () => {
  it("renders headings, paragraphs, emphasis and inline code as elements", () => {
    render(
      <Markdown source={"# Title\n\nSome **bold** and *em* and `code` and ~~gone~~.\n\n## Sub"} />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Sub");
    expect(screen.queryByText("# Title")).toBeNull();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("em").tagName).toBe("EM");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("renders ordered, unordered, nested and task lists", () => {
    render(<Markdown source={"1. one\n2. two\n\n- a\n  - nested\n- [x] done\n- [ ] todo"} />);
    const lists = screen.getAllByRole("list");
    expect(lists[0].tagName).toBe("OL");
    expect(lists[1].tagName).toBe("UL");
    expect(screen.getByText("nested").closest("ul")?.parentElement?.tagName).toBe("LI");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[0]).toBeDisabled();
  });

  it("renders a GFM table with header cells and alignment", () => {
    render(<Markdown source={"| a | b |\n|---|:-:|\n| 1 | 2 |"} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["a", "b"]);
    expect(screen.getByRole("columnheader", { name: "b" })).toHaveClass("text-center");
    expect(screen.getAllByRole("cell").map((c) => c.textContent)).toEqual(["1", "2"]);
  });

  it("renders fenced code with its language, blockquotes and rules", () => {
    const { container } = render(
      <Markdown source={"```ts\nconst x = 1;\n```\n\n> quoted\n\n---"} />,
    );
    const pre = container.querySelector("pre[data-lang='ts']");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("const x = 1;");
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("keeps safe links, with a hardened target, and flattens unsafe ones to text", () => {
    render(<Markdown source={"[ok](https://example.com) and [bad](javascript:alert(1)) here"} />);
    const ok = screen.getByRole("link", { name: "ok" });
    expect(ok).toHaveAttribute("href", "https://example.com");
    expect(ok).toHaveAttribute("rel", "noopener noreferrer");
    expect(ok).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText("bad")).toBeInTheDocument();
  });

  it("shows raw HTML as text, never as markup", () => {
    const { container } = render(
      <Markdown
        source={'before <b onmouseover="x()">inline</b> after\n\n<script>alert(1)</script>\n'}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText('<b onmouseover="x()">')).toBeInTheDocument();
    expect(screen.getByTestId("md-raw-html")).toHaveTextContent("<script>alert(1)</script>");
  });

  it("never loads an image; renders its alt text instead", () => {
    const { container } = render(<Markdown source={"![diagram](http://evil.example/track.png)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("md-image")).toHaveTextContent("[image: diagram]");
  });

  it("decodes entity references the way markdown does", () => {
    const { container } = render(<Markdown source={"Fish &amp; chips, 1 &lt; 2"} />);
    expect(container.querySelector("p")?.textContent).toBe("Fish & chips, 1 < 2");
  });

  it("renders an empty source as an empty container", () => {
    render(<Markdown source="" />);
    expect(screen.getByTestId("markdown")).toBeEmptyDOMElement();
  });
});
