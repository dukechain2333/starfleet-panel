// The panel: what the readings look like as LCARS rows, and as the /lcars
// report. Pure functions of a PanelView, so the tests can check each layout
// at any width without a session.

import type { Readings } from '../types'
import { LCARS, STANDARD_FRAME, alertFrame, clipPieces, fitRow, merge, mix, pill, widthOf } from './lcars'
import type { Frame, Item, Piece } from './lcars'
import {
  cellWidth,
  clip,
  clipStart,
  clockTime,
  countdown,
  gauge,
  homePath,
  modelName,
  shortDate,
  spanText,
  stardate,
  tokenCount,
  warpFactor,
} from './readouts'

export type LabelSet = 'starfleet' | 'plain'

/**
 * red-alert's state as the panel shows it, in its color: `label` in full
 * (`CONDITION GREEN`), `short` for the end block (`GREEN`, at most 10 cells).
 */
export type Condition = { label: string; short: string; color: string }

/** Everything one drawing of the panel depends on. */
export type PanelView = {
  readings: Readings | null
  now: number
  isWorking: boolean
  labels: LabelSet
  showCost: boolean
  showUserHost: boolean
  /** red-alert's alert while its band shows one: the frame takes its color. */
  alert: { title: string; level: string; color: string } | null
  /** The dark half of the blink while a red or yellow alert animates. */
  isBlinkDark: boolean
  /** red-alert's condition; null when red-alert is not loaded or not followed. */
  condition: Condition | null
}

/**
 * The words the panel uses, Starfleet's or plain ones: every label, the date
 * in the sidebar, the end block's words, and how a percentage and a reset read.
 */
export const LABELS = {
  starfleet: {
    helm: 'HELM',
    core: 'CORE',
    fiveHour: 'DILITHIUM',
    sevenDay: 'ANTIMATTER',
    cost: 'ENERGY',
    sector: 'SECTOR',
    course: 'COURSE',
    env: 'ENV',
    crew: 'CREW',
    idle: 'STANDBY',
    working: 'ENGAGED',
    condition: 'CONDITION',
    clock: 'SHIP TIME',
    loading: 'SENSORS',
    loadingValue: 'INITIALIZING',
    used: '',
    left: '',
    report: 'LCARS STATUS REPORT',
    date: (ms: number) => stardate(ms),
    reportDate: (ms: number) => `STARDATE ${stardate(ms)}`,
    reset: (ms: number) => countdown(ms),
  },
  plain: {
    helm: 'MODEL',
    core: 'CONTEXT',
    fiveHour: '5H LIMIT',
    sevenDay: '7D LIMIT',
    cost: 'COST',
    sector: 'DIR',
    course: 'GIT',
    env: 'ENV',
    crew: 'USER',
    idle: 'IDLE',
    working: 'WORKING',
    condition: 'ALERTS',
    clock: 'TIME',
    loading: 'STATUS',
    loadingValue: 'LOADING',
    used: ' used',
    left: ' left',
    report: 'STATUS REPORT',
    date: (ms: number) => shortDate(ms),
    reportDate: (ms: number) => shortDate(ms),
    reset: (ms: number) => `reset ${spanText(ms)}`,
  },
} as const

/** red-alert's states, in each set of words: the full label, and the end block's short one. */
const CONDITIONS = {
  starfleet: {
    linking: ['LINKING', 'LINKING'],
    offline: ['ALERTS OFFLINE', 'OFFLINE'],
    muted: ['GREEN · MUTED', 'MUTED'],
    green: ['CONDITION GREEN', 'GREEN'],
  },
  plain: {
    linking: ['ALERTS LINKING', 'LINKING'],
    offline: ['ALERTS OFFLINE', 'OFFLINE'],
    muted: ['ALERTS MUTED', 'MUTED'],
    green: ['ALERTS ONLINE', 'ONLINE'],
  },
} as const

/** red-alert's state when no alert is up, as the panel words it. */
export function conditionFor(state: keyof (typeof CONDITIONS)['plain'], labels: LabelSet, color: string): Condition {
  const [label, short] = CONDITIONS[labels][state]
  return { label, short, color }
}

