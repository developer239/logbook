// The committed images and videos: hand-drawn artwork, listed by path, and captures, each an entry of the committed
// capture manifest that records its bytes and its source.
export const ARTWORK_FILE = 'apps/docs/artwork.json'
export const COMMITTED_CAPTURES_FILE = 'apps/docs/committed-captures.json'

// The image and video files the rules cover, matched in any letter case.
export const CAPTURE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.mp4',
  '.webm',
  '.mov',
]

// What the owner hid before committing a capture of a real page, every one of them, in this order.
export const COVERED_CATEGORIES: readonly string[] = [
  // Prompt, reply and reasoning text.
  'conversation-text',
  // Tool inputs, outputs, commands and file paths.
  'tool-text',
  // Project directories and names.
  'projects',
  // Git branches.
  'branches',
  // Session ids and titles, in the address bar and tab title too.
  'sessions',
  // Goal summaries and outcome notes a model wrote.
  'model-text',
  // MCP server names.
  'mcp-servers',
  // The user name, the host name and any home path.
  'machine',
]

// The web app's pages an owner capture can show, by name.
export const SCREENS: Readonly<Record<string, string>> = {
  'dashboard': '/',
  'conversations': '/conversations',
  'conversation': '/conversations/<id>',
  'turn-pane': '/pane/<id>',
  'steps': '/steps',
  'tokens': '/tokens',
  'labels': '/labels',
}

// The only login that may approve an owner capture.
export const OWNER_LOGIN = 'developer239'
