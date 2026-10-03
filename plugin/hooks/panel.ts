// The panel: what the readings look like as LCARS rows, and as the /lcars
// report. Pure functions of a PanelView, so the tests can check each layout
// at any width without a session.

import type { Readings } from '../types'
import { LCARS, STANDARD_FRAME, alertFrame, fitRow, mix, pill } from './lcars'
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
  spanText,
  stardate,
  tokenCount,
  warpFactor,
} from './readouts'

export type LabelSet = 'starfleet' | 'plain'

/** The condition pill at the panel's end: red-alert's state, in its color. */
export type Condition = { label: string; color: string }

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
    idle: 'STANDBY',
    working: 'ENGAGED',
  },
  plain: {
    helm: 'MODEL',
    core: 'CTX',
    fiveHour: '5H',
    sevenDay: '7D',
    cost: 'COST',
    sector: 'DIR',
    course: 'GIT',
    env: 'ENV',
    idle: 'IDLE',
    working: 'WORKING',
  },
} as const

type Labels = (typeof LABELS)[LabelSet]

/** Width of the frame's sidebar, in cells: fits `RED ALERT` and `ENGAGED` with a margin. */
export const SIDEBAR = 11
/** Below this width the bridge frame gives way to the one-row strip. */
export const BRIDGE_MIN_WIDTH = 72

/** Calm, caution, danger: the thresholds of the status line this panel replaces. */
export function levelColor(percentUsed: number): string {
  if (percentUsed >= 80) return LCARS.red
  if (percentUsed >= 60) return LCARS.yellow
  return LCARS.blue
}

function frameOf(view: PanelView): Frame {
  return view.alert ? alertFrame(view.alert.color) : STANDARD_FRAME
}

function sidebarLabel(view: PanelView, labels: Labels, room: number): string {
  if (view.alert) {
    const title = view.alert.title.toUpperCase()
    return clip(cellWidth(title) <= room ? title : view.alert.level.toUpperCase(), room)
  }
  return clip(view.isWorking ? labels.working : labels.idle, room)
}

/** The sidebar's colors: ink on the frame color, inverted on the dark half of a blink. */
function sidebarStyle(view: PanelView, frame: Frame): Omit<Piece, 'text'> {
  return view.alert && view.isBlinkDark
    ? { color: frame.primary, backgroundColor: mix(frame.primary, LCARS.ink, 0.75), bold: true }
    : { color: LCARS.ink, backgroundColor: frame.primary, bold: true }
}

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

/**
 * A labelled reading as three items: the label, an optional gauge, the value.
 * The gauge has a priority of its own, so a narrow panel drops the gauges
 * before it drops a reading.
 */
function reading(
  gap: Piece,
  label: string,
  value: Piece,
  frame: Frame,
  priority: number,
  meter: { percent: number; cells: number; priority: number } | null,
): Item[] {
  const items: Item[] = [{ priority, group: label, pieces: [gap, { text: `${label} `, color: frame.label }] }]
  if (meter && meter.cells > 0) {
    const g = gauge(meter.percent, meter.cells)
    const color = value.color ?? frame.label
    items.push({
      priority: meter.priority,
      pieces: [{ text: g.lit, color }, { text: g.dark, color: mix(color, LCARS.ink, 0.6) }, { text: ' ' }],
    })
  }
  items.push({ priority, group: label, pieces: [value] })
  return items
}

