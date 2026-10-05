// The steps of a rewrite, in order: forget's deletion, then the compaction's full-text index rewrite, `VACUUM` and
// write-ahead log checkpoint.
export type RewriteStep = 'deletion' | 'full-text' | 'vacuum' | 'checkpoint'

// What the rewrite process is to do, its first message on the IPC channel.
export type RewriteTask =
  | { readonly kind: 'compact' }
  | { readonly kind: 'forget'; readonly sessionIds: readonly string[]; readonly forgottenAt: number }

// What the rewrite process reports on its IPC channel.
export type RewriteMessage =
  | { readonly type: 'step-ended'; readonly step: RewriteStep }
  // After the deletion committed: the sessions it removed and their label rows.
  | { readonly type: 'forgotten'; readonly sessionCount: number; readonly labelCount: number }
  // Sent before `VACUUM` starts, so after a stop the page count tells a rolled-back rewrite from a finished one.
  | { readonly type: 'pages-before-vacuum'; readonly pages: number }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'done' }