type Labels = (typeof LABELS)[LabelSet]

/** The left sidebar's width in cells, and the right end block's. */
const SIDEBAR = 10
const END_BLOCK = 11
/** What the elbows take beside the columns: sidebar, fillet and gap; gap, fillet and end block. */
const LEFT_SPAN = SIDEBAR + 2
const RIGHT_SPAN = END_BLOCK + 2
/** Below this width the bridge frame gives way to the one-row strip. */
export const BRIDGE_MIN_WIDTH = 60
/** The compact strip's sidebar pill: fits `RED ALERT` and `ENGAGED`. */
const PILL_ROOM = 9

/** Calm, caution, danger: the thresholds of the status line this panel replaces. */
export function levelColor(percentUsed: number): string {
  if (percentUsed >= 80) return LCARS.red
  if (percentUsed >= 60) return LCARS.yellow
  return LCARS.blue
}

function frameOf(view: PanelView): Frame {
  return view.alert ? alertFrame(view.alert.color) : STANDARD_FRAME
}

/** A block's colors: ink on its color, inverted on the dark half of an alert's blink. */
function blockStyle(view: PanelView, color: string): Omit<Piece, 'text'> {
  return view.alert && view.isBlinkDark
    ? { color, backgroundColor: mix(color, LCARS.ink, 0.75), bold: true }
    : { color: LCARS.ink, backgroundColor: color, bold: true }
}

/** `label` right-aligned in a block `width` cells wide, as LCARS numbers its blocks. */
function blockText(label: string, width: number): string {
  return `${clip(label, width - 2).padStart(width - 1)} `
}

// ---------------------------------------------------------------------------
// The bridge layout
// ---------------------------------------------------------------------------

/** One column of the bridge frame: a header segment, a label row, a value row. */
type Column = {
  priority: number
  /** Shown only while every column fits at its preferred width. */
  isOptional: boolean
  /** Its header segment and label, while no alert repaints the frame. */
  color: string
  /** Widths in cells, each with one cell of air after the content. */
  min: number
  pref: number
  label: (room: number) => Piece[]
  value: (room: number) => Piece[]
}

function column(spec: Omit<Column, 'min' | 'pref' | 'isOptional'> & { min: number; pref: number; isOptional?: boolean }): Column {
  return { ...spec, isOptional: spec.isOptional ?? false, min: spec.min + 1, pref: Math.max(spec.min, spec.pref) + 1 }
}

/** A meter and its percentage in `room` cells; the meter shrinks first, then goes. */
function metered(percent: number, text: string, color: string, room: number): Piece[] {
  const cells = Math.min(12, room - 1 - text.length)
  const value: Piece = { text, color, bold: true }
  if (cells < 3) return [value]
  const g = gauge(percent, cells)
  return [{ text: g.lit, color }, { text: g.dark, color: mix(color, LCARS.ink, 0.72) }, { text: ' ' }, value]
}

