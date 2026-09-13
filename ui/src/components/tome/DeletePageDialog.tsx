"use client";

import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DeletePageDialogProps = {
  path: string | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

type DeleteFolderDialogProps = {
  name: string | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

type DeleteWikiItemDialogProps = {
  name: string | null;
  deleting: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
};

function DeleteWikiItemDialog({
  name,
  deleting,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: DeleteWikiItemDialogProps) {
  return (
    <Dialog
      open={name !== null}
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}{" "}
            <span className="font-mono text-foreground">{name}</span> from this
            wiki? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={deleting}>
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            {deleting ? "Removing…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeletePageDialog({
  path,
  deleting,
  onCancel,
  onConfirm,
}: DeletePageDialogProps) {
  const fileName = path?.split("/").pop() ?? path;

  return (
    <DeleteWikiItemDialog
      name={fileName}
      deleting={deleting}
      title="Remove page?"
      description="Remove"
      confirmLabel="Remove page"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function DeleteFolderDialog({
  name,
  deleting,
  onCancel,
  onConfirm,
}: DeleteFolderDialogProps) {
  return (
    <DeleteWikiItemDialog
      name={name}
      deleting={deleting}
      title="Remove folder?"
      description="Remove the empty folder"
      confirmLabel="Remove folder"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
