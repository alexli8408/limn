"use client";

import { useRef, useState, useTransition } from "react";
import { renameBoard } from "@/app/actions";

interface Props {
  boardId: string;
  title: string;
  /** Styling differs between the dashboard card and the board header. */
  className?: string;
}

/**
 * Click-to-rename, used on the dashboard card and in the board header.
 *
 * Until now a board could not be renamed from anywhere in the product. The
 * renameBoard action existed and nothing called it, so every board kept
 * whatever name it was created with, which for all of them was "Untitled
 * board". That also makes the AI's automatic naming safe: if it picks a bad
 * title there is finally a way to fix it.
 */
export default function BoardTitle({ boardId, title, className = "" }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const commit = () => {
    setEditing(false);
    const next = value.trim().slice(0, 200);
    if (!next || next === title) {
      setValue(title);
      return;
    }
    startTransition(async () => {
      try {
        await renameBoard(boardId, next);
      } catch {
        setValue(title);
      }
    });
  };

  if (editing) {
    return (
      <input
        ref={input}
        autoFocus
        value={value}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          // Escape restores rather than saving, which is what every rename
          // control everywhere does and what a user will expect here.
          if (event.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        // Stops a rename on a dashboard card from also following the card's link.
        onClick={(event) => event.stopPropagation()}
        className={`min-w-0 rounded-sm border border-[var(--ink-accent)] bg-[var(--ink-void)] px-1 py-0 text-[var(--ink-text)] outline-none ${className}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setEditing(true);
        requestAnimationFrame(() => input.current?.select());
      }}
      title="Rename this board"
      className={`min-w-0 truncate rounded-sm px-1 text-left transition hover:bg-[var(--ink-raised)] ${
        pending ? "opacity-50" : ""
      } ${className}`}
    >
      {value}
    </button>
  );
}