/** The readings as columns, in the order they stand. */
function columnsOf(view: PanelView, labels: Labels, frame: Frame): Column[] {
  const r = view.readings
  const tint = (color: string) => (view.alert ? frame.label : color)
  if (!r) {
    return [
      column({
        priority: 10,
        color: LCARS.orange,
        min: 12,
        pref: 12,
        label: () => [{ text: labels.loading, color: tint(LCARS.orange) }],
        value: () => [{ text: labels.loadingValue, color: frame.label }],
      }),
    ]
  }
  const columns: Column[] = []
  const minor = (text: string): Piece => ({ text, color: view.alert ? frame.label : LCARS.tan })

  const model = modelName(r.model)
  const effort = view.labels === 'starfleet' ? warpFactor(r.effort) : (r.effort?.toUpperCase() ?? null)
  columns.push(
    column({
      priority: 10,
      color: LCARS.peach,
      min: Math.min(14, Math.max(labels.helm.length, cellWidth(model))),
      pref: Math.max(labels.helm.length, cellWidth(model) + (effort ? effort.length + 1 : 0)),
      label: () => [{ text: labels.helm, color: tint(LCARS.peach) }],
      value: room => {
        const name: Piece = { text: clip(model, room), color: LCARS.blue, bold: true }
        return effort && cellWidth(model) + 1 + effort.length <= room
          ? [name, { text: ' ' }, { text: effort, color: LCARS.peach, bold: true }]
          : [name]
      },
    }),
  )

  const ctx = r.context.percent
  const ctxText = ctx === null ? '--' : `${Math.round(ctx)}%${labels.used}`
  const ctxColor = ctx === null ? frame.label : levelColor(ctx)
  columns.push(
    column({
      priority: 9,
      color: LCARS.blue,
      min: Math.max(labels.core.length, 5 + ctxText.length),
      pref: Math.max(labels.core.length, 11 + ctxText.length),
      label: () => [{ text: labels.core, color: tint(LCARS.blue) }],
      value: room => metered(ctx ?? 0, ctxText, ctxColor, room),
    }),
  )

  const windows = [
    { limit: r.fiveHour, label: labels.fiveHour, priority: 8, color: LCARS.lavender, meter: 12 },
    { limit: r.sevenDay, label: labels.sevenDay, priority: 6, color: LCARS.violet, meter: 0 },
  ]
  for (const w of windows) {
    if (!w.limit) continue
    const left = Math.max(0, Math.round(100 - w.limit.used))
    const text = `${left}%${labels.left}`
    const color = levelColor(w.limit.used)
    const reset = w.limit.resetsAt === null ? '' : labels.reset(w.limit.resetsAt - view.now)
    const hasMeter = w.meter > 0
    columns.push(
      column({
        priority: w.priority,
        color: w.color,
        min: Math.max(w.label.length, hasMeter ? 5 + text.length : text.length),
        pref: hasMeter
          ? Math.max(w.label.length + (reset ? reset.length + 1 : 0), w.meter + 1 + text.length)
          : Math.max(w.label.length, text.length + (reset ? reset.length + 1 : 0)),
        label: room => {
          const name: Piece = { text: w.label, color: tint(w.color) }
          return hasMeter && reset && w.label.length + 1 + reset.length <= room ? [name, { text: ' ' }, minor(reset)] : [name]
        },
        value: room => {
          if (hasMeter) return metered(left, text, color, room)
          const value: Piece = { text, color, bold: true }
          return reset && text.length + 1 + reset.length <= room ? [value, { text: ' ' }, minor(reset)] : [value]
        },
      }),
    )
  }

  const path = homePath(r.cwd, r.home)
  const where = r.branch ? `${labels.course} ${r.branch}` : labels.sector
  const wherePref = Math.min(40, Math.max(cellWidth(where), cellWidth(path)))
  columns.push(
    column({
      priority: 7,
      color: LCARS.sand,
      min: Math.min(12, wherePref),
      pref: wherePref,
      label: () =>
        r.branch
          ? [{ text: `${labels.course} `, color: tint(LCARS.sand) }, { text: r.branch, color: LCARS.violet, bold: true }]
          : [{ text: labels.sector, color: tint(LCARS.sand) }],
      value: room => [{ text: clipStart(path, room), color: LCARS.sand, bold: true }],
    }),
  )

  const optional = (priority: number, color: string, label: string, value: Piece) => {
    const room = Math.min(24, Math.max(label.length, cellWidth(value.text)))
    columns.push(
      column({
        priority,
        isOptional: true,
        color,
        min: room,
        pref: room,
        label: () => [{ text: label, color: tint(color) }],
        value: width => [{ ...value, text: clip(value.text, width) }],
      }),
    )
  }
  if (r.pyenv) optional(5, LCARS.tan, labels.env, { text: r.pyenv, color: LCARS.peach, bold: true })
  if (view.showCost && r.costUsd !== null) {
    optional(4, LCARS.orange, labels.cost, { text: `$${r.costUsd.toFixed(2)}`, color: LCARS.sand, bold: true })
  }
  if (view.showUserHost && r.user) {
    optional(3, LCARS.violet, labels.crew, { text: r.host ? `${r.user}@${r.host}` : r.user, color: frame.label })
  }
  return columns
}

