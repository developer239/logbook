// While a sync runs, the button says so and cannot be pressed again.
export const watchSyncButton = (): void => {
  const form = document.querySelector<HTMLFormElement>('[data-sync]')

  form?.addEventListener('submit', () => {
    const back = form.querySelector<HTMLInputElement>('input[name="back"]')
    const label = form.querySelector('[data-sync-label]')
    const button = form.querySelector('button')

    // The page script moves the URL as the selection changes, so the sync returns
    // to the page as it is now, unless this is the sync's own page.
    if (back !== null && location.pathname !== new URL(form.action).pathname) {
      back.value = location.pathname + location.search
    }

    if (label !== null) {
      label.textContent = 'Syncing…'
    }

    if (button !== null) {
      button.disabled = true
    }
  })
}
