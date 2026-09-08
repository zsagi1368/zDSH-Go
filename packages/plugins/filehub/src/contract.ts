import { z } from 'zod'

/**
 * Wire contract single source of truth (plan P01 §5.2).
 * The host-side manifest registration and the client-side remote proxy both
 * derive from these schemas; neither side may hand-roll a second copy.
 */

export const UploadResultSchema = z.object({
  /** Absolute path inside the session workspace. */
  path: z.string().min(1),
  /** Path relative to the session cwd, usable in @ mentions. */
  relativePath: z.string(),
  /** Byte-sniffed type (magic bytes authority), e.g. "image/png" or "text/plain". */
  sniffedType: z.string().min(1),
  /** Sanitized display label. */
  label: z.string().min(1),
  /** M4: one-sentence image caption; present only when the vision waterfall produced one. */
  imageCaption: z.string().min(1).optional(),
})
export type UploadResult = z.infer<typeof UploadResultSchema>

export const FileEntrySchema = z.object({
  path: z.string().min(1),
  relativePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  kind: z.enum(['file', 'directory']),
  uploadedAtMs: z.number().int().nonnegative().optional(),
  /**
   * M6 caption passthrough: the persisted vision caption read from upload
   * metadata. Present only for images whose caption waterfall produced one.
   */
  imageCaption: z.string().min(1).optional(),
})
export type FileEntry = z.infer<typeof FileEntrySchema>

export const ListResultSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(FileEntrySchema),
  /** True when the bounded traversal hit maxFiles and stopped early. */
  truncated: z.boolean(),
})
export type ListResult = z.infer<typeof ListResultSchema>

/**
 * Existence-checked structured reference injected at send time (plan FR-B5).
 * The referenced file's CONTENT never crosses the wire — only path + kind.
 */
export const WorkspaceReferenceSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['file', 'directory']),
})
export type WorkspaceReference = z.infer<typeof WorkspaceReferenceSchema>

/**
 * Wire contract for the mention search endpoint (GET /api/filehub/search).
 * M6 seam consolidation: this used to live in src/server/mention.ts (the
 * TODO(M5 consolidation) note); contract.ts is the single wire-shape source,
 * so the schema moved here next to ListResultSchema. mention.ts re-exports it
 * for backwards compatibility.
 */
export const SearchResultSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(FileEntrySchema),
  truncated: z.boolean(),
})
export type SearchResult = z.infer<typeof SearchResultSchema>
