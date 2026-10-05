// The steps of the rewrite, in order: the full-text index rewrite, `VACUUM`, the write-ahead log checkpoint.
export type RewriteStep = 'full-text' | 'vacuum' | 'checkpoint'

// What the rewrite process reports on its IPC channel.
export type RewriteMessage =
  | { readonly type: 'step-ended'; readonly step: RewriteStep }
  // Sent before `VACUUM` starts, so after a stop the page count tells a rolled-back rewrite from a finished one.
  | { readonly type: 'pages-before-vacuum'; readonly pages: number }
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'done' }