/**
 * Picks the columns that fit `room` cells and sizes them: optional columns
 * leave first, while the rest do not fit at their preferred widths; then the
 * least important go until the rest fit at their least. Each column grows to
 * its preferred width, most important first, and what is left is shared out.
 */
function allocate(columns: readonly Column[], room: number): { column: Column; width: number }[] {
  const total = (list: readonly Column[], key: 'min' | 'pref') =>
    list.reduce((n, c) => n + c[key], 0) + Math.max(0, list.length - 1)
  const withoutLowest = (list: readonly Column[], isCandidate: (c: Column) => boolean) => {
    let lowest = -1
    list.forEach((c, i) => {
      const current = list[lowest]
      if (isCandidate(c) && (current === undefined || c.priority < current.priority)) lowest = i
    })
    return lowest === -1 ? list : list.filter((_, i) => i !== lowest)
  }
  let active = [...columns]
  while (total(active, 'pref') > room) {
    const next = withoutLowest(active, c => c.isOptional)
    if (next === active) break
    active = [...next]
  }
  while (total(active, 'min') > room && active.length > 1) active = [...withoutLowest(active, () => true)]

  const widths = active.map(c => c.min)
  let extra = room - total(active, 'min')
  const byImportance = active.map((_, i) => i).sort((a, b) => (active[b]?.priority ?? 0) - (active[a]?.priority ?? 0))
  for (const i of byImportance) {
    const add = Math.max(0, Math.min(extra, (active[i]?.pref ?? 0) - (widths[i] ?? 0)))
    widths[i] = (widths[i] ?? 0) + add
    extra -= add
  }
  const each = Math.floor(extra / active.length)
  const last = active.length - 1
  return active.map((c, i) => ({ column: c, width: (widths[i] ?? 0) + each + (i === last ? extra - each * active.length : 0) }))
}

/** `pieces` in a column `width` cells wide: cut to leave one cell of air, then padded. */
function cell(pieces: Piece[], width: number): Piece[] {
  const kept = clipPieces(pieces, width - 1)
  return [...kept, { text: ' '.repeat(Math.max(0, width - widthOf(kept))) }]
}

/** The end block: red-alert's condition, or the ship's time when red-alert is absent. */
function endBlock(view: PanelView, frame: Frame, labels: Labels): { color: string; top: string; bottom: string } {
  if (view.condition) return { color: view.condition.color, top: labels.condition, bottom: view.condition.short }
  return { color: frame.secondary, top: labels.clock, bottom: clockTime(view.now) }
}

/**
 * The bridge layout, an LCARS ops console in three rows: elbows at both
 * ends, a header bar cut into one colored segment per column, the labels
 * under their segments and the values under the labels. The sidebar holds
 * Claude's state over the stardate; the end block, red-alert's condition.
 *
 *   ██████████▛ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▜███████████
 *     STANDBY   HELM            CORE            DILITHIUM T-2H14M  ANTIMATTER  COURSE main          CONDITION
 *     80753.1   OPUS 5.5 WARP 9 ▊▊▊▊▊▊▊▊▊▊ 42%  ▊▊▊▊▊▊▊▊▊▊▊▊ 72%   88% T-3D4H  ~/starfleet_panel       GREEN
 */
