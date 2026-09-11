/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();

jest.mock("@/lib/api-middleware", () => ({
  getAuthFromBearerOrSession: (...args: unknown[]) =>
    mockGetAuthFromBearerOrSession(...args),
}));

jest.mock("@/lib/tome/guard", () => ({
  isTomeServerEnabled: () => true,
}));

import { POST } from "../route";

const originalTomePublicOrigin = process.env.TOME_PUBLIC_ORIGIN;

describe("Tome MCP authentication challenge", () => {
  beforeEach(() => {
    mockGetAuthFromBearerOrSession.mockRejectedValue(
      new Error("unauthenticated"),
    );
    process.env.TOME_PUBLIC_ORIGIN = "https://grid.example.test";
  });

  afterAll(() => {
    if (originalTomePublicOrigin === undefined)
      delete process.env.TOME_PUBLIC_ORIGIN;
    else process.env.TOME_PUBLIC_ORIGIN = originalTomePublicOrigin;
  });

  it("advertises the resource-specific RFC 9728 metadata URL", async () => {
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="tome-mcp", resource_metadata="https://grid.example.test/.well-known/oauth-protected-resource/api/tome/mcp"',
    );
  });

  it.each(["catalog_api_key", "skills_api_key"])(
    "rejects scoped %s credentials at the MCP transport",
    async (principalType) => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "catalog-user@example.test" },
      session: { principalType, sub: "catalog-user" },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        headers: { authorization: "Bearer redacted" },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "oauth-protected-resource/api/tome/mcp",
    );
    },
  );

  it("rejects legacy catalog-key sessions at the MCP transport", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "catalog-user@example.test" },
      session: { catalogKey: "redacted", sub: "catalog-user" },
    });

    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("allows an interactive OIDC principal to list tools", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        headers: { authorization: "Bearer redacted" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7 });
    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tome_list_projects" }),
        expect.objectContaining({ name: "tome_get_auto_ingest" }),
        expect.objectContaining({ name: "tome_create_project" }),
        expect.objectContaining({ name: "tome_update_gist" }),
      ]),
    );
  });

  it("allows a user-owned TOME API-key principal to list tools", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test", name: "Viewer" },
      session: {
        principalType: "tome_api_key",
        sub: "viewer-subject",
        authScopes: ["tome:mcp"],
      },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        headers: { "x-caipe-token": "tome_redacted.secret" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tome_list_projects" }),
      ]),
    );
  });

  it("includes explicit auto-ingest state in project list results", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          projects: [
            {
              slug: "scheduled-project",
              title: "Scheduled project",
              status: "active",
              autoIngest: {
                enabled: true,
                cron: "0 2 * * *",
                credentialOwner: {
                  subject: "owner-subject",
                  name: "Example Owner",
                  email: "owner@example.test",
                },
                lastRun: {
                  at: "2026-08-15T02:00:00.000Z",
                  status: "success",
                  runId: "run-1",
                },
                webexMeetingSeries: [
                  {
                    id: "subscription-1",
                    title: "Platform sync",
                    enabled: true,
                    credentialOwner: {
                      subject: "meeting-owner-subject",
                      name: "Meeting Owner",
                      email: "meeting-owner@example.test",
                    },
                    lastStatus: "queued",
                    lastRunId: "meeting-run-1",
                  },
                ],
              },
            },
            { slug: "manual-project", title: "Manual project", status: "active" },
          ],
        },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          headers: { authorization: "Bearer redacted" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "tome_list_projects", arguments: {} },
          }),
        }),
      );
      const body = await response.json();
      const projects = JSON.parse(body.result.content[0].text);

      expect(projects).toEqual([
        expect.objectContaining({
          slug: "scheduled-project",
          url: "https://grid.example.test/projects/scheduled-project/tome",
          auto_ingest: {
            configured: true,
            enabled: true,
            cron: "0 2 * * *",
            credential_owner: {
              name: "Example Owner",
              email: "owner@example.test",
            },
            last_run: {
              at: "2026-08-15T02:00:00.000Z",
              status: "success",
              run_id: "run-1",
              reason: null,
            },
            webex_meeting_series: [
              {
                id: "subscription-1",
                title: "Platform sync",
                enabled: true,
                credential_owner: {
                  name: "Meeting Owner",
                  email: "meeting-owner@example.test",
                },
                last_occurrence_at: null,
                last_calendar_check_at: null,
                next_occurrence_start_at: null,
                next_occurrence_end_at: null,
                last_run_id: "meeting-run-1",
                last_status: "queued",
                last_error: null,
              },
            ],
          },
        }),
        expect.objectContaining({
          slug: "manual-project",
          url: "https://grid.example.test/projects/manual-project/tome",
          auto_ingest: {
            configured: false,
            enabled: false,
            cron: null,
            credential_owner: null,
            last_run: null,
            webex_meeting_series: [],
          },
        }),
      ]);
      expect(body.result.content[0].text).not.toContain("owner-subject");
      expect(body.result.content[0].text).not.toContain("meeting-owner-subject");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("includes auto-ingest settings in project detail", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          project: {
            slug: "example-project",
            title: "Example project",
            status: "active",
            autoIngest: { enabled: false, cron: "30 4 * * 1", credentialOwner: null },
          },
        },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: {
              name: "tome_get_project",
              arguments: { project_slug: "example-project" },
            },
          }),
        }),
      );
      const body = await response.json();
      const project = JSON.parse(body.result.content[0].text);

      expect(project.auto_ingest).toEqual({
        configured: true,
        enabled: false,
        cron: "30 4 * * 1",
        credential_owner: null,
        last_run: null,
        webex_meeting_series: [],
      });
      expect(project.url).toBe(
        "https://grid.example.test/projects/example-project/tome",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("reads auto-ingest settings through the caller-authenticated project route", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "editor@example.test" },
      session: { principalType: "oidc_user", sub: "editor-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          project: {
            slug: "example-project",
            autoIngest: {
              enabled: true,
              cron: "15 3 * * *",
              credentialOwner: {
                subject: "editor-subject",
                name: "Example Editor",
                email: "editor@example.test",
              },
            },
          },
        },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          headers: { authorization: "Bearer redacted" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: {
              name: "tome_get_auto_ingest",
              arguments: { project_slug: "example-project" },
            },
          }),
        }),
      );
      const body = await response.json();
      const result = JSON.parse(body.result.content[0].text);

      expect(global.fetch).toHaveBeenCalledWith(
        "http://caipe-ui:3000/api/projects/example-project",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer redacted" }),
        }),
      );
      expect(result).toEqual({
        slug: "example-project",
        url: "https://grid.example.test/projects/example-project/tome",
        settings_url:
          "https://grid.example.test/projects/example-project/tome/settings?tab=auto-ingest",
        auto_ingest: expect.objectContaining({
          configured: true,
          enabled: true,
          cron: "15 3 * * *",
          credential_owner: {
            name: "Example Editor",
            email: "editor@example.test",
          },
        }),
        guidance:
          "Auto-ingest settings are read-only in MCP. Ask the user to open settings_url to make changes in Tome Settings.",
      });
      expect(body.result.content[0].text).not.toContain("editor-subject");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("forwards gist updates through the caller-authenticated project route", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "editor@example.test" },
      session: { principalType: "oidc_user", sub: "editor-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          gist: {
            id: "gist-1",
            title: "Updated title",
            body: "Updated body",
            tags: ["updated"],
            path: "/projects/example-project/tome/gists/gist-1",
          },
        },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          headers: { authorization: "Bearer redacted" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 8,
            method: "tools/call",
            params: {
              name: "tome_update_gist",
              arguments: {
                project_slug: "example-project",
                gist_id: "gist-1",
                title: "Updated title",
                tags: ["updated"],
              },
            },
          }),
        }),
      );
      const body = await response.json();
      const result = JSON.parse(body.result.content[0].text);

      expect(response.status).toBe(200);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://caipe-ui:3000/api/tome/projects/example-project/gists/gist-1",
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ Authorization: "Bearer redacted" }),
          body: JSON.stringify({ title: "Updated title", tags: ["updated"] }),
        }),
      );
      expect(result).toMatchObject({
        id: "gist-1",
        title: "Updated title",
        url: expect.stringContaining("/projects/example-project/tome/gists/gist-1"),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns a JSON-RPC parse error only after interactive authentication", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("returns an explicitly empty response for notifications", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("content-length")).toBe("0");
    await expect(response.text()).resolves.toBe("");
  });

  it("sets an explicit byte boundary on JSON responses", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const response = await POST(
      new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" }),
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength(body, "utf8")),
    );
  });

  it("omits inline Base64 images from tool results", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          path: "architecture.md",
          markdown:
            "Before ![diagram](data:image/png;base64,QUJDREVGRw==) after",
        },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 13,
            method: "tools/call",
            params: {
              name: "tome_get_page",
              arguments: {
                project_slug: "example-project",
                page_path: "architecture.md",
              },
            },
          }),
        }),
      );
      const body = await response.json();
      const text = body.result.content[0].text;

      expect(text).toContain("tome-image://omitted");
      expect(text).toContain("omitted 1 inline image");
      expect(text).not.toContain("QUJDREVGRw==");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns a compact tool error when sanitized output exceeds the limit", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const originalFetch = global.fetch;
    const originalLimit = process.env.TOME_MCP_MAX_TOOL_RESULT_BYTES;
    process.env.TOME_MCP_MAX_TOOL_RESULT_BYTES = "1024";
    global.fetch = jest.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: { path: "large.md", markdown: "x".repeat(2048) },
      }),
    );

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 14,
            method: "tools/call",
            params: {
              name: "tome_get_page",
              arguments: {
                project_slug: "example-project",
                page_path: "large.md",
              },
            },
          }),
        }),
      );
      const body = await response.json();

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("exceeds the 1024-byte");
      expect(body.result.content[0].text).toContain("tome_list_pages");
      expect(body.result.content[0].text.length).toBeLessThan(500);
    } finally {
      global.fetch = originalFetch;
      if (originalLimit === undefined)
        delete process.env.TOME_MCP_MAX_TOOL_RESULT_BYTES;
      else process.env.TOME_MCP_MAX_TOOL_RESULT_BYTES = originalLimit;
    }
  });

  it("fetches duplicate BHAG child page context only once", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user: { email: "viewer@example.test" },
      session: { principalType: "oidc_user", sub: "viewer-subject" },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let data: unknown;
      if (url.endsWith("/api/projects/ioc")) {
        data = { project: { slug: "ioc", title: "IoC", type: "bhag" } };
      } else if (url.includes("type=area")) {
        data = { projects: [{ slug: "core", title: "Core area" }] };
      } else if (url.includes("initiative=ioc")) {
        data = { projects: [{ slug: "shared", title: "Shared project" }] };
      } else if (url.includes("/api/projects?area=core")) {
        data = { projects: [{ slug: "shared", title: "Shared project" }] };
      } else if (url.includes("/pages")) {
        data = { pages: { "overview.md": "context" } };
      } else {
        throw new Error(`Unexpected URL: ${url}`);
      }
      return Response.json({ success: true, data });
    });

    try {
      const response = await POST(
        new NextRequest("http://caipe-ui:3000/api/tome/mcp", {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 15,
            method: "tools/call",
            params: {
              name: "tome_get_bhag_synthesis_context",
              arguments: { bhag_slug: "ioc" },
            },
          }),
        }),
      );
      const body = await response.json();
      const context = JSON.parse(body.result.content[0].text);
      const calls = (global.fetch as jest.Mock).mock.calls.map(([url]) =>
        String(url),
      );

      expect(calls.filter((url) => url.endsWith("/shared/pages"))).toHaveLength(1);
      expect(context.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: "shared",
            pages_omitted: "Duplicate project context already included.",
          }),
        ]),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});
