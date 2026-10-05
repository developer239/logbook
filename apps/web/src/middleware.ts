import type { MiddlewareHandler } from 'astro'
import { checkRequest, responseHeaders } from './lib/guard'

// Under `astro dev` this is the only guard; under the host it checks again what the host checked first.
export const onRequest: MiddlewareHandler = async (context, next) => {
  const { headers, method } = context.request
  const verdict = checkRequest({ method, host: headers.get('host'), origin: headers.get('origin') })

  if (!verdict.isAccepted) {
    return new Response(verdict.body, { status: verdict.status })
  }

  const response = await next()

  for (const [name, value] of Object.entries(responseHeaders())) {
    response.headers.set(name, value)
  }

  return response
}
