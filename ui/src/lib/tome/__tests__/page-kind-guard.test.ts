/**
 * @jest-environment node
 *
 * Page-kind guard (#369, #348) — an agent write may not change the `kind` a
 * stored page already declares.
 */

import {
  explicitKind,
  preserveStoredKind,
  withKind,
} from "@/lib/tome/page-kind-guard";

const PINNED = "---\ntitle: Roadmap\nkind: stable\norder: 3\n---\n# Roadmap\n\nBody.\n";

describe("explicitKind", () => {
  it("reads a declared kind", () => {
    expect(explicitKind(PINNED)).toBe("stable");
    expect(explicitKind("---\nkind: dynamic\n---\n# X")).toBe("dynamic");
    expect(explicitKind("---\nkind: hidden\n---\n# X")).toBe("hidden");
    expect(explicitKind("---\nkind: report\n---\n# X")).toBe("report");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(explicitKind("---\nkind:   Stable  \n---\n# X")).toBe("stable");
    expect(explicitKind("---\nkind: DYNAMIC\n---\n# X")).toBe("dynamic");
  });

  it("returns null when there is no explicit, recognized kind", () => {
    expect(explicitKind(null)).toBeNull();
    expect(explicitKind(undefined)).toBeNull();
    expect(explicitKind("")).toBeNull();
    expect(explicitKind("# No frontmatter at all")).toBeNull();
    expect(explicitKind("---\ntitle: Roadmap\n---\n# X")).toBeNull();
    expect(explicitKind("---\nkind: bogus\n---\n# X")).toBeNull();
    // Unterminated fence is not frontmatter.
    expect(explicitKind("---\nkind: stable\n# X")).toBeNull();
    // `kind:` outside the frontmatter block must not count.
    expect(explicitKind("# Title\n\n---\nkind: stable\n---\n")).toBeNull();
  });
});

describe("withKind", () => {
  it("replaces the kind line and leaves every other byte alone", () => {
    expect(withKind(PINNED, "dynamic")).toBe(
      "---\ntitle: Roadmap\nkind: dynamic\norder: 3\n---\n# Roadmap\n\nBody.\n",
    );
  });

  it("preserves key order, block-list arrays, and comments verbatim", () => {
    const md = [
      "---",
      "title: Glossary",
      "kind: dynamic",
      "# a frontmatter comment",
      "aliases:",
      "  - tbac",
      "  - task-based access control",
      "order: 5",
      "---",
      "Body stays put.",
      "",
    ].join("\n");
    const out = withKind(md, "stable");
    expect(out).toBe(md.replace("kind: dynamic", "kind: stable"));
    // Nothing flattened: the block list survives as written.
    expect(out).toContain("  - task-based access control");
    expect(out).toContain("# a frontmatter comment");
  });

  it("inserts a kind line when frontmatter exists without one", () => {
    expect(withKind("---\ntitle: Roadmap\n---\n# Roadmap\n", "stable")).toBe(
      "---\ntitle: Roadmap\nkind: stable\n---\n# Roadmap\n",
    );
  });

  it("adds frontmatter when the page has none", () => {
    expect(withKind("# Roadmap\n", "stable")).toBe("---\nkind: stable\n---\n# Roadmap\n");
  });

  it("treats an unterminated fence as body, not frontmatter", () => {
    expect(withKind("---\ntitle: x\n# Roadmap\n", "stable")).toBe(
      "---\nkind: stable\n---\n---\ntitle: x\n# Roadmap\n",
    );
  });

  it("round-trips: the written kind is what explicitKind reads back", () => {
    for (const kind of ["stable", "dynamic", "hidden", "report"] as const) {
      expect(explicitKind(withKind(PINNED, kind))).toBe(kind);
      expect(explicitKind(withKind("# bare\n", kind))).toBe(kind);
      expect(explicitKind(withKind("---\ntitle: t\n---\nbody\n", kind))).toBe(kind);
    }
  });
});

