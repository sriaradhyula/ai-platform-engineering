import { NextRequest } from "next/server";

import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { getPageStore } from "@/lib/tome/page-store";
import { buildTree } from "@/lib/tome/schema";
import { loadTomeProject } from "@/lib/tome/tome-api";
import { defaultGistFilename } from "@/lib/tome/gists";
import { getTomeGistsCollection } from "@/lib/tome/mongo-collections";
import { AGENT_IDENTITIES } from "@/lib/tome/agent-identities";
import { ensureFoldersForPages, listFolders } from "@/lib/tome/folder-store";
import { ensurePagePlacements, listPagePlacements } from "@/lib/tome/navigation-store";
import {
  buildWikiExportDocument,
  renderWikiHtml,
  renderWikiMarkdown,
  stripAgentHtmlComments,
} from "@/lib/tome/wiki-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };
type ExportFormat = "pdf" | "html" | "markdown";

function exportFormat(request: NextRequest): ExportFormat {
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";
  if (format === "pdf" || format === "html" || format === "markdown") return format;
  throw new ApiError("Supported export formats: pdf, html, markdown", 400, "BAD_REQUEST");
}

function safeFilename(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wiki";
}

/** Download the current wiki, one selected page, or one gist as PDF, HTML, or Markdown. */
export const GET = withErrorHandler(async (request: NextRequest, ctx: Ctx) => {
  const { slug } = await ctx.params;
  const format = exportFormat(request);
  const requestedPath = request.nextUrl.searchParams.get("path")?.trim() || null;
  const requestedGistId = request.nextUrl.searchParams.get("gist")?.trim() || null;
  if (requestedPath && requestedGistId) {
    throw new ApiError("Choose either a wiki page or a gist to export", 400, "BAD_REQUEST");
  }
  const tctx = await loadTomeProject(request, slug);

  if (requestedGistId) {
    const gists = await getTomeGistsCollection();
    const gist = await gists.findOne({ _id: requestedGistId, project_id: tctx.projectId });
    if (!gist) throw new ApiError("Gist not found", 404, "GIST_NOT_FOUND");

    const filename = gist.filename ?? defaultGistFilename(gist.title);
    const stem = filename.replace(/\.mdx?$/i, "");
    const base = safeFilename(stem);
    const commonHeaders = {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${base}.${format === "markdown" ? "md" : format}"`,
      "X-Content-Type-Options": "nosniff",
    };
    const markdown = stripAgentHtmlComments(gist.body);
    if (format === "markdown") {
      return new Response(`${markdown}${markdown.endsWith("\n") ? "" : "\n"}`, {
        headers: { ...commonHeaders, "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    const document = buildWikiExportDocument({
      projectName: gist.title,
      pages: {
        [filename]: `---\ntitle: ${JSON.stringify(gist.title)}\n---\n${markdown}`,
      },
      tree: [],
    });
    if (format === "html") {
      return new Response(renderWikiHtml(document), {
        headers: { ...commonHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    const { renderWikiPdf } = await import("@/lib/tome/wiki-export-pdf");
    const pdf = await renderWikiPdf(document);
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...commonHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.byteLength),
      },
    });
  }

  const store = await getPageStore();
  const pages = await store.listPages(tctx.projectId);
  if (requestedPath && !Object.prototype.hasOwnProperty.call(pages, requestedPath)) {
    throw new ApiError("Page not found", 404, "PAGE_NOT_FOUND");
  }
  const exportPages = requestedPath
    ? { [requestedPath]: pages[requestedPath] }
    : pages;
  await ensureFoldersForPages(
    tctx.projectId,
    Object.keys(pages),
    tctx.user.email ?? AGENT_IDENTITIES.default,
  );
  const folders = await listFolders(tctx.projectId);
  await ensurePagePlacements(
    tctx.projectId,
    pages,
    folders,
    tctx.user.email ?? AGENT_IDENTITIES.default,
  );
  const placements = await listPagePlacements(tctx.projectId);
  const document = buildWikiExportDocument({
    projectName: tctx.project.title || tctx.project.name || slug,
    pages: exportPages,
    tree: buildTree(exportPages, folders, placements),
  });
  const pageName = requestedPath?.replace(/\.mdx?$/i, "");
  const base = pageName
    ? `${safeFilename(slug)}-${safeFilename(pageName)}`
    : `${safeFilename(slug)}-wiki`;
  const commonHeaders = {
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${base}.${format === "markdown" ? "md" : format}"`,
    "X-Content-Type-Options": "nosniff",
  };

  if (format === "html") {
    return new Response(renderWikiHtml(document), {
      headers: { ...commonHeaders, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (format === "markdown") {
    return new Response(renderWikiMarkdown(document, { pageScoped: requestedPath !== null }), {
      headers: { ...commonHeaders, "Content-Type": "text/markdown; charset=utf-8" },
    });
  }

  const { renderWikiPdf } = await import("@/lib/tome/wiki-export-pdf");
  const pdf = await renderWikiPdf(document);
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...commonHeaders,
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
    },
  });
});
