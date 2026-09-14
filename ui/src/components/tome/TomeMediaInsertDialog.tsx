"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  matchTomeEmbedUrl,
  parseTomeEmbed,
  serializeTomeEmbedBlock,
  type TomeEmbedProvider,
} from "@/lib/tome/embeds";
import {
  normalizeVidcastUrl,
  setVidcastPlaylistExpanded,
} from "@/lib/tome/vidcast";
import { cn } from "@/lib/utils";

const PROVIDERS: Array<{ value: TomeEmbedProvider; label: string; hint: string }> = [
  { value: "youtube", label: "YouTube", hint: "Video or playlist URL" },
  { value: "vidcast", label: "Vidcast", hint: "Video share or playlist URL" },
  { value: "arxiv", label: "arXiv", hint: "Paper URL or arXiv ID" },
  { value: "pdf", label: "PDF", hint: "Direct HTTPS .pdf URL" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (markdown: string) => void;
}

export function TomeMediaInsertDialog({ open, onOpenChange, onInsert }: Props) {
  const [provider, setProvider] = useState<TomeEmbedProvider>("youtube");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [playlistExpanded, setPlaylistExpanded] = useState(true);
  const isVidcastPlaylist =
    provider === "vidcast" && normalizeVidcastUrl(url)?.resourceType === "playlist";
  const serializedUrl = isVidcastPlaylist
    ? (setVidcastPlaylistExpanded(url, playlistExpanded) ?? url)
    : url;
  const block = useMemo(
    () => serializeTomeEmbedBlock(provider, serializedUrl, title),
    [provider, serializedUrl, title],
  );
  const validation = useMemo(
    () => (url.trim() ? parseTomeEmbed(provider, block.split("\n").slice(1, -1).join("\n")) : null),
    [block, provider, url],
  );
  const error = validation?.ok === false ? validation.error : null;

  const insert = () => {
    if (!validation?.ok) return;
    onInsert(`\n\n${block}\n\n`);
    setUrl("");
    setTitle("");
    setPlaylistExpanded(true);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Insert media</DialogTitle>
          <DialogDescription>
            Paste a YouTube, Vidcast, arXiv, or direct PDF link. Tome recognizes the provider and
            saves a portable Markdown block with a validated preview and source link.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="Media type">
            {PROVIDERS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setProvider(option.value)}
                className={cn(
                  "rounded-md border px-2 py-2 text-sm",
                  provider === option.value ? "border-primary bg-primary/10" : "border-border hover:bg-muted",
                )}
                aria-pressed={provider === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tome-media-url">{PROVIDERS.find((item) => item.value === provider)?.hint}</Label>
            <Input
              id="tome-media-url"
              value={url}
              onChange={(event) => {
                const nextUrl = event.target.value;
                setUrl(nextUrl);
                const match = matchTomeEmbedUrl(nextUrl);
                if (match) setProvider(match.provider);
                const vidcast = normalizeVidcastUrl(nextUrl);
                if (vidcast?.resourceType === "playlist") {
                  setPlaylistExpanded(new URL(nextUrl).searchParams.get("expand") !== "0");
                }
              }}
              placeholder="https://…"
              autoFocus
            />
          </div>
          {isVidcastPlaylist && (
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div className="grid gap-1">
                <Label htmlFor="tome-vidcast-playlist-expanded">Show playlist videos</Label>
                <p className="text-xs text-muted-foreground">
                  Open the playlist tray so every video is immediately visible and selectable.
                </p>
              </div>
              <Switch
                id="tome-vidcast-playlist-expanded"
                checked={playlistExpanded}
                onCheckedChange={setPlaylistExpanded}
                aria-label="Show playlist videos"
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="tome-media-title">Accessible title</Label>
            <Input
              id="tome-media-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Describe this content"
              maxLength={200}
            />
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={insert} disabled={!validation?.ok}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