/** The readings as droppable items: model and effort, context, the rate-limit windows, cost. */
function readoutItems(view: PanelView, labels: Labels, frame: Frame, isCompact: boolean): Item[] {
  const r = view.readings
  if (!r) return [{ priority: 10, pieces: [{ text: 'SENSORS INITIALIZING', color: frame.label }] }]
  const gap = { text: isCompact ? '  ' : '   ' }
  const items: Item[] = []

  items.push({
    priority: 10,
    pieces: [
      ...(isCompact ? [] : [{ text: `${labels.helm} `, color: frame.label }]),
      { text: modelName(r.model), color: LCARS.blue, bold: true },
    ],
  })
  const warp = warpFactor(r.effort)
  if (r.effort !== null && warp !== null) {
    if (view.labels === 'starfleet') {
      items.push({ priority: 5, pieces: [{ text: ' ' }, { text: warp, color: LCARS.peach, bold: true }] })
      if (!isCompact) {
        items.push({ priority: 1, pieces: [{ text: ' ' }, { text: r.effort.toUpperCase(), color: frame.label }] })
      }
    } else {
      items.push({ priority: 5, pieces: [{ text: ' ' }, { text: r.effort.toUpperCase(), color: LCARS.peach, bold: true }] })
    }
  }

  // Dropped first to last as room runs out: the 7-day reset, the effort word,
  // the gauges, the 5-hour reset, the warp factor, then the readings themselves.
  const ctx = r.context.percent
  const ctxColor = ctx === null ? frame.label : levelColor(ctx)
  items.push(
    ...reading(
      gap,
      labels.core,
      { text: ctx === null ? '--' : `${Math.round(ctx)}%`, color: ctxColor, bold: true },
      frame,
      9,
      isCompact ? null : { percent: ctx ?? 0, cells: 10, priority: 2.5 },
    ),
  )

  const windows = [
    { limit: r.fiveHour, label: labels.fiveHour, priority: 8, resetPriority: 3, cells: 6 },
    { limit: r.sevenDay, label: labels.sevenDay, priority: 7, resetPriority: 0, cells: 0 },
  ]
  for (const w of windows) {
    if (!w.limit) continue
    const left = Math.max(0, Math.round(100 - w.limit.used))
    items.push(
      ...reading(
        gap,
        w.label,
        { text: `${left}%`, color: levelColor(w.limit.used), bold: true },
        frame,
        w.priority,
        isCompact ? null : { percent: left, cells: w.cells, priority: 2 },
      ),
    )
    if (w.limit.resetsAt !== null && !isCompact) {
      items.push({
        priority: w.resetPriority,
        pieces: [{ text: ' ' }, { text: countdown(w.limit.resetsAt - view.now), color: frame.label }],
      })
    }
  }

  if (view.showCost && r.costUsd !== null) {
    items.push({
      priority: 0,
      pieces: [gap, { text: `${labels.cost} `, color: frame.label }, { text: `$${r.costUsd.toFixed(2)}`, color: LCARS.sand }],
    })
  }
  return items
}

