/**
 * Hand-written to match supabase/migrations. Regenerate with
 *   supabase gen types typescript --local > lib/supabase/types.ts
 * once a project is linked; until then this is the source of type safety for
 * every query, so it must be kept in step with the SQL by hand.
 */

export type BoardVisibility = "private" | "link" | "public";
export type BoardRole = "owner" | "editor" | "viewer";
export type AiMode = "refine" | "recompose" | "prompt" | "vectorize" | "illustrate";

export type BoardRow = {
  id: string;
  owner_id: string;
  title: string;
  visibility: BoardVisibility;
  share_token: string;
  link_role: BoardRole;
  thumbnail_url: string | null;
  element_count: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
};

export type SnapshotRow = {
  board_id: string;
  version: number;
  elements: unknown[];
  files: unknown[];
  updated_by: string | null;
  updated_at: string;
};

export type ProfileRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  is_guest: boolean;
  created_at: string;
  updated_at: string;
};

export type PlatformStats = {
  boards: number;
  boards_active_24h: number;
  users: number;
  elements: number;
  revisions: number;
  ai_generations: number;
  ai_latency_p50_ms: number;
  ai_latency_p95_ms: number;
  vision_jobs: number;
  vision_shapes: number;
  vision_latency_p50_ms: number;
  computed_at: string;
};

/**
 * Every row type above is a `type` alias, never an `interface`, and that is
 * load-bearing. postgrest-js constrains `Row` to `Record<string, unknown>`, and
 * TypeScript only synthesises an implicit index signature for type aliases,
 * an interface never satisfies it. Declare `BoardRow` as an interface and the
 * whole schema silently fails `extends GenericSchema`, which resolves `Schema`
 * to `never`; every `.from()` then yields `never` and every `.rpc()` reports its
 * argument as unassignable to `undefined`. The errors all point at call sites,
 * none of them at the real cause.
 *
 * postgrest-js also requires `Relationships` on every table entry, it is part of its
 * GenericTable contract, and omitting it makes the table resolve to `never`, so
 * every query against it fails to typecheck with an error pointing at the call
 * site rather than at this file. Empty is correct: we never use the
 * embedded-resource select syntax that consumes them.
 */
type NoRelationships = [];

export type Database = {
  public: {
    Tables: {
      boards: {
        Row: BoardRow;
        Insert: Partial<BoardRow> & { owner_id: string };
        Update: Partial<BoardRow>;
        Relationships: NoRelationships;
      };
      board_snapshots: {
        Row: SnapshotRow;
        Insert: Partial<SnapshotRow> & { board_id: string };
        Update: Partial<SnapshotRow>;
        Relationships: NoRelationships;
      };
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> & { id: string };
        Update: Partial<ProfileRow>;
        Relationships: NoRelationships;
      };
      board_collaborators: {
        Row: { board_id: string; user_id: string; role: BoardRole; added_at: string };
        Insert: { board_id: string; user_id: string; role?: BoardRole };
        Update: { role?: BoardRole };
        Relationships: NoRelationships;
      };
      ai_generations: {
        Row: {
          id: string;
          board_id: string | null;
          user_id: string | null;
          mode: AiMode;
          model: string;
          prompt: string | null;
          input_elements: number;
          output_elements: number;
          latency_ms: number;
          prompt_tokens: number;
          output_tokens: number;
          ok: boolean;
          error: string | null;
          created_at: string;
        };
        Insert: {
          board_id?: string | null;
          user_id?: string | null;
          mode: AiMode;
          model: string;
          prompt?: string | null;
          input_elements?: number;
          output_elements?: number;
          latency_ms?: number;
          prompt_tokens?: number;
          output_tokens?: number;
          ok?: boolean;
          error?: string | null;
        };
        Update: Record<string, never>;
        Relationships: NoRelationships;
      };
      vision_jobs: {
        Row: {
          id: string;
          board_id: string | null;
          user_id: string | null;
          kind: string;
          strokes_in: number;
          shapes_out: number;
          latency_ms: number;
          created_at: string;
        };
        Insert: {
          board_id?: string | null;
          user_id?: string | null;
          kind: string;
          strokes_in?: number;
          shapes_out?: number;
          latency_ms?: number;
        };
        Update: Record<string, never>;
        Relationships: NoRelationships;
      };
    };
    Views: Record<string, never>;
    Functions: {
      create_board: { Args: { p_title?: string }; Returns: BoardRow };
      claim_board_access: { Args: { p_share_token: string }; Returns: BoardRow };
      rotate_share_token: { Args: { p_board_id: string }; Returns: string };
      save_board_snapshot: {
        Args: {
          p_board_id: string;
          p_elements: unknown;
          p_base_version: number;
          p_files?: unknown;
        };
        Returns: { version: number; saved: boolean; element_count: number | null }[];
      };
      touch_board_opened: { Args: { p_board_id: string }; Returns: void };
      board_role_for: { Args: { p_board_id: string; p_user_id?: string }; Returns: BoardRole | null };
      can_read_board: { Args: { p_board_id: string }; Returns: boolean };
      can_edit_board: { Args: { p_board_id: string }; Returns: boolean };
      platform_stats: { Args: Record<string, never>; Returns: PlatformStats };
    };
    Enums: {
      board_visibility: BoardVisibility;
      board_role: BoardRole;
      ai_mode: AiMode;
    };
    CompositeTypes: Record<string, never>;
  };
};
