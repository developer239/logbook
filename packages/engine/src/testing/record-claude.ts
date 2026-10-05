// Records the envelopes the claude fake answers with from the real Claude Code on the developer's machine:
// `pnpm --filter @log-book/engine record:claude <batch prompt file>`. It runs under Node's type stripping with no
// import of its own package, keeps only the fields the Claude client reads, and leaves out every other field, which in
// the real output holds the account's email address and session ids.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL = 'claude-haiku-4-5'
const SYSTEM_PROMPT = 'Answer each tagged item on its own line, starting with its tag.'
const RESULT_FIELDS = ['is_error', 'api_error_status', 'terminal_reason', 'subtype', 'result', 'usage']
const AUTH_FIELDS = ['loggedIn', 'authMethod', 'apiProvider']
const CALL_TIMEOUT_MS = 300_000

interface ICall {
  stdout: string
  exitCode: number | null
}

interface IStubAnswer {
  status: number
  body: unknown
}

const pick = (record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]))

const runClaude = (
  args: string[],
  options: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ICall> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    const chunks: string[] = []
    const timer = setTimeout(() => child.kill('SIGKILL'), CALL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    child.on('error', rejectPromise)
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolvePromise({ stdout: chunks.join(''), exitCode })
    })
    child.stdin.end(options.input ?? '')
  })

// One labelling call as the engine makes it: the prompt on stdin, no thinking, no nonessential traffic, a fresh empty
// working directory.
const labellingCall = async (prompt: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> => {
  const cwd = await mkdtemp(join(tmpdir(), 'log-book-record-'))
  try {
    const call = await runClaude(
      [
        '-p',
        '--model',
        MODEL,
        '--system-prompt',
        SYSTEM_PROMPT,
        '--tools',
        '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--setting-sources',
        'local',
        '--output-format',
        'json',
      ],
      {
        input: prompt,
        cwd,
        env: { ...process.env, ...extraEnv, MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      }
    )
    return pick(JSON.parse(call.stdout) as Record<string, unknown>, RESULT_FIELDS)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

// A local API that answers every request the same way, or never when the answer is null, so no tokens are spent.
const startStub = (answer: IStubAnswer | null): Promise<{ server: Server; url: string }> =>
  new Promise((resolvePromise) => {
    const server = createServer((request, response) => {
      request.resume()
      if (answer === null) {
        request.socket.destroy()
        return
      }
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({ server, url: `http://127.0.0.1:${String(port)}` })
    })
  })

const recordAgainstStub = async (prompt: string, answer: IStubAnswer | null): Promise<Record<string, unknown>> => {
  const { server, url } = await startStub(answer)
  try {
    return await labellingCall(prompt, { ANTHROPIC_BASE_URL: url })
  } finally {
    server.close()
  }
}

const apiError = (type: string, message: string): unknown => ({ type: 'error', error: { type, message } })

const main = async (): Promise<void> => {
  const promptFile = process.argv[2]
  if (promptFile === undefined) {
    throw new Error('Usage: record:claude <batch prompt file>')
  }
  const prompt = await readFile(promptFile, 'utf8')
  const version = (await runClaude(['--version'])).stdout.trim().split(' ')[0] ?? ''
  const directory = join(import.meta.dirname, '..', '..', 'fixtures', 'claude', version)
  await mkdir(directory, { recursive: true })
  const write = (name: string, value: unknown): Promise<void> =>
    writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)

  await writeFile(join(directory, 'version.txt'), `${version} (Claude Code)\n`)
  const auth = JSON.parse((await runClaude(['auth', 'status', '--json'])).stdout) as Record<string, unknown>
  await write('auth-status.json', pick(auth, AUTH_FIELDS))
  await write('success.json', await labellingCall(prompt))
  await write(
    'usage-limit.json',
    await recordAgainstStub(prompt, { status: 429, body: apiError('rate_limit_error', 'Usage limit reached.') })
  )
  await write(
    'auth-refused.json',
    await recordAgainstStub(prompt, { status: 401, body: apiError('authentication_error', 'Invalid credentials.') })
  )
  await write(
    'other-error.json',
    await recordAgainstStub(prompt, { status: 500, body: apiError('api_error', 'Internal server error.') })
  )
  await write(
    'prompt-too-long.json',
    await recordAgainstStub(prompt, {
      status: 400,
      body: apiError('invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
    })
  )
  await write('api-unreachable.json', await recordAgainstStub(prompt, null))
}

await main()
