import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trackedFiles } from '../tracked-files.js'

interface IQuarantined {
  file: string
  name: string
  issue: string
}

interface ITestScan {
  findings: string[]
  quarantined: IQuarantined[]
}

// Where the command writes and what it reads of its environment.
export interface ITestsIo {
  env: Readonly<Record<string, string | undefined>>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const TEST_FILE = /\.test\.[^/]+$/u
const VITEST_CONFIG = /(?:^|\/)vitest(?:\.[^/]+)?\.config\.[^/]+$/u
// A retry of one run or more; `retry: 0` asks for none.
const RETRY_SETTING = /\bretry\s*:\s*[1-9]/u
const RETRY_CALL = /\.retry\(/u
const TEST_CALL = String.raw`\b(?:it|test|describe|suite)(?:\.[A-Za-z]+)*`
const ONLY = new RegExp(`${TEST_CALL}\\.only\\b`, 'u')
const QUARANTINE = new RegExp(`${TEST_CALL}\\.(?:skip|todo)\\b(?:\\(\\s*(?<quote>['"\`])(?<name>.*?)\\k<quote>)?`, 'u')
const FLAKY_COMMENT = /^\s*\/\/ flaky: (?<issue>https:\/\/\S+)\s*$/u
const SUMMARY_FILE = 'GITHUB_STEP_SUMMARY'

const lineFinding = (file: string, number: number, rule: string, what: string): string =>
  `${file}:${String(number)}: ${what} [${rule}]`

// A retry or a focus on the line: neither ever passes.
const forbiddenFindings = (file: string, line: string, number: number): string[] => [
  ...(RETRY_SETTING.test(line) || RETRY_CALL.test(line)
    ? [lineFinding(file, number, 'no-retry', 'a retry hides a race; fix or quarantine the test')]
    : []),
  ...(ONLY.test(line) ? [lineFinding(file, number, 'no-only', '.only shrinks the suite; remove it')] : []),
]

// A skip or todo is a quarantine when the line before it names its issue, and a finding otherwise.
const scanQuarantine = (file: string, lines: readonly string[], index: number, scan: ITestScan): void => {
  const quarantine = QUARANTINE.exec(lines[index] ?? '')
  if (quarantine === null) {
    return
  }
  const issue = FLAKY_COMMENT.exec(lines[index - 1] ?? '')?.groups?.issue
  if (issue === undefined) {
    scan.findings.push(
      lineFinding(file, index + 1, 'quarantine', '.skip or .todo needs // flaky: <issue URL> on the line before')
    )
    return
  }
  scan.quarantined.push({ file, name: quarantine.groups?.name ?? '(unnamed)', issue })
}

const scanLine = (file: string, lines: readonly string[], index: number, scan: ITestScan): void => {
  scan.findings.push(...forbiddenFindings(file, lines[index] ?? '', index + 1))
  scanQuarantine(file, lines, index, scan)
}

// Every test file and Vitest configuration git tracks, scanned for retries, focused tests and unexplained skips.
const scanTests = async (root: string): Promise<ITestScan> => {
  const files = (await trackedFiles(root, ['.'])).filter((file) => TEST_FILE.test(file) || VITEST_CONFIG.test(file))
  const scan: ITestScan = { findings: [], quarantined: [] }
  const texts = await Promise.all(files.map(async (file) => readFile(join(root, file), 'utf8')))
  for (const [position, text] of texts.entries()) {
    const lines = text.split('\n')
    for (const index of lines.keys()) {
      scanLine(files[position] ?? '', lines, index, scan)
    }
  }
  return scan
}

const quarantineSection = (quarantined: readonly IQuarantined[]): string => {
  const rows = quarantined.map(({ file, name, issue }) => `- ${file}: ${name} (${issue})`)
  return ['## Quarantined tests', '', ...(rows.length === 0 ? ['None'] : rows), ''].join('\n')
}

// `check:tests`: each finding on stderr and exit 1 when there is any; the quarantined tests in the job summary under
// GitHub Actions, on stdout elsewhere.
export const checkTests = async (root: string, io: ITestsIo): Promise<number> => {
  const summary = io.env[SUMMARY_FILE]
  if (io.env.GITHUB_ACTIONS === 'true' && (summary ?? '') === '') {
    io.stderr(`Under GitHub Actions the quarantine section goes to ${SUMMARY_FILE}, which is not set.\n`)
    return 2
  }
  const scan = await scanTests(root)
  for (const finding of scan.findings) {
    io.stderr(`${finding}\n`)
  }
  const section = quarantineSection(scan.quarantined)
  if (summary === undefined || summary === '') {
    io.stdout(section)
  } else {
    await appendFile(summary, `\n${section}`)
  }
  return scan.findings.length === 0 ? 0 : 1
}