export function bridgeRows(view: PanelView, width: number): Piece[][] {
  const frame = frameOf(view)
  const labels = LABELS[view.labels]
  const columns = allocate(columnsOf(view, labels, frame), width - LEFT_SPAN - RIGHT_SPAN)
  const across = (draw: (entry: { column: Column; width: number }, i: number) => Piece[]) =>
    columns.flatMap((entry, i) => [...(i > 0 ? [{ text: ' ' }] : []), ...draw(entry, i)])
  const segment = (c: Column, i: number) => (view.alert ? (frame.shades[i % frame.shades.length] ?? frame.primary) : c.color)
  const end = endBlock(view, frame, labels)

  // The blocks' tops are solid cells, so they meet the rows below whatever the
  // terminal's line spacing; the bars hang from the top edge, flush with them.
  const top: Piece[] = [
    { text: ' '.repeat(SIDEBAR), backgroundColor: frame.primary },
    { text: '▛', color: frame.primary },
    { text: ' ' },
    ...across(({ column: c, width: w }, i) => [{ text: '▀'.repeat(w), color: segment(c, i) }]),
    { text: ' ' },
    { text: '▜', color: end.color },
    { text: ' '.repeat(END_BLOCK), backgroundColor: end.color },
  ]
  const middle: Piece[] = [
    { text: blockText(view.isWorking ? labels.working : labels.idle, SIDEBAR), ...blockStyle(view, frame.primary) },
    { text: '  ' },
    ...across(({ column: c, width: w }) => cell(c.label(w - 1), w)),
    { text: '  ' },
    { text: blockText(end.top, END_BLOCK), ...blockStyle(view, end.color) },
  ]
  const bottom: Piece[] = [
    {
      text: blockText(labels.date(view.now), SIDEBAR),
      color: view.alert ? frame.label : LCARS.ink,
      backgroundColor: frame.block,
      bold: true,
    },
    { text: '  ' },
    ...across(({ column: c, width: w }) => cell(c.value(w - 1), w)),
    { text: '  ' },
    { text: blockText(end.bottom, END_BLOCK), ...blockStyle(view, end.color) },
  ]
  return [merge(top), merge(middle), merge(bottom)]
}

// ---------------------------------------------------------------------------
// The compact layout
// ---------------------------------------------------------------------------

function sidebarLabel(view: PanelView, labels: Labels): string {
  if (view.alert) {
    const title = view.alert.title.toUpperCase()
    return clip(cellWidth(title) <= PILL_ROOM ? title : view.alert.level.toUpperCase(), PILL_ROOM)
  }
  return view.isWorking ? labels.working : labels.idle
}

/** The readings as droppable items for the one-row strip. */
function stripItems(view: PanelView, labels: Labels, frame: Frame): Item[] {
  const r = view.readings
  if (!r) return [{ priority: 10, pieces: [{ text: `${labels.loading} ${labels.loadingValue}`, color: frame.label }] }]
  const gap = { text: '  ' }
  const items: Item[] = [{ priority: 10, pieces: [{ text: modelName(r.model), color: LCARS.blue, bold: true }] }]
  const effort = view.labels === 'starfleet' ? warpFactor(r.effort) : (r.effort?.toUpperCase() ?? null)
  if (effort) items.push({ priority: 5, pieces: [{ text: ' ' }, { text: effort, color: LCARS.peach, bold: true }] })
  const reading = (label: string, text: string, color: string, priority: number) =>
    items.push({ priority, pieces: [gap, { text: `${label} `, color: frame.label }, { text, color, bold: true }] })
  const ctx = r.context.percent
  reading(labels.core, ctx === null ? '--' : `${Math.round(ctx)}%${labels.used}`, ctx === null ? frame.label : levelColor(ctx), 9)
  if (r.fiveHour) reading(labels.fiveHour, `${Math.max(0, Math.round(100 - r.fiveHour.used))}%${labels.left}`, levelColor(r.fiveHour.used), 8)
  if (r.sevenDay) reading(labels.sevenDay, `${Math.max(0, Math.round(100 - r.sevenDay.used))}%${labels.left}`, levelColor(r.sevenDay.used), 7)
  if (r.branch) {
    items.push({
      priority: 4,
      pieces: [gap, { text: `${labels.course} `, color: frame.label }, { text: clip(r.branch, 24), color: LCARS.violet, bold: true }],
    })
  }
  return items
}

/**
 * The compact layout: one row, drawn as red-alert's idle strip is.
 *
 *   ▐ STANDBY ▌ OPUS 5.5 WARP 9  CORE 42%  DILITHIUM 72%  COURSE main ━━━━━━━ ▐ GREEN ▌
 */
