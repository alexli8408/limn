"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { BoardRole } from "@/lib/supabase/types";
import { supabaseBrowser } from "@/lib/supabase/client";
import { removeCollaborator, rotateShareLink, setLinkRole } from "@/app/actions";

interface Props {
  boardId: string;
  shareUrl: string;
  /** What the link currently grants. Only the owner can change it. */
  linkRole: BoardRole;
  isOwner: boolean;
  ownerId: string;
  onClose: () => void;
}

interface Collaborator {
  userId: string;
  role: BoardRole;
  name: string;
  avatarUrl: string | null;
}

export default function ShareDialog(props: Props) {
  const [url, setUrl] = useState(props.shareUrl);
  const [role, setRole] = useState<BoardRole>(props.linkRole);
  const [copied, setCopied] = useState(false);
  const [people, setPeople] = useState<Collaborator[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const supabase = supabaseBrowser();

  const load = useCallback(async () => {
    const { data: rows, error: rowsError } = await supabase
      .from("board_collaborators")
      .select("user_id, role")
      .eq("board_id", props.boardId);

    if (rowsError) {
      setError(rowsError.message);
      return;
    }

    const ids = [...new Set([props.ownerId, ...(rows ?? []).map((r) => r.user_id)])];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .in("id", ids);

    const nameOf = new Map((profiles ?? []).map((p) => [p.id, p]));
    const owner: Collaborator = {
      userId: props.ownerId,
      role: "owner",
      name: nameOf.get(props.ownerId)?.display_name ?? "Owner",
      avatarUrl: nameOf.get(props.ownerId)?.avatar_url ?? null,
    };

    setPeople([
      owner,
      ...(rows ?? [])
        .filter((r) => r.user_id !== props.ownerId)
        .map((r) => ({
          userId: r.user_id,
          role: r.role,
          name: nameOf.get(r.user_id)?.display_name ?? "Collaborator",
          avatarUrl: nameOf.get(r.user_id)?.avatar_url ?? null,
        })),
    ]);
  }, [supabase, props.boardId, props.ownerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Could not reach the clipboard. Select the link and copy it.");
    }
  };

  const changeRole = (next: BoardRole) => {
    setRole(next);
    startTransition(async () => {
      try {
        await setLinkRole(props.boardId, next);
      } catch (e) {
        setRole(props.linkRole);
        setError(e instanceof Error ? e.message : "could not change the link role");
      }
    });
  };

  const rotate = () => {
    startTransition(async () => {
      try {
        const token = await rotateShareLink(props.boardId);
        // Keep whatever origin the current link was built from; only the token
        // changed, and rebuilding the origin here would guess at it.
        const next = new URL(url);
        next.searchParams.set("t", token);
        setUrl(next.toString());
        setCopied(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not rotate the link");
      }
    });
  };

  const remove = (userId: string) => {
    startTransition(async () => {
      try {
        await removeCollaborator(props.boardId, userId);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not remove that person");
      }
    });
  };

  return (
    // pt-32 starts the dialog below Excalidraw's floating toolbar rather than on
    // top of it, so it reads as sitting on the board instead of burying its tools.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-32"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-label="Share this board"
        className="w-full max-w-md rounded-sm border border-[var(--ink-line)] bg-[var(--ink-surface)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--ink-line)] px-4 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ink-dim)]">
            Invite to this board
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="text-[var(--ink-faint)] transition hover:text-[var(--ink-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <p className="mb-2 text-xs leading-relaxed text-[var(--ink-dim)]">
              Anyone with this link can sign in and join. They appear on the
              canvas live, and the board shows up in their boards list.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={url}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 rounded-sm border border-[var(--ink-line)] bg-[var(--ink-void)] px-2.5 py-2 font-mono text-[11px] text-[var(--ink-dim)] outline-none focus:border-[var(--ink-accent)]"
              />
              <button
                type="button"
                onClick={copy}
                className="shrink-0 rounded-sm bg-[var(--ink-accent)] px-3 py-2 text-xs font-semibold text-[#0b0813] transition hover:bg-[var(--ink-accent-hot)]"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {props.isOwner && (
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)]">
                Link grants
              </span>
              <div className="flex overflow-hidden rounded-sm border border-[var(--ink-line)]">
                {(
                  [
                    ["editor", "Can edit"],
                    ["viewer", "Can view"],
                  ] as [BoardRole, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={pending}
                    onClick={() => changeRole(value)}
                    className={`px-3 py-1.5 text-xs transition disabled:opacity-50 ${
                      role === value
                        ? "bg-[var(--ink-accent)] font-semibold text-[#0b0813]"
                        : "text-[var(--ink-faint)] hover:text-[var(--ink-dim)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--ink-faint)]">
              People with access
            </p>
            {people === null ? (
              <p className="text-xs text-[var(--ink-faint)]">Loading…</p>
            ) : (
              <ul className="space-y-1.5">
                {people.map((person) => (
                  <li key={person.userId} className="flex items-center gap-2.5">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--ink-line-bright)] text-[10px] font-semibold text-white">
                      {person.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-text)]">
                      {person.name}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                      {person.role}
                    </span>
                    {props.isOwner && person.role !== "owner" && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => remove(person.userId)}
                        className="text-[var(--ink-faint)] transition hover:text-[var(--ink-bad)] disabled:opacity-50"
                        aria-label={`Remove ${person.name}`}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {props.isOwner && (
            <div className="border-t border-[var(--ink-line)] pt-3">
              <button
                type="button"
                disabled={pending}
                onClick={rotate}
                className="text-xs text-[var(--ink-faint)] underline-offset-2 transition hover:text-[var(--ink-dim)] hover:underline disabled:opacity-50"
              >
                Reset the link
              </button>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--ink-faint)]">
                Stops the old link working. People already on the list keep their
                access, remove them above to revoke it.
              </p>
            </div>
          )}

          {error && (
            <p className="rounded-sm border border-[var(--ink-bad)]/40 bg-[var(--ink-bad)]/10 px-2.5 py-2 text-xs text-[var(--ink-bad)]">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
