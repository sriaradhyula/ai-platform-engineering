import {
  normalizeMarkdownCodeFences,
  normalizeMarkdownCodeLanguage,
} from "../markdown-code-languages";

describe("Markdown code language normalization", () => {
  it.each([
    ["C++", "cpp"],
    ["C#", "csharp"],
    ["F#", "fsharp"],
    ["TypeScript", "typescript"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeMarkdownCodeLanguage(input)).toBe(expected);
  });

  it("normalizes opening fences without touching code content", () => {
    const markdown = [
      "```C++",
      'const char* example = "```C++";',
      "```",
      "",
      "~~~TypeScript title=Example",
      "const value: number = 1;",
      "~~~",
    ].join("\n");

    expect(normalizeMarkdownCodeFences(markdown)).toBe(
      [
        "```cpp",
        'const char* example = "```C++";',
        "```",
        "",
        "~~~typescript title=Example",
        "const value: number = 1;",
        "~~~",
      ].join("\n"),
    );
  });
});