export function compactRow(view: PanelView, width: number): Piece[] {
  const frame = frameOf(view)
  const labels = LABELS[view.labels]
  const style = blockStyle(view, frame.primary)
  const items = stripItems(view, labels, frame)
  return fitRow(
    {
      left: [
        { text: '▐', color: style.backgroundColor },
        { text: ` ${sidebarLabel(view, labels)} `, ...style },
        { text: '▌', color: style.backgroundColor },
        { text: ' ' },
      ],
      items,
      fillAt: items.length,
      fill: cells =>
        cells >= 3
          ? [{ text: ' ' }, { text: '━'.repeat(cells - 2), color: frame.secondary }, { text: ' ' }]
          : [{ text: ' '.repeat(cells) }],
      right: view.condition ? pill(view.condition.short, view.condition.color) : [],
      minFill: 2,
    },
    width,
  )
}

// ---------------------------------------------------------------------------
// The /lcars report
// ---------------------------------------------------------------------------

export type ReportExtras = {
  layout: string
  isLayoutOverridden: boolean
  hasStatusLine: boolean
  redAlert: 'followed' | 'absent' | 'ignored'
}

/** The full readout in words, each Starfleet label beside what it stands for. */
export function reportText(view: PanelView, extras: ReportExtras): string {
  const labels = LABELS[view.labels]
  const r = view.readings
  const line = (label: string, meaning: string, value: string) =>
    `${label.padEnd(11)} ${`(${meaning})`.padEnd(20)} ${value}`
  const out = [`${labels.report} · ${labels.reportDate(view.now)} · ${clockTime(view.now)}`, '']
  if (!r) {
    out.push('Sensors are still initializing.')
  } else {
    const warp = warpFactor(r.effort)
    out.push(
      line(labels.helm, 'model, effort', `${modelName(r.model)}${r.effort ? ` · ${r.effort} effort${warp ? ` (${warp.toLowerCase()})` : ''}` : ''}`),
    )
    const ctx = r.context
    out.push(
      line(
        labels.core,
        'context window',
        ctx.percent === null
          ? `no reading yet${ctx.window ? ` · ${tokenCount(ctx.window)} window` : ''}`
          : `${Math.round(ctx.percent)}% used${ctx.tokens !== null && ctx.window ? ` · ${tokenCount(ctx.tokens)} of ${tokenCount(ctx.window)} tokens` : ''}`,
      ),
    )
    const windowLine = (label: string, meaning: string, limit: Readings['fiveHour']) =>
      line(
        label,
        meaning,
        limit
          ? `${Math.max(0, Math.round(100 - limit.used))}% left${limit.resetsAt !== null ? ` · resets in ${spanText(limit.resetsAt - view.now)}` : ''}`
          : 'no reading (shows after the first response on a subscription)',
      )
    out.push(windowLine(labels.fiveHour, '5-hour limit', r.fiveHour))
    out.push(windowLine(labels.sevenDay, '7-day limit', r.sevenDay))
    out.push(line(labels.cost, 'session cost', r.costUsd === null ? 'not tracked' : `$${r.costUsd.toFixed(2)}`))
    out.push(line(labels.sector, 'working directory', homePath(r.cwd, r.home)))
    out.push(line(labels.course, 'git branch', r.branch ?? 'not a git repository'))
    out.push(line(labels.env, 'python env', r.pyenv ?? 'none'))
  }
  const condition =
    extras.redAlert === 'ignored'
      ? 'not followed (followRedAlert is off)'
      : view.condition
        ? view.condition.label.toLowerCase()
        : 'red-alert is not loaded'
  out.push(line(labels.condition, 'red-alert', condition))
  out.push(
    '',
    `Panel: ${extras.layout}${extras.isLayoutOverridden ? ' (this session; /lcars reset follows the setting)' : ''} · terms: ${view.labels} · /lcars bridge | compact | off · /lcars starfleet | plain`,
  )
  if (extras.hasStatusLine) {
    out.push(
      'Note: a statusLine command is also configured, so its own line shows beside this panel. Remove "statusLine" from your settings to let the panel take over.',
    )
  }
  return out.join('\n')
}
