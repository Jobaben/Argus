import { describe, it, expect } from "vitest";
import { reasonText, tellOnce } from "./failureReason";

describe("reasonText", () => {
  it("drops the verdict the status pill already shows, and starts with a capital", () => {
    expect(reasonText("failed: could not reach advisory database (ETIMEDOUT)")).toBe(
      "Could not reach advisory database (ETIMEDOUT)",
    );
    expect(reasonText("exit code 1")).toBe("Exit code 1");
  });

  it("keeps 'blocked', which the Failed pill does not say", () => {
    expect(reasonText("blocked: no remote")).toBe("Blocked: no remote");
  });

  it("leaves nothing of a bare verdict", () => {
    expect(reasonText("failed")).toBe("");
    expect(reasonText(null)).toBe("");
  });
});

describe("tellOnce", () => {
  it("lets a message that opens with the reason say it in full", () => {
    expect(
      tellOnce(
        "failed: could not reach advisory database (ETIMEDOUT)",
        "Could not reach the advisory database (ETIMEDOUT) after 3 retries.\nThe mirror was down too.",
      ),
    ).toEqual({
      reason: "Could not reach the advisory database (ETIMEDOUT) after 3 retries.",
      message: "The mirror was down too.",
    });
  });

  it("leaves a message that only mentions the reason further in", () => {
    expect(tellOnce("exit code 1", "Ran the suite; exit code 1 from jest.")).toEqual({
      reason: "Exit code 1",
      message: "Ran the suite; exit code 1 from jest.",
    });
  });

  it("matches whole words only", () => {
    // Glued together, "exitcode1" opened "exitcode127…" and the lead would
    // have named the wrong exit code.
    expect(tellOnce("exit code 1", "Exit code 127 from npm.\nMissing binary.")).toEqual({
      reason: "Exit code 1",
      message: "Exit code 127 from npm.\nMissing binary.",
    });
    expect(tellOnce("failed: test", "Testing finished with 3 failures.").reason).toBe("Test");
  });

  it("takes a heading or list marker off the line it lifts", () => {
    expect(tellOnce("failed: tests are red", "## Tests are red\n\nThree suites.").reason).toBe(
      "Tests are red",
    );
  });
});
