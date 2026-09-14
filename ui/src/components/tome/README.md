# Tome Markdown editing contract

- Markdown is the stored source of truth. Rich-mode edits must serialize back to Markdown.
- One newline inside a paragraph is a soft wrap. Use a blank line for a new paragraph or two trailing spaces for an explicit line break.
- CommonMark and GitHub Flavored Markdown lists are supported, including ordered, unordered, nested, mixed, and task lists.
- Rich mode supports headings, emphasis, links, code, block quotes, lists, tables, images, math, and Mermaid.
- External media is stored as a fenced `youtube`, `vidcast`, `arxiv`, or `pdf` block with `url:` and optional `title:`, `width:`, and `align:` fields. Rich mode provides persistent Left, Center, and Right alignment controls for embeds and images; centered media remains the backward-compatible default.
- Editable rich surfaces expose Media in Crepe's top toolbar. Pasting a standalone supported URL in rich or Tome source mode converts it to the same fenced block; ordinary links and mixed prose are left unchanged. Vidcast video share and playlist URLs both resolve to their canonical embedded players, and playlist embeds expose a durable Show playlist videos toggle that defaults on.
- Raw HTML and MDX are sanitized in previews and may not round-trip through rich mode. Source mode warns before authors rely on these constructs.
- Source mode reports malformed frontmatter, invalid media blocks, and same-project wiki links that do not resolve.
- Edits autosave locally in the browser. A server save includes the revision on which the edit began; a newer revision opens a conflict review instead of being overwritten.
