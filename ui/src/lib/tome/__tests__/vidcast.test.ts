import {
  normalizeVidcastUrl,
  parseVidcastEmbed,
  setVidcastBlockPlaylistExpanded,
  setVidcastPlaylistExpanded,
} from "../vidcast";

const VIDEO_ID = "de4fc0eb-7146-4044-86a3-60c3cbd976a3";
const PLAYLIST_ID = "daa5d80c-9272-4587-989b-91d6c5f35b93";

describe("TOME Vidcast embeds", () => {
  it("accepts canonical embed URLs and optional titles", () => {
    expect(
      parseVidcastEmbed(
        [
          `url: https://app.vidcast.io/share/embed/${VIDEO_ID}`,
          "title: CAIPE Demo July 2026",
        ].join("\n"),
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/share/embed/${VIDEO_ID}`,
        title: "CAIPE Demo July 2026",
        watchUrl: `https://app.vidcast.io/share/${VIDEO_ID}`,
      },
    });
  });

  it("accepts responsive widths", () => {
    expect(
      parseVidcastEmbed(
        [`url: https://app.vidcast.io/share/${VIDEO_ID}`, "width: 70%"].join("\n"),
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/share/embed/${VIDEO_ID}`,
        title: "Vidcast video",
        watchUrl: `https://app.vidcast.io/share/${VIDEO_ID}`,
        widthPercent: 70,
      },
    });
  });

  it("accepts portable left, center, and right alignment", () => {
    expect(
      parseVidcastEmbed(
        [`url: https://app.vidcast.io/share/${VIDEO_ID}`, "align: left"].join("\n"),
      ),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ alignment: "left" }),
      }),
    );
  });

  it("rejects invalid alignment", () => {
    expect(
      parseVidcastEmbed(
        [`url: https://app.vidcast.io/share/${VIDEO_ID}`, "align: diagonal"].join("\n"),
      ),
    ).toEqual({
      ok: false,
      error: "Vidcast alignment must be left, center, or right.",
    });
  });

  it("tolerates leading whitespace on continuation lines", () => {
    expect(
      parseVidcastEmbed(
        [
          `url: https://app.vidcast.io/share/embed/${VIDEO_ID}`,
          "  title: CAIPE Demo July 2026",
        ].join("\n"),
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/share/embed/${VIDEO_ID}`,
        title: "CAIPE Demo July 2026",
        watchUrl: `https://app.vidcast.io/share/${VIDEO_ID}`,
      },
    });
  });

  it("accepts a share URL by itself and converts it to an embed URL", () => {
    expect(
      parseVidcastEmbed(
        `https://app.vidcast.io/share/${VIDEO_ID}?autoplay=1&cc=1&t=30`,
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/share/embed/${VIDEO_ID}?autoplay=1&cc=1&t=30`,
        title: "Vidcast video",
        watchUrl: `https://app.vidcast.io/share/${VIDEO_ID}?autoplay=1&cc=1&t=30`,
      },
    });
  });

  it("accepts a playlist URL and converts it to the playlist player", () => {
    expect(
      parseVidcastEmbed(
        `https://app.vidcast.io/playlists/${PLAYLIST_ID}?autoplay=1&index=2`,
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/playlists/embed/${PLAYLIST_ID}?autoplay=1&index=2&expand=1`,
        title: "Vidcast playlist",
        watchUrl: `https://app.vidcast.io/playlists/${PLAYLIST_ID}?autoplay=1&index=2`,
      },
    });
  });

  it("accepts titled canonical playlist embed URLs", () => {
    expect(
      parseVidcastEmbed(
        [
          `url: https://app.vidcast.io/playlists/embed/${PLAYLIST_ID}`,
          "title: Example demo playlist",
        ].join("\n"),
      ),
    ).toEqual({
      ok: true,
      value: {
        alignment: "center",
        src: `https://app.vidcast.io/playlists/embed/${PLAYLIST_ID}?expand=1`,
        title: "Example demo playlist",
        watchUrl: `https://app.vidcast.io/playlists/${PLAYLIST_ID}`,
      },
    });
  });

  it("preserves an explicit collapsed-playlist preference", () => {
    expect(
      normalizeVidcastUrl(
        `https://app.vidcast.io/playlists/${PLAYLIST_ID}?expand=0`,
      ),
    ).toEqual({
      src: `https://app.vidcast.io/playlists/embed/${PLAYLIST_ID}?expand=0`,
      watchUrl: `https://app.vidcast.io/playlists/${PLAYLIST_ID}?expand=0`,
      resourceType: "playlist",
    });
  });

  it("serializes the playlist expansion preference into URLs and fenced content", () => {
    expect(
      setVidcastPlaylistExpanded(
        `https://app.vidcast.io/playlists/${PLAYLIST_ID}?autoplay=1`,
        false,
      ),
    ).toBe(
      `https://app.vidcast.io/playlists/${PLAYLIST_ID}?autoplay=1&expand=0`,
    );
    expect(
      setVidcastBlockPlaylistExpanded(
        [
          `url: https://app.vidcast.io/playlists/${PLAYLIST_ID}`,
          "title: Example playlist",
        ].join("\n"),
        true,
      ),
    ).toBe(
      [
        `url: https://app.vidcast.io/playlists/${PLAYLIST_ID}?expand=1`,
        "title: Example playlist",
      ].join("\n"),
    );
    expect(
      setVidcastPlaylistExpanded(
        "https://app.vidcast.io/share/c4a952bc-554b-4831-81da-f4d243608813",
        true,
      ),
    ).toBeNull();
  });

  it.each([
    "http://app.vidcast.io/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3",
    "https://app.vidcast.io.example.test/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3",
    "https://example.test/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3",
    "https://app.vidcast.io/share/embed/not-a-video",
    "https://app.vidcast.io/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3?unknown=1",
    "https://app.vidcast.io/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3?autoplay=yes",
    `https://app.vidcast.io/playlists/${PLAYLIST_ID}?index=first`,
    `https://app.vidcast.io/playlists/${PLAYLIST_ID}?accessRequestId=secret`,
    "https://app.vidcast.io/share/embed/de4fc0eb-7146-4044-86a3-60c3cbd976a3#fragment",
  ])("rejects unsafe or unsupported URL %s", (url) => {
    expect(normalizeVidcastUrl(url)).toBeNull();
  });

  it("rejects unsupported block fields", () => {
    expect(
      parseVidcastEmbed(
        [
          `url: https://app.vidcast.io/share/embed/${VIDEO_ID}`,
          "allow: camera *",
        ].join("\n"),
      ),
    ).toEqual({
      ok: false,
      error: "Unsupported or duplicate Vidcast field: allow.",
    });
  });
});
