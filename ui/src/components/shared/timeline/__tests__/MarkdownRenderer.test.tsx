import { render,screen,waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "../MarkdownRenderer";

const mockLoadLanguage = jest.fn();
const mockCodeToHtml = jest.fn(
  (code: string, options: { lang: string }) =>
    `<pre class="shiki" data-language="${options.lang}"><code>${code}</code></pre>`,
);

jest.mock("remend", () => ({
  __esModule: true,
  default: (content: string) => content,
}), { virtual: true });

jest.mock("marked-shiki", () => ({
  __esModule: true,
  default: ({
    highlight,
  }: {
    highlight: (code: string, lang: string, props: string[]) => Promise<string>;
  }) => ({
    async: true,
    async walkTokens(token: {
      type: string;
      lang?: string;
      text: string;
      block?: boolean;
    }) {
      if (token.type !== "code") return;
      const [lang = "text", ...props] = token.lang?.split(" ") ?? [];
      token.type = "html";
      token.block = true;
      token.text = `${await highlight(token.text, lang, props)}\n`;
    },
  }),
}));

jest.mock("shiki", () => ({
  bundledLanguages: { cpp: true, text: true },
  createHighlighter: jest.fn(async () => ({
    codeToHtml: mockCodeToHtml,
    getLoadedLanguages: () => ["text"],
    loadLanguage: mockLoadLanguage,
  })),
}));

describe("MarkdownRenderer links", () => {
  it("preserves nested, mixed, ordered, and task-list structure", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={["- Parent", "  1. Ordered child", "     - Mixed grandchild", "- [x] Completed task"].join("\n")}
      />,
    );

    await waitFor(() => expect(container.querySelector("ul > li > ol > li > ul")).toBeInTheDocument());
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it("treats one newline as a soft wrap and a blank line as a paragraph", async () => {
    const { container } = render(
      <MarkdownRenderer content={"first line\nsecond line\n\nsecond paragraph"} />,
    );

    await waitFor(() => expect(container.querySelectorAll("p")).toHaveLength(2));
    expect(container.querySelector("br")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("first line\nsecond line");
  });

  it("normalizes editor display names before syntax highlighting", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={["```C++", "int main() { return 0; }", "```"].join("\n")}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('pre[data-language="cpp"]')).toBeInTheDocument(),
    );
    expect(mockLoadLanguage).toHaveBeenCalledWith("cpp");
    expect(container.querySelector(".md-code-lang")).toHaveTextContent("cpp");
  });

  it("opens external and relative links in a new tab", async () => {
    render(
      <MarkdownRenderer
        content="[External](https://example.com/docs) [Internal](/chat/example)"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "External" })).toHaveAttribute("target", "_blank");
      expect(screen.getByRole("link", { name: "Internal" })).toHaveAttribute("target", "_blank");
    });

    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("renders allowlisted external embeds only when explicitly enabled", async () => {
    const content = [
      "```vidcast",
      "url: https://app.vidcast.io/share/embed/4e2a9de5-2d25-420b-a59a-acdb321bd1b3",
      "title: Example Vidcast",
      "```",
      "",
      "```youtube",
      "url: https://www.youtube.com/watch?v=b4STimVN60E",
      "title: Example video",
      "```",
      "",
      "```arxiv",
      "url: https://arxiv.org/html/2607.12662v1",
      "title: Example paper",
      "```",
      "",
      "```pdf",
      "url: https://example.com/files/guide.pdf",
      "title: Example PDF",
      "```",
    ].join("\n");
    const disabled = render(<MarkdownRenderer content={content} />);

    await waitFor(() => expect(disabled.container.querySelector("pre")).toBeInTheDocument());
    expect(disabled.container.querySelector("iframe")).toBeNull();
    disabled.unmount();

    const enabled = render(
      <MarkdownRenderer content={content} enableExternalEmbeds />,
    );
    await waitFor(() =>
      expect(enabled.container.querySelectorAll("iframe")).toHaveLength(4),
    );

    expect(enabled.container.querySelector(".tome-vidcast-iframe")).toHaveAttribute(
      "src",
      "https://app.vidcast.io/share/embed/4e2a9de5-2d25-420b-a59a-acdb321bd1b3",
    );
    expect(enabled.container.querySelector(".tome-youtube-iframe")).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/b4STimVN60E",
    );
    expect(enabled.container.querySelector(".tome-arxiv-iframe")).toHaveAttribute(
      "src",
      "https://arxiv.org/pdf/2607.12662v1",
    );
    expect(enabled.container.querySelector(".tome-pdf-iframe")).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-presentation",
    );
    expect(enabled.container.querySelector(".tome-embed-toolbar")).toBeNull();
    expect(enabled.container.querySelector(".tome-embed-remove")).toBeNull();
    expect(enabled.container.querySelector(".tome-vidcast-playlist-toggle")).toBeNull();
    expect(enabled.container.querySelector(".tome-media-alignment")).toBeNull();
    expect(enabled.container.querySelector(".tome-media-resize")).toBeNull();
  });

  it("preserves responsive widths for video embeds and block images", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          "```youtube",
          "url: https://www.youtube.com/watch?v=b4STimVN60E",
          "width: 60%",
          "```",
          "",
          '![0.55|right](https://example.com/example.png "Example diagram")',
        ].join("\n")}
        enableExternalEmbeds
      />,
    );

    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
    expect(container.querySelector(".tome-embed-preview")).toHaveStyle(
      "--tome-media-width: 60%",
    );
    const figure = container.querySelector("figure.tome-image-figure");
    const image = figure?.querySelector("img");
    expect(figure).toHaveStyle("--tome-media-width: 55%");
    expect(figure).toHaveAttribute("data-media-align", "right");
    expect(image).toHaveAttribute("alt", "Example diagram");
    expect(figure?.querySelector("figcaption")).toHaveTextContent("Example diagram");
  });

  it("shows a safe error for invalid opted-in embeds", async () => {
    const { container } = render(
      <MarkdownRenderer
        content={[
          "```youtube",
          "https://example.test/watch?v=M7lc1UVf-VE",
          "```",
        ].join("\n")}
        enableExternalEmbeds
      />,
    );

    await waitFor(() => expect(container.querySelector('[role="alert"]')).toBeInTheDocument());
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".tome-embed-remove")).toBeNull();
    expect(container.textContent).toContain("Could not embed YouTube");
  });

  it("renders opted-in Tome column markers as a responsive section", async () => {
    const content = [
      "> [!column]",
      ">",
      "> ### First",
      ">",
      "> Alpha",
      "",
      "> [!column]",
      ">",
      "> ### Second",
      ">",
      "> Beta",
    ].join("\n");

    const disabled = render(<MarkdownRenderer content={content} />);
    await waitFor(() => expect(disabled.container.querySelectorAll("blockquote")).toHaveLength(2));
    expect(disabled.container.querySelector(".tome-columns")).toBeNull();
    disabled.unmount();

    const enabled = render(<MarkdownRenderer content={content} enableTomeColumns />);
    await waitFor(() => expect(enabled.container.querySelector(".tome-columns")).toBeInTheDocument());
    const columns = enabled.container.querySelector(".tome-columns");
    expect(columns).toHaveAttribute("data-column-count", "2");
    expect(columns?.querySelectorAll("blockquote.tome-column")).toHaveLength(2);
    expect(columns).not.toHaveTextContent("[!column]");
    expect(columns).toHaveTextContent("First");
    expect(columns).toHaveTextContent("Second");
  });

  it("keeps columns grouped across preserved empty lines", async () => {
    const content = [
      "> [!column]",
      ">",
      "> ### First",
      "",
      "<br />",
      "",
      "<br />",
      "",
      "> [!column]",
      ">",
      "> ### Second",
    ].join("\n");

    const { container } = render(
      <MarkdownRenderer content={content} enableTomeColumns />,
    );

    await waitFor(() => expect(container.querySelector(".tome-columns")).toBeInTheDocument());
    const columns = container.querySelector(".tome-columns");
    expect(columns).toHaveAttribute("data-column-count", "2");
    expect(columns?.querySelectorAll("blockquote.tome-column")).toHaveLength(2);
    expect(columns?.querySelector("br")).toBeNull();
    expect(columns).toHaveTextContent("First");
    expect(columns).toHaveTextContent("Second");
  });
});
