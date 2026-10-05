import { pct } from '../lib/format'
import { withSelection } from '../lib/links'

// A turn counts as reached this far down the screen below the map.
const READING_LINE = 0.3
const SETTLE_MS = 120
const DOUBLE_PRESS_MS = 600
const DRAG_PX = 3
const SAME_PX = 2

type Mode = 'time' | 'turn'

interface ISpan {
  start: number
  end: number
}

interface ISelection {
  turn: string
  step: string | null
}

const item = <TItem>(list: readonly TItem[], index: number): TItem => {
  const value = list[index]
  if (value === undefined) {
    throw new RangeError(`No item ${index} of ${list.length}`)
  }

  return value
}

const need = <TElement extends Element>(root: ParentNode, selector: string): TElement => {
  const element = root.querySelector<TElement>(selector)
  if (element === null) {
    throw new Error(`The conversation page has no ${selector}`)
  }

  return element
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

const modeOf = (value: string | undefined): Mode => {
  if (value !== 'time' && value !== 'turn') {
    throw new Error(`The session map has no mode ${String(value)}`)
  }

  return value
}

const labelOf = (mark: HTMLElement): string => {
  const label = mark.getAttribute('aria-label')
  if (label === null) {
    throw new Error('A session map mark has no aria-label')
  }

  return label
}

const fraction = (mark: HTMLElement, key: string): number => {
  const value = Number(mark.dataset[key])
  if (!Number.isFinite(value)) {
    throw new Error(`A session map mark has no ${key}`)
  }

  return value
}

// Storage is a convenience: when the browser refuses it, the sections start closed.
const REMEMBERED = 'logbook.open'

const remembered = (): Record<string, boolean> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REMEMBERED) ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

const remember = (opened: Readonly<Record<string, boolean>>): void => {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(opened))
  } catch {
    // The browser keeps no storage here.
  }
}

const applyRemembered = (root: ParentNode, state: Readonly<Record<string, boolean>>): void => {
  for (const section of root.querySelectorAll<HTMLDetailsElement>('details[data-remember]')) {
    section.open = state[section.dataset['remember'] ?? ''] === true
  }
}

