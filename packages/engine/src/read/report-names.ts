// The questions the reports are grouped by; a topic name runs every report in it.
export const REPORT_TOPICS = ['failures', 'performance', 'usage', 'sessions', 'interaction'] as const
export type ReportTopic = (typeof REPORT_TOPICS)[number]

// Every report, in the order `all` prints them.
export const REPORT_NAMES = [
  'tool-failures',
  'errors',
  'shell',
  'tool-causes',
  'repeats',
  'interrupts',
  'tools',
  'slow',
  'latency',
  'turn-time',
  'longest-turns',
  'heavy',
  'output',
  'skills',
  'commands',
  'families',
  'models',
  'daily',
  'calls',
  'chains',
  'work',
  'goals',
  'outcomes',
  'context',
  'links',
  'recovery',
  'reactions',
  'replies',
] as const
export type ReportName = (typeof REPORT_NAMES)[number]

// The selector that runs every report.
export const REPORT_NAMES_ALL = 'all'
