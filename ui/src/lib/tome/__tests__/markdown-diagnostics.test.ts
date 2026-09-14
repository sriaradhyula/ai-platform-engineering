import { diagnoseTomeMarkdown } from "../markdown-diagnostics";

describe("diagnoseTomeMarkdown", () => {
  it("reports malformed frontmatter and invalid embeds", () => {
    const diagnostics = diagnoseTomeMarkdown(
      "---\ntitle: Broken\n```youtube\nurl: https://example.test/video\n```",
    );
    const messages = diagnostics.map((item) => item.message).join(" ");
    expect(messages).toContain("Frontmatter");
    expect(messages).toContain("YouTube");
  });

  it("reports unresolved same-project links and lossy raw HTML", () => {
    const diagnostics = diagnoseTomeMarkdown(
      "[Missing](missing.md)\n\n<iframe src=\"https://example.com\"></iframe>",
      { knownPaths: new Set(["present.md"]) },
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("missing.md") }),
        expect.objectContaining({ message: expect.stringContaining("may be lost") }),
      ]),
    );
  });
});
