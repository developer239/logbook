// A form a page posts back to the app, and the page of this app it returns to.
export const readForm = async (request: Request): Promise<FormData | null> =>
  /^(application\/x-www-form-urlencoded|multipart\/form-data)\b/u.test(request.headers.get('content-type') ?? '')
    ? request.formData()
    : null

export const pageOf = (back: FormDataEntryValue | null | undefined, url: URL): string | null => {
  const target = typeof back === 'string' && back.startsWith('/') && URL.canParse(back, url) ? new URL(back, url) : null
  return target !== null && target.origin === url.origin ? `${target.pathname}${target.search}` : null
}
