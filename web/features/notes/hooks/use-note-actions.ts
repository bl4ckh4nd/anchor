"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { canGoBackInApp } from "@/lib/app-history";
import {
  archiveNote,
  deleteNote,
  duplicateNote,
  permanentDeleteNote,
  restoreNote,
  unarchiveNote,
} from "../api";
import { savesSettled } from "../save-queues";
import type { Note } from "../types";
import { useRefreshNotes } from "./use-refresh-notes";

export function useNoteActions({
  noteId,
  note,
  isOwner,
  save,
  flushEdits,
  refetchNote,
  setIsArchived,
}: {
  noteId: string;
  note: Note | null;
  isOwner: boolean;
  save: () => void;
  flushEdits: () => Promise<boolean>;
  refetchNote: () => Promise<unknown>;
  setIsArchived: (isArchived: boolean) => void;
}) {
  const router = useRouter();
  const refreshLists = useRefreshNotes();
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState(false);
  const [confirmLeaveShare, setConfirmLeaveShare] = useState(false);

  const goBack = () => {
    if (!canGoBackInApp()) {
      router.push(
        note?.state === "trashed"
          ? "/trash"
          : note?.isArchived
            ? "/archive"
            : "/notes",
      );
    } else router.back();
  };
  const leave = () => {
    save();
    goBack();
  };

  const archiveMutation = useMutation({
    mutationFn: () => archiveNote(noteId),
    onSuccess: () => {
      refreshLists();
      leave();
      toast.success("Note archived", {
        undo: () =>
          unarchiveNote(noteId).then(refreshLists, () =>
            toast.error("Couldn’t undo that"),
          ),
      });
    },
    onError: () =>
      toast.error("Couldn’t archive note", {
        retry: () => archiveMutation.mutate(),
      }),
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => unarchiveNote(noteId),
    onSuccess: async () => {
      refreshLists();
      setIsArchived(false);
      await refetchNote();
      toast.success("Note unarchived", {
        undo: async () => {
          await archiveNote(noteId).catch(() =>
            toast.error("Couldn’t undo that"),
          );
          setIsArchived(true);
          refreshLists();
          refetchNote();
        },
      });
    },
    onError: () =>
      toast.error("Couldn’t unarchive note", {
        retry: () => unarchiveMutation.mutate(),
      }),
  });

  const copyMutation = useMutation({
    mutationFn: async () => {
      // A copy of text the server hasn't got yet would lose it.
      if (!(await flushEdits())) throw new Error("Edits not saved");
      return duplicateNote(noteId);
    },
    onSuccess: (copy) => {
      const copyPath = `/notes/${copy.id}`;
      refreshLists();
      router.push(copyPath);
      toast.success("Copy made. You’re editing the copy.", {
        undo: async () => {
          if (window.location.pathname === copyPath) router.back();
          await savesSettled(copy.id);
          await permanentDeleteNote(copy.id).then(refreshLists, () =>
            toast.error("Couldn’t undo that"),
          );
        },
      });
    },
    onError: () =>
      toast.error("Couldn’t make a copy", {
        retry: () => copyMutation.mutate(),
      }),
  });

  const trashMutation = useMutation({
    mutationFn: () => deleteNote(noteId),
    onSuccess: () => {
      refreshLists();
      setConfirmLeaveShare(false);
      leave();
      if (isOwner)
        toast.success("Note moved to trash", {
          undo: () =>
            restoreNote(noteId).then(refreshLists, () =>
              toast.error("Couldn’t undo that"),
            ),
        });
      else toast.success("Note removed from your notes");
    },
    onError: () =>
      toast.error(
        isOwner ? "Couldn’t move note to trash" : "Couldn’t remove note",
        {
          retry: () => trashMutation.mutate(),
        },
      ),
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreNote(noteId),
    onSuccess: async () => {
      const trashedAt = note?.stateChangedAt;
      refreshLists();
      await refetchNote();
      toast.success("Note restored", {
        undo: async () => {
          await deleteNote(noteId, trashedAt).catch(() =>
            toast.error("Couldn’t undo that"),
          );
          refreshLists();
          refetchNote();
        },
      });
    },
    onError: () =>
      toast.error("Couldn’t restore note", {
        retry: () => restoreMutation.mutate(),
      }),
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: () => permanentDeleteNote(noteId),
    onSuccess: () => {
      refreshLists();
      setConfirmPermanentDelete(false);
      goBack();
      toast.success("Note permanently deleted");
    },
    onError: () =>
      toast.error("Couldn’t delete note", {
        retry: () => permanentDeleteMutation.mutate(),
      }),
  });

  return {
    goBack,
    archive: () => archiveMutation.mutate(),
    unarchive: () => unarchiveMutation.mutate(),
    makeCopy: () => {
      if (!copyMutation.isPending) copyMutation.mutate();
    },
    trash: () =>
      isOwner ? trashMutation.mutate() : setConfirmLeaveShare(true),
    leaveShare: () => trashMutation.mutate(),
    isLeavingShare: trashMutation.isPending,
    restore: () => restoreMutation.mutate(),
    isRestoring: restoreMutation.isPending,
    deletePermanently: () => permanentDeleteMutation.mutate(),
    isDeletingPermanently: permanentDeleteMutation.isPending,
    confirmPermanentDelete,
    setConfirmPermanentDelete,
    confirmLeaveShare,
    setConfirmLeaveShare,
  };
}