describe("preserveStoredKind", () => {
  it("restores the pinned kind when an agent tries to flip stable -> dynamic", () => {
    // This is issue #369 verbatim: the Aug 5 ingest's entire diff on
    // roadmap.md was `kind: stable` -> `kind: dynamic`.
    const incoming = PINNED.replace("kind: stable", "kind: dynamic");
    const res = preserveStoredKind(PINNED, incoming);

    expect(res.blocked).toBe(true);
    expect(res.storedKind).toBe("stable");
    expect(res.attemptedKind).toBe("dynamic");
    expect(res.markdown).toBe(PINNED);
  });

  it("keeps the agent's body edits while restoring only the kind", () => {
    const incoming =
      "---\ntitle: Roadmap\nkind: dynamic\norder: 3\n---\n# Roadmap\n\nRewritten body.\n";
    const res = preserveStoredKind(PINNED, incoming);

    expect(res.blocked).toBe(true);
    expect(res.markdown).toBe(
      "---\ntitle: Roadmap\nkind: stable\norder: 3\n---\n# Roadmap\n\nRewritten body.\n",
    );
    expect(res.markdown).toContain("Rewritten body.");
  });

  it("blocks a kind change smuggled in by dropping the frontmatter key", () => {
    const incoming = "---\ntitle: Roadmap\norder: 3\n---\n# Roadmap\n";
    const res = preserveStoredKind(PINNED, incoming);

    expect(res.blocked).toBe(true);
    expect(res.attemptedKind).toBeNull();
    expect(explicitKind(res.markdown)).toBe("stable");
  });

  it("blocks a kind change smuggled in by dropping frontmatter entirely", () => {
    const res = preserveStoredKind(PINNED, "# Roadmap\n\nJust a body.\n");

    expect(res.blocked).toBe(true);
    expect(explicitKind(res.markdown)).toBe("stable");
    expect(res.markdown).toContain("Just a body.");
  });

  it("guards every direction, not just stable -> dynamic", () => {
    const storedDynamic = "---\nkind: dynamic\n---\n# A";
    expect(preserveStoredKind(storedDynamic, "---\nkind: stable\n---\n# A").markdown).toBe(
      storedDynamic,
    );

    const storedHidden = "---\nkind: hidden\n---\n# memory";
    expect(preserveStoredKind(storedHidden, "---\nkind: dynamic\n---\n# memory").markdown).toBe(
      storedHidden,
    );

    const storedReport = "---\nkind: report\n---\n# standup";
    expect(preserveStoredKind(storedReport, "---\nkind: stable\n---\n# standup").markdown).toBe(
      storedReport,
    );
  });

  it("passes an unchanged kind straight through untouched", () => {
    const incoming = PINNED.replace("Body.", "Fresher body.");
    const res = preserveStoredKind(PINNED, incoming);

    expect(res.blocked).toBe(false);
    expect(res.markdown).toBe(incoming);
  });

  it("lets the agent set the kind on a page it is creating", () => {
    const incoming = "---\ntitle: New\nkind: dynamic\n---\n# New";
    const res = preserveStoredKind(null, incoming);

    expect(res.blocked).toBe(false);
    expect(res.markdown).toBe(incoming);
    expect(res.storedKind).toBeNull();
  });

  it("lets the agent stamp a kind onto a stored page that declares none", () => {
    // A frontmatter-less upload records no decision to defend.
    const res = preserveStoredKind("# Roadmap\n\nUploaded raw.\n", "---\nkind: dynamic\n---\n# R");

    expect(res.blocked).toBe(false);
    expect(explicitKind(res.markdown)).toBe("dynamic");
  });

  it("ignores an unrecognized stored kind rather than pinning to garbage", () => {
    const res = preserveStoredKind("---\nkind: sideways\n---\n# R", "---\nkind: dynamic\n---\n# R");

    expect(res.blocked).toBe(false);
    expect(explicitKind(res.markdown)).toBe("dynamic");
  });

  it("is idempotent — re-guarding its own output is a no-op", () => {
    const first = preserveStoredKind(PINNED, PINNED.replace("kind: stable", "kind: dynamic"));
    const second = preserveStoredKind(PINNED, first.markdown);

    expect(second.blocked).toBe(false);
    expect(second.markdown).toBe(first.markdown);
  });

  it("survives repeated ingests — the pin holds run after run", () => {
    // The reported failure mode was a pin that had to be re-applied after
    // every single ingest. Ten runs, one pin.
    let stored = PINNED;
    for (let run = 0; run < 10; run++) {
      const agentWrite = stored
        .replace("kind: stable", "kind: dynamic")
        .replace(/Body.*\n/, `Body from run ${run}.\n`);
      stored = preserveStoredKind(stored, agentWrite).markdown;
      expect(explicitKind(stored)).toBe("stable");
    }
    expect(stored).toContain("Body from run 9.");
  });
});
