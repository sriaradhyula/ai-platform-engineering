import {
  matchTomeEmbedUrl,
  normalizeArxivUrl,
  normalizePdfUrl,
  normalizeYouTubeUrl,
  parseTomeEmbed,
  serializeTomeEmbedBlock,
} from "../embeds";

const YOUTUBE_ID = "M7lc1UVf-VE";

describe("TOME external embeds", () => {
  describe("YouTube", () => {
    it("normalizes watch URLs to the privacy-enhanced player", () => {
      expect(
        normalizeYouTubeUrl(
          `https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=1m30s&si=tracking-token`,
        ),
      ).toEqual({
        src: `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}?start=90`,
        watchUrl: `https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=90`,
      });
    });

    it.each([
      `https://youtu.be/${YOUTUBE_ID}`,
      `https://www.youtube.com/shorts/${YOUTUBE_ID}`,
      `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
    ])("accepts common video URL %s", (url) => {
      expect(normalizeYouTubeUrl(url)?.src).toBe(
        `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
      );
    });

    it.each([
      `http://www.youtube.com/watch?v=${YOUTUBE_ID}`,
      `https://youtube.example.test/watch?v=${YOUTUBE_ID}`,
      "https://www.youtube.com/watch?v=invalid",
      `https://youtu.be/${YOUTUBE_ID}/unexpected`,
      `https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=tomorrow`,
      `https://www.youtube.com/watch?v=${YOUTUBE_ID}#fragment`,
    ])("rejects unsafe or invalid URL %s", (url) => {
      expect(normalizeYouTubeUrl(url)).toBeNull();
    });

    it("parses titled YouTube blocks", () => {
      expect(
        parseTomeEmbed(
          "youtube",
          [`url: https://youtu.be/${YOUTUBE_ID}`, "title: Example walkthrough"].join("\n"),
        ),
      ).toEqual({
        ok: true,
        value: {
          alignment: "center",
          provider: "youtube",
          kind: "video",
          src: `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}`,
          title: "Example walkthrough",
          watchUrl: `https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
          linkLabel: "Watch on YouTube",
        },
      });
    });

    it("parses and serializes a responsive video width", () => {
      const parsed = parseTomeEmbed(
        "youtube",
        [`url: https://youtu.be/${YOUTUBE_ID}`, "width: 65%"].join("\n"),
      );

      expect(parsed).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({ widthPercent: 65 }),
        }),
      );
      expect(
        serializeTomeEmbedBlock("youtube", `https://youtu.be/${YOUTUBE_ID}`, undefined, 65),
      ).toBe(`\`\`\`youtube\nurl: https://youtu.be/${YOUTUBE_ID}\nwidth: 65%\n\`\`\``);
    });

    it("parses and serializes portable media alignment", () => {
      expect(
        parseTomeEmbed(
          "youtube",
          [`url: https://youtu.be/${YOUTUBE_ID}`, "align: right"].join("\n"),
        ),
      ).toEqual(
        expect.objectContaining({
          ok: true,
          value: expect.objectContaining({ alignment: "right" }),
        }),
      );
      expect(
        serializeTomeEmbedBlock(
          "youtube",
          `https://youtu.be/${YOUTUBE_ID}`,
          undefined,
          65,
          "left",
        ),
      ).toBe(
        `\`\`\`youtube\nurl: https://youtu.be/${YOUTUBE_ID}\nwidth: 65%\nalign: left\n\`\`\``,
      );
    });

    it("rejects invalid media alignment", () => {
      expect(
        parseTomeEmbed(
          "youtube",
          [`url: https://youtu.be/${YOUTUBE_ID}`, "align: diagonal"].join("\n"),
        ),
      ).toEqual({
        ok: false,
        error: "YouTube alignment must be left, center, or right.",
      });
    });

    it.each(["24%", "101%", "wide"])("rejects invalid video width %s", (width) => {
      expect(
        parseTomeEmbed(
          "youtube",
          [`url: https://youtu.be/${YOUTUBE_ID}`, `width: ${width}`].join("\n"),
        ),
      ).toEqual({
        ok: false,
        error: "YouTube width must be between 25% and 100%.",
      });
    });

    it("parses the single url field produced by automatic paste conversion", () => {
      expect(
        parseTomeEmbed(
          "youtube",
          "url: https://www.youtube.com/watch?v=Od6M0AXpcxQ",
        ),
      ).toEqual({
        ok: true,
        value: {
          alignment: "center",
          provider: "youtube",
          kind: "video",
          src: "https://www.youtube-nocookie.com/embed/Od6M0AXpcxQ",
          title: "YouTube video or playlist",
          watchUrl: "https://www.youtube.com/watch?v=Od6M0AXpcxQ",
          linkLabel: "Watch on YouTube",
        },
      });
    });

    it("normalizes playlist URLs", () => {
      expect(normalizeYouTubeUrl("https://www.youtube.com/playlist?list=PL1234567890_example")).toEqual({
        src: "https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890_example",
        watchUrl: "https://www.youtube.com/playlist?list=PL1234567890_example",
      });
    });

    it.each([
      "https://www.youtube.com/embed/videoseries?list=PL1234567890_example",
      "https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890_example",
    ])("normalizes the official playlist embed URL %s", (url) => {
      expect(normalizeYouTubeUrl(url)).toEqual({
        src: "https://www.youtube-nocookie.com/embed/videoseries?list=PL1234567890_example",
        watchUrl: "https://www.youtube.com/playlist?list=PL1234567890_example",
      });
    });

    it("rejects an official playlist embed URL without its playlist ID", () => {
      expect(normalizeYouTubeUrl("https://www.youtube.com/embed/videoseries")).toBeNull();
    });
  });

  describe("PDF", () => {
    it("accepts direct HTTPS PDF URLs and rejects other URLs", () => {
      expect(normalizePdfUrl("https://example.com/files/guide.pdf?download=1")).toEqual({
        src: "https://example.com/files/guide.pdf?download=1",
        watchUrl: "https://example.com/files/guide.pdf?download=1",
      });
      expect(normalizePdfUrl("http://example.com/files/guide.pdf")).toBeNull();
      expect(normalizePdfUrl("https://example.com/files/guide.html")).toBeNull();
    });

    it("serializes portable titled embed blocks", () => {
      expect(serializeTomeEmbedBlock("pdf", "https://example.com/guide.pdf", "Example guide")).toBe(
        '```pdf\nurl: https://example.com/guide.pdf\ntitle: "Example guide"\n```',
      );
    });
  });

  describe("arXiv", () => {
    it.each([
      "1706.03762",
      "arXiv:1706.03762",
      "https://arxiv.org/abs/1706.03762",
      "https://arxiv.org/html/1706.03762",
      "https://arxiv.org/pdf/1706.03762.pdf",
    ])("normalizes modern paper reference %s to a PDF", (value) => {
      expect(normalizeArxivUrl(value)).toEqual({
        src: "https://arxiv.org/pdf/1706.03762",
        watchUrl: "https://arxiv.org/abs/1706.03762",
      });
    });

    it("accepts legacy identifiers and explicit versions", () => {
      expect(normalizeArxivUrl("arXiv:hep-th/9901001v2")).toEqual({
        src: "https://arxiv.org/pdf/hep-th/9901001v2",
        watchUrl: "https://arxiv.org/abs/hep-th/9901001v2",
      });
    });

    it.each([
      "http://arxiv.org/abs/1706.03762",
      "https://arxiv.example.test/abs/1706.03762",
      "https://arxiv.org/search/1706.03762",
      "https://arxiv.org/abs/1706.03762?download=1",
      "https://arxiv.org/abs/not-a-paper",
      "https://arxiv.org/abs/%E0%A4%A",
    ])("rejects unsafe or invalid reference %s", (value) => {
      expect(normalizeArxivUrl(value)).toBeNull();
    });

    it("parses titled arXiv blocks", () => {
      expect(
        parseTomeEmbed(
          "arxiv",
          ["url: https://arxiv.org/abs/1706.03762", "title: Attention Is All You Need"].join(
            "\n",
          ),
        ),
      ).toEqual({
        ok: true,
        value: {
          alignment: "center",
          provider: "arxiv",
          kind: "document",
          src: "https://arxiv.org/pdf/1706.03762",
          title: "Attention Is All You Need",
          watchUrl: "https://arxiv.org/abs/1706.03762",
          linkLabel: "Open on arXiv",
        },
      });
    });

    it("tolerates leading whitespace on continuation lines", () => {
      expect(
        parseTomeEmbed(
          "arxiv",
          ["url: https://arxiv.org/abs/1706.03762", "  title: Attention Is All You Need"].join(
            "\n",
          ),
        ),
      ).toEqual({
        ok: true,
        value: {
          alignment: "center",
          provider: "arxiv",
          kind: "document",
          src: "https://arxiv.org/pdf/1706.03762",
          title: "Attention Is All You Need",
          watchUrl: "https://arxiv.org/abs/1706.03762",
          linkLabel: "Open on arXiv",
        },
      });
    });
  });

  it("ignores unsupported fenced languages", () => {
    expect(parseTomeEmbed("typescript", "const value = 1")).toBeNull();
  });

  describe("automatic URL recognition", () => {
    it.each([
      [
        "vidcast",
        "https://app.vidcast.io/share/embed/b46e063b-6530-4d04-90b6-064dbbcdc613",
      ],
      [
        "vidcast",
        "https://app.vidcast.io/share/c4a952bc-554b-4831-81da-f4d243608813",
      ],
      [
        "vidcast",
        "https://app.vidcast.io/playlists/daa5d80c-9272-4587-989b-91d6c5f35b93",
      ],
      ["youtube", "https://www.youtube.com/watch?v=Od6M0AXpcxQ"],
      [
        "youtube",
        "https://www.youtube.com/embed/videoseries?list=PL1234567890_example",
      ],
      ["arxiv", "https://arxiv.org/pdf/1706.03762.pdf"],
      ["arxiv", "https://arxiv.org/abs/1706.03762"],
      ["pdf", "https://example.com/reports/example.pdf"],
    ] as const)("recognizes a standalone %s URL", (provider, url) => {
      expect(matchTomeEmbedUrl(`  ${url}\n`)).toEqual({
        provider,
        markdown: `\n\n\`\`\`${provider}\nurl: ${url}\n\`\`\`\n\n`,
      });
    });

    it.each([
      "https://example.com/article",
      "Watch https://www.youtube.com/watch?v=Od6M0AXpcxQ",
      "[Video](https://www.youtube.com/watch?v=Od6M0AXpcxQ)",
      "http://example.com/report.pdf",
      "arXiv:1706.03762",
    ])("leaves ordinary or unsafe pasted text unchanged: %s", (value) => {
      expect(matchTomeEmbedUrl(value)).toBeNull();
    });
  });
});