/** Where the ship is: directory, branch, Python env, user@host, between bar segments. */
function navItems(view: PanelView, labels: Labels, frame: Frame): Item[] {
  const r = view.readings
  if (!r) return []
  const items: Item[] = [
    {
      priority: 9,
      pieces: [
        { text: ' ' },
        { text: `${labels.sector} `, color: frame.label },
        { text: clipStart(homePath(r.cwd, r.home), 40), color: LCARS.sand, bold: true },
        { text: ' ' },
      ],
    },
  ]
  if (r.branch) {
    items.push({
      priority: 8,
      pieces: [
        { text: '▀▀', color: frame.accent },
        { text: ' ' },
        { text: `${labels.course} `, color: frame.label },
        { text: clip(r.branch, 32), color: LCARS.violet, bold: true },
        { text: ' ' },
      ],
    })
  }
  if (r.pyenv) {
    items.push({
      priority: 6,
      pieces: [
        { text: '▀▀', color: frame.secondary },
        { text: ' ' },
        { text: `${labels.env} `, color: frame.label },
        { text: clip(r.pyenv, 20), color: LCARS.peach, bold: true },
        { text: ' ' },
      ],
    })
  }
  if (view.showUserHost && r.user) {
    items.push({
      priority: 4,
      pieces: [
        { text: '▀▀', color: frame.accent },
        { text: ' ' },
        { text: clip(r.host ? `${r.user}@${r.host}` : r.user, 32), color: frame.label },
        { text: ' ' },
      ],
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

/**
 * The bridge layout: a three-row LCARS frame. An elbow bar with the stardate
 * on top, the sidebar and the readouts in the middle, an elbow bar with the
 * ship's position and red-alert's condition below.
 *
 *   ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ STARDATE 80753.2 ▄▄▄▄ 22:15 ▄▄▄▖
 *       STANDBY ▌ HELM OPUS 5.5 WARP 9 XHIGH   CORE ▰▰▰▰▱▱▱▱▱▱ 42%   …
 *   ▝▀▀▀▀▀▀▀▀▀▀▀ SECTOR ~/app ▀▀ COURSE main ▀▀▀▀▀▀▀▀▀▀ ▐ CONDITION GREEN ▌
 */
export function bridgeRows(view: PanelView, width: number): Piece[][] {
  const frame = frameOf(view)
  const labels = LABELS[view.labels]

  const top = fitRow(
    {
      left: [
        { text: '▗', color: frame.primary },
        { text: '▄'.repeat(SIDEBAR + 4), color: frame.primary },
        { text: ' ' },
      ],
      items: [
        {
          priority: 3,
          pieces: [
            { text: ' ' },
            { text: 'STARDATE ', color: frame.label },
            { text: stardate(view.now), color: LCARS.sand, bold: true },
            { text: ' ' },
          ],
        },
        { priority: 1, pieces: [{ text: '▄▄▄▄', color: frame.accent }] },
        { priority: 2, pieces: [{ text: ' ' }, { text: clockTime(view.now), color: LCARS.sand }, { text: ' ' }] },
      ],
      fillAt: 0,
      fill: cells => [{ text: '▄'.repeat(cells), color: frame.secondary }],
      right: [{ text: '▄▄▄▖', color: frame.primary }],
      minFill: 4,
    },
    width,
  )

  const middle = fitRow(
    {
      left: [
        { text: `${sidebarLabel(view, labels, SIDEBAR - 2).padStart(SIDEBAR - 1)} `, ...sidebarStyle(view, frame) },
        { text: '▌', color: frame.primary },
        { text: ' ' },
      ],
      items: readoutItems(view, labels, frame, false),
      fillAt: Number.POSITIVE_INFINITY,
      fill: cells => [{ text: ' '.repeat(cells) }],
      right: [],
    },
    width,
  )

  const nav = navItems(view, labels, frame)
  const bottom = fitRow(
    {
      left: [
        { text: '▝', color: frame.primary },
        { text: '▀'.repeat(SIDEBAR + 1), color: frame.primary },
      ],
      items: nav,
      fillAt: nav.length,
      fill: cells => [{ text: '▀'.repeat(cells), color: frame.secondary }],
      right: view.condition
        ? [{ text: ' ' }, ...pill(view.condition.label, view.condition.color)]
        : [{ text: ' ' }, { text: '▀▀▀▘', color: frame.primary }],
      minFill: 3,
    },
    width,
  )

  return [top, middle, bottom]
}

/**
 * The compact layout: one row, as red-alert's idle strip is drawn.
 *
 *   ▐ STANDBY ▌ OPUS 5.5 WARP 9  CORE 42%  DILITHIUM 72%  COURSE main ━━━━━━━ ▐ GREEN ▌
 */
export function compactRow(view: PanelView, width: number): Piece[] {
  const frame = frameOf(view)
  const labels = LABELS[view.labels]
  const style = sidebarStyle(view, frame)
  const items = readoutItems(view, labels, frame, true)
  const r = view.readings
  if (r?.branch) {
    items.push({
      priority: 4,
      pieces: [{ text: '  ' }, { text: `${labels.course} `, color: frame.label }, { text: clip(r.branch, 24), color: LCARS.violet, bold: true }],
    })
  }
  return fitRow(
    {
      left: [
        { text: '▐', color: style.backgroundColor },
        { text: ` ${sidebarLabel(view, labels, SIDEBAR - 2)} `, ...style },
        { text: '▌', color: style.backgroundColor },
        { text: ' ' },
      ],
      items,
      fillAt: items.length,
      fill: cells =>
        cells >= 3
          ? [{ text: ' ' }, { text: '━'.repeat(cells - 2), color: frame.secondary }, { text: ' ' }]
          : [{ text: ' '.repeat(cells) }],
      right: view.condition ? pill(view.condition.label.replace(/^CONDITION /, ''), view.condition.color) : [],
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
  const out = [`LCARS STATUS REPORT · STARDATE ${stardate(view.now)} · ${clockTime(view.now)}`, '']
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
  out.push(line('CONDITION', 'red-alert', condition))
  out.push(
    '',
    `Panel: ${extras.layout}${extras.isLayoutOverridden ? ' (this session; /lcars reset follows the setting)' : ''} · labels: ${view.labels} · /lcars bridge | compact | off`,
  )
  if (extras.hasStatusLine) {
    out.push(
      'Note: a statusLine command is also configured, so its own line shows beside this panel. Remove "statusLine" from your settings to let the panel take over.',
    )
  }
  return out.join('\n')
}