const writeUrl = (selection: ISelection): void => {
  const params = withSelection(new URLSearchParams(location.search), selection)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`)
}

const follow = (panes: HTMLElement, map: HTMLElement): void => {
  const paneUrl = panes.dataset['panes']
  if (paneUrl === undefined) {
    throw new Error('The conversation page does not say where its Turn pane loads from')
  }

  const thread = need<HTMLElement>(panes, '[data-thread]')
  const turns = [...thread.querySelectorAll<HTMLElement>(':scope > [data-turn]')]
  const track = need<HTMLElement>(map, '[data-track]')
  const marks = [...track.querySelectorAll<HTMLElement>('[data-mark]')]
  const win = need<HTMLElement>(track, '[data-window]')
  const act = need<HTMLElement>(track, '[data-selection]')
  const tip = need<HTMLElement>(track, '[data-tip]')
  const modes = need<HTMLElement>(map, '[data-modes]')

  const spans: Record<Mode, ISpan[]> = {
    time: marks.map((mark) => ({ start: fraction(mark, 'timeStart'), end: fraction(mark, 'timeEnd') })),
    turn: marks.map((mark) => ({ start: fraction(mark, 'turnStart'), end: fraction(mark, 'turnEnd') })),
  }

  const pane = (): HTMLElement => need<HTMLElement>(panes, '[data-turn-pane]')

  const idOf = (index: number): string => {
    const id = item(turns, index).dataset['turn']
    if (id === undefined) {
      throw new Error(`Turn ${index} of the thread has no id`)
    }

    return id
  }

  const isReduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const shownTurn = pane().dataset['turnPane']

  if (shownTurn === undefined) {
    throw new Error('The Turn pane does not say which turn it shows')
  }

  const opened = remembered()

  let selected: ISelection = { turn: shownTurn, step: new URLSearchParams(location.search).get('step') }
  let shown: ISelection | null = selected
  let active = -1

  let travel: (ISelection & { offset: number }) | null = null
  let restY: number | null = null
  let tops: number[] = []
  let line = 0

  let request: AbortController | null = null
  let loadTimer: ReturnType<typeof setTimeout> | undefined
  let travelTimer: ReturnType<typeof setTimeout> | undefined
  let isQueued = false

  let isDragging = false
  let pressedAt: number | null = null
  let lastG = 0

  // ---------- where things are ----------

  const measure = (): void => {
    const top = map.getBoundingClientRect().height
    line = top + (innerHeight - top) * READING_LINE
    tops = turns.map((turn) => turn.getBoundingClientRect().top + scrollY)
  }

  const turnAt = (offset: number): number =>
    Math.max(
      0,
      tops.findLastIndex((top) => top <= offset)
    )

  const lineIndex = (): number =>
    scrollY + innerHeight >= document.documentElement.scrollHeight - SAME_PX ? turns.length - 1 : turnAt(scrollY + line)

  const mainIndex = (turn: string): number =>
    turns.findIndex(
      (element) =>
        element.dataset['turn'] === turn || element.querySelector(`[data-turn="${CSS.escape(turn)}"]`) !== null
    )

  const mode = (): Mode => modeOf(map.dataset['mode'])
  const spanOf = (index: number): ISpan => item(spans[mode()], index)
  const nextStart = (index: number): number => (index + 1 < marks.length ? spanOf(index + 1).start : 1)
  const bottomOf = (index: number): number =>
    index + 1 < tops.length ? item(tops, index + 1) : document.documentElement.scrollHeight

  // ---------- the session map ----------

  const place = (element: HTMLElement, index: number): void => {
    const span = spanOf(index)

    element.hidden = false
    element.style.left = pct(span.start, 3)
    element.style.width = pct(span.end - span.start, 3)
  }

  const mapAt = (offset: number): number => {
    const index = turnAt(offset)
    const top = item(tops, index)
    const share = clamp((offset - top) / Math.max(bottomOf(index) - top, 1), 0, 1)
    const { start } = spanOf(index)

    return start + share * (nextStart(index) - start)
  }

  const drawWindow = (): void => {
    const from = mapAt(scrollY + map.getBoundingClientRect().height)
    const to = mapAt(scrollY + innerHeight)

    win.hidden = false
    win.style.left = pct(from, 3)
    win.style.width = pct(Math.max(to - from, 0), 3)
  }

  const redraw = (): void => {
    measure()
    drawWindow()

    if (active >= 0) {
      place(act, active)
    }
  }

  const markAt = (event: PointerEvent): { index: number; at: number } => {
    const box = track.getBoundingClientRect()
    const at = clamp((event.clientX - box.left) / box.width, 0, 1)

    return {
      index: Math.max(
        0,
        spans[mode()].findLastIndex((span) => span.start <= at)
      ),
      at,
    }
  }

  const scrub = (event: PointerEvent): void => {
    measure()

    const { index, at } = markAt(event)
    const { start } = spanOf(index)
    const share = clamp((at - start) / Math.max(nextStart(index) - start, Number.EPSILON), 0, 1)
    const top = item(tops, index)

    travel = null
    scrollTo({ top: Math.max(0, top + share * (bottomOf(index) - top) - line), behavior: 'auto' })
  }

  const showTip = (event: PointerEvent): void => {
    const box = track.getBoundingClientRect()

    tip.textContent = labelOf(item(marks, markAt(event).index))
    tip.hidden = false
    tip.style.left = `${clamp(event.clientX - box.left - tip.offsetWidth / 2, 0, box.width - tip.offsetWidth)}px`
  }

  // ---------- the Turn pane ----------

  const centerStep = (): void => {
    const current = pane()
    const step = current.querySelector('[data-open-step]')

    if (step !== null) {
      current.scrollTop +=
        step.getBoundingClientRect().top - current.getBoundingClientRect().top - current.clientHeight / 3
    }
  }

  const load = async (selection: ISelection): Promise<void> => {
    if (selection.turn === shown?.turn && selection.step === shown.step) {
      return
    }

    shown = selection
    request?.abort()

    const controller = new AbortController()
    request = controller
    const params = withSelection(new URLSearchParams(location.search), selection)

    try {
      const response = await fetch(`${paneUrl}?${params.toString()}`, { signal: controller.signal })
      pane().outerHTML = await response.text()
      applyRemembered(pane(), opened)
    } catch (error) {
      if (controller.signal.aborted) {
        return
      }

      shown = null
      throw error
    }

    if (selection.step !== null) {
      centerStep()
    }
  }

  // ---------- the selection ----------

  const setActive = (index: number): void => {
    active = index

    for (const [position, turn] of turns.entries()) {
      turn.toggleAttribute('data-active', position === index)
    }
    place(act, index)
  }

  const select = (selection: ISelection, isNow: boolean): void => {
    selected = selection

    for (const message of panes.querySelectorAll<HTMLElement>('[data-message]')) {
      if (message.dataset['turn'] === selection.turn) {
        message.setAttribute('aria-current', 'true')
      } else {
        message.removeAttribute('aria-current')
      }
    }

    clearTimeout(loadTimer)

    const apply = (): void => {
      writeUrl(selection)
      void load(selection)
    }

    if (isNow) {
      apply()
    } else {
      loadTimer = setTimeout(apply, SETTLE_MS)
    }
  }

  const arrive = (selection: ISelection): void => {
    travel = null
    restY = scrollY
    setActive(Math.max(mainIndex(selection.turn), 0))
    select(selection, true)
  }

  const goTo = (pageY: number, selection: ISelection, behavior: ScrollBehavior): void => {
    measure()
    const offset = Math.round(clamp(pageY - line + 1, 0, document.documentElement.scrollHeight - innerHeight))

    if (Math.abs(scrollY - offset) < SAME_PX) {
      arrive(selection)
      return
    }

    travel = { ...selection, offset }
    scrollTo({ top: offset, behavior: isReduced ? 'auto' : behavior })
  }

  const goToTurn = (index: number): void => {
    measure()
    const target = clamp(index, 0, turns.length - 1)
    goTo(item(tops, target), { turn: idOf(target), step: null }, 'smooth')
  }

  const followLine = (): void => {
    const index = lineIndex()
    if (index !== active) {
      setActive(index)
      select({ turn: idOf(index), step: null }, false)
    }
  }

  const onScroll = (): void => {
    if (isQueued) {
      return
    }

    isQueued = true

    requestAnimationFrame(() => {
      isQueued = false
      drawWindow()

      if (travel !== null) {
        if (Math.abs(scrollY - travel.offset) < SAME_PX) {
          arrive(travel)

          return
        }

        clearTimeout(travelTimer)
        travelTimer = setTimeout(() => {
          travel = null
          followLine()
        }, SETTLE_MS)

        return
      }

      if (restY !== null && Math.abs(scrollY - restY) < SAME_PX) {
        return
      }

      restY = null
      followLine()
    })
  }

  // ---------- keys ----------

  const from = (): number => (travel === null ? active : Math.max(mainIndex(travel.turn), 0))

  const goFailed = (direction: 1 | -1): void => {
    for (let index = from() + direction; index >= 0 && index < turns.length; index += direction) {
      if (Number(item(turns, index).dataset['failed']) > 0) {
        goToTurn(index)
        return
      }
    }
  }

  const goFailedStep = (direction: 1 | -1): void => {
    const rows = [...pane().querySelectorAll<HTMLElement>('[data-failed-step]')]
    if (rows.length === 0) {
      return
    }

    const open = rows.findIndex((row) => row.tagName === 'SUMMARY')
    const next = item(
      rows,
      open < 0 ? (direction > 0 ? 0 : rows.length - 1) : (open + direction + rows.length) % rows.length
    )

    if (next instanceof HTMLAnchorElement) {
      next.click()
    }
  }

  const openAgents = (isOpen: boolean): void => {
    for (const block of thread.querySelectorAll<HTMLDetailsElement>('details[data-spawn]')) {
      block.open = isOpen
    }
  }

  const keys: Record<string, () => void> = {
    'j': () => goToTurn(from() + 1),
    'k': () => goToTurn(from() - 1),
    'J': () => goFailed(1),
    'K': () => goFailed(-1),
    'n': () => goFailedStep(1),
    'N': () => goFailedStep(-1),
    'G': () => goToTurn(turns.length - 1),
    'g': () => {
      const now = Date.now()
      if (now - lastG < DOUBLE_PRESS_MS) {
        goToTurn(0)
        lastG = 0
      } else {
        lastG = now
      }
    },
    '[': () => openAgents(false),
    ']': () => openAgents(true),
    'Escape': () => {
      if (selected.step !== null) {
        select({ turn: selected.turn, step: null }, true)
      }
    },
  }

  // ---------- wiring ----------

  panes.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }

    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="?"]') : null
    const params = link === null ? null : new URL(link.href).searchParams
    const turn = params?.get('turn') ?? null

    if (link === null || params === null || turn === null) {
      return
    }

    event.preventDefault()

    if (getSelection()?.isCollapsed === false) {
      return
    }

    const selection = { turn, step: params.get('step') }
    const message = link.closest('[data-message]')
    if (message === null) {
      select(selection, true)
      return
    }

    measure()
    const box = message.getBoundingClientRect()
    goTo(clamp(line, box.top, box.bottom - 1) + scrollY, selection, 'smooth')
  })

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return
    }

    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable]') !== null
    ) {
      return
    }

    const action = keys[event.key]
    if (action !== undefined) {
      event.preventDefault()
      action()
    }
  })

  for (const button of modes.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('click', () => {
      map.dataset['mode'] = modeOf(button.dataset['mode'])
      for (const other of modes.querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === button))
      }

      redraw()
    })
  }

  track.addEventListener('pointerdown', (event) => {
    pressedAt = event.clientX
    track.setPointerCapture(event.pointerId)
  })

  track.addEventListener('pointermove', (event) => {
    if (pressedAt !== null && Math.abs(event.clientX - pressedAt) > DRAG_PX) {
      isDragging = true
    }

    if (isDragging) {
      scrub(event)
    }

    showTip(event)
  })

  track.addEventListener('pointerup', (event) => {
    if (pressedAt !== null && !isDragging) {
      measure()
      const { index } = markAt(event)
      goTo(item(tops, index), { turn: idOf(index), step: null }, 'auto')
    }

    pressedAt = null
    isDragging = false
  })

  track.addEventListener('pointerleave', () => {
    tip.hidden = true
  })

  track.addEventListener('click', (event) => {
    event.preventDefault()

    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-mark]') : null
    if (event.detail === 0 && mark !== null) {
      const index = marks.indexOf(mark)
      measure()
      goTo(item(tops, index), { turn: idOf(index), step: null }, 'auto')
    }
  })

  addEventListener('scroll', onScroll, { passive: true })
  addEventListener('resize', redraw)

  new ResizeObserver(redraw).observe(thread)

  document.addEventListener(
    'toggle',
    (event) => {
      const section = event.target
      if (!(section instanceof HTMLDetailsElement)) {
        return
      }

      const key = section.dataset['remember']
      if (key === undefined) {
        return
      }

      opened[key] = section.open
      remember(opened)
    },
    true
  )

  applyRemembered(document, opened)

  modes.hidden = false
  need<HTMLElement>(map, '[data-keys]').hidden = false

  measure()
  drawWindow()

  if (new URLSearchParams(location.search).has('turn')) {
    const element = panes.querySelector(`[data-message][data-turn="${CSS.escape(selected.turn)}"]`)
    const index = Math.max(mainIndex(selected.turn), 0)
    goTo(element === null ? item(tops, index) : element.getBoundingClientRect().top + scrollY, selected, 'auto')
  } else {
    followLine()
  }
}

export const followThread = (): void => {
  const panes = document.querySelector<HTMLElement>('[data-panes]')
  const map = document.querySelector<HTMLElement>('[data-map]')
  if (panes !== null && map !== null) {
    follow(panes, map)
  }
}
