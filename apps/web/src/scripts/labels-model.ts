// Changing the model reloads /labels with it, so the plan names the model a run would use.
export const watchModelField = (): void => {
  const form = document.querySelector<HTMLFormElement>('[data-labels-model]')

  form?.addEventListener('change', () => {
    form.requestSubmit()
  })
}
