// The one check every request passes before anything answers it: the host runs it on its socket, and the Astro
// middleware runs it again, so `astro dev` is guarded too. The host loads this file from the web package's build on
// its own, so it depends on nothing: no Astro, no warehouse, no other file of the app.

export interface IRequestFacts {
  method: string
  // The header values, or null where the request sent none.
  host: string | null
  origin: string | null
}

export type RequestVerdict = { isAccepted: true } | { isAccepted: false; status: number; body: string }

// localhost too, because browsers resolve it to loopback without asking DNS, so it cannot be rebound. [::1] is
// refused because the server does not listen on IPv6. The port is not compared: a request that reached the socket
// was addressed to its port, and the Origin check compares the whole origin.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

const METHODS: ReadonlySet<string> = new Set([...READS, 'POST'])

export const HOST_REFUSAL = 'Log Book answers only on 127.0.0.1 and localhost.'

export const ORIGIN_REFUSAL = 'Log Book accepts changes only from its own pages.'

const FORBIDDEN = 403

const METHOD_NOT_ALLOWED = 405

// Browsers send Origin on every POST, a same-origin form submission included, so only the app's own pages pass a
// change; Astro's own check trusts the Host header and lets a non-form content type through.
export const checkRequest = ({ method, host, origin }: IRequestFacts): RequestVerdict => {
  if (host === null || !LOOPBACK_HOST.test(host.toLowerCase())) {
    return { isAccepted: false, status: FORBIDDEN, body: HOST_REFUSAL }
  }

  if (!METHODS.has(method)) {
    return { isAccepted: false, status: METHOD_NOT_ALLOWED, body: `Log Book does not answer ${method}.` }
  }

  if (!READS.has(method) && origin !== `http://${host}`) {
    return { isAccepted: false, status: FORBIDDEN, body: ORIGIN_REFUSAL }
  }

  return { isAccepted: true }
}

// style-src allows inline styles for the computed widths and positions in style attributes; transcript text is
// escaped before it is rendered, and no link or image is made from it. frame-ancestors works only as a header.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

// same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` with a form submission, which the
// Origin check refuses, while same-origin keeps the page's own origin on its own requests and sends no other site a
// referrer.
const REFERRER_POLICY = 'same-origin'

// The headers of an accepted response; a refusal gets none of them. The host passes the running logbook's version,
// so a second start and the port probe can tell Log Book answers; under `astro dev` there is none to pass.
export const responseHeaders = (version?: string): Record<string, string> => ({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': REFERRER_POLICY,
  ...(version === undefined ? {} : { 'x-log-book': version }),
})
