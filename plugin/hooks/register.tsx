// starfleet-panel: an LCARS status panel under the Claude Code prompt.
//
// - draws the panel at the prompt's hint line (`PromptHint`), under the
//   engine's own line (the mode pill and hints), which it keeps: the model
//   and effort (as a warp factor), the context window, the 5-hour and 7-day
//   limits, the directory, git branch and Python env, and the stardate;
// - follows red-alert (github.com/dukechain2333/red-alert) when it is loaded:
//   reads its state, never writes it, and repaints the frame in the alert's
//   color while red-alert's band shows one;
// - answers /lcars with a full report, or switches the layout.
//
// Sharing a session with red-alert: red-alert owns the band above the prompt
// (`AbovePrompt`), its pane, its tool, /alert and its status entry; this mod
// draws only under the prompt, adds no Buttons or hotkeys (red-alert's `0`
// stays its own), no tool and no system-prompt text.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { PanelLayout, Readings, RedAlertActive, RedAlertLink } from '../types'
import { LCARS } from './lcars'
import type { Piece } from './lcars'
import { BRIDGE_MIN_WIDTH, bridgeRows, compactRow, reportText } from './panel'
import type { Condition, LabelSet, PanelView } from './panel'

const COMMAND = 'lcars'
const USAGE = 'Usage: /lcars [report | bridge | compact | off | reset]'
/** Cells the prompt footer keeps at its edges: two on each side. */
const MARGIN = 4
const SLOW_MS = 30_000
const BLINK_MS = 500
const NOTICE_KEY = 'statusLineNoticeShown'

const readings = atom({ plugin: 'starfleet-panel', key: 'readings' } as const, null)
const clock = atom({ plugin: 'starfleet-panel', key: 'clock' } as const, 0)
const blink = atom({ plugin: 'starfleet-panel', key: 'blink' } as const, false)
const layoutOverride = atom({ plugin: 'starfleet-panel', key: 'layout' } as const, null)

// red-alert's values: read only.
const RED_ALERT_LINK = { plugin: 'red-alert', key: 'link' } as const
const RED_ALERT_ACTIVE = { plugin: 'red-alert', key: 'active' } as const

type Settings = {
  layout: PanelLayout
  labels: LabelSet
  showCost: boolean
  showUserHost: boolean
  followRedAlert: boolean
  refreshMs: number
}

/** What changes rarely: read at the start, after each turn and every 30 s. */
type Surroundings = {
  cwd: string
  home: string
  branch: string | null
  pyenv: string | null
  user: string
  host: string
  settingsEffort: (model: string) => string | null
}

// The module's own variables: they start over when the module reloads, while
// everything drawn from lives in $.state.
let settings: Settings = settingsFrom({})
let surroundings: Surroundings | null = null
let host: string | null = null
let hasStatusLine = false
/** The effort the main loop's last model request was sent with; undefined before the first. */
let stepEffort: string | null | undefined
let isRefreshing = false
let fastTimer: Timer | undefined
let slowTimer: Timer | undefined
let blinkTimer: Timer | undefined

function settingsFrom(options: PluginOptions): Settings {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = String(options[key] ?? '').trim().toLowerCase()
    return (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  }
  const seconds = Number(options.refreshSeconds)
  return {
    layout: pick('layout', ['bridge', 'compact', 'off'] as const, 'bridge'),
    labels: pick('labels', ['starfleet', 'plain'] as const, 'starfleet'),
    showCost: options.showCost === true,
    showUserHost: options.showUserHost !== false,
    followRedAlert: options.followRedAlert !== false,
    refreshMs: Math.round((Number.isFinite(seconds) && seconds >= 1 ? seconds : 2) * 1000),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

async function gitBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const ref = await $.process.run(['git', '--no-optional-locks', 'symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd,
      timeoutMs: 3000,
    })
    if (ref.exitCode === 0 && ref.stdout.trim()) return ref.stdout.trim()
    const head = await $.process.run(['git', '--no-optional-locks', 'rev-parse', '--short', 'HEAD'], {
      cwd,
      timeoutMs: 3000,
    })
    return head.exitCode === 0 && head.stdout.trim() ? `@${head.stdout.trim()}` : null
  } catch {
    return null
  }
}

async function hostName($: EngineInterface): Promise<string> {
  if (host !== null) return host
  try {
    const run = await $.process.run(['hostname'], { timeoutMs: 3000 })
    host = run.exitCode === 0 ? (run.stdout.trim().split('.')[0] ?? '') : ''
  } catch {
    host = ''
  }
  return host
}

async function pythonEnv($: EngineInterface): Promise<string | null> {
  const conda = await $.env.get('CONDA_DEFAULT_ENV')
  if (conda && conda !== 'base') return conda
  const venv = await $.env.get('VIRTUAL_ENV')
  return venv ? (venv.split('/').filter(Boolean).pop() ?? null) : null
}

/** The effort settings give a model: its own `modelSettings` entry, else `effortLevel`. */
function effortFromSettings(merged: Readonly<Record<string, unknown>>): (model: string) => string | null {
  const perModel = merged.modelSettings
  const global = typeof merged.effortLevel === 'string' ? merged.effortLevel : null
  return model => {
    if (perModel && typeof perModel === 'object') {
      const entry = (perModel as Record<string, unknown>)[model]
      if (entry && typeof entry === 'object') {
        const level = (entry as Record<string, unknown>).effortLevel
        if (typeof level === 'string') return level
      }
    }
    return global
  }
}

async function readSurroundings($: EngineInterface): Promise<Surroundings> {
  const cwd = await $.session.cwd()
  const [branch, pyenv, user, home, name, merged] = await Promise.all([
    gitBranch($, cwd),
    pythonEnv($),
    $.env.get('USER'),
    $.env.get('HOME'),
    hostName($),
    $.settings.read().catch(() => ({}) as Readonly<Record<string, unknown>>),
  ])
  hasStatusLine = merged.statusLine !== undefined && merged.statusLine !== null
  return {
    cwd,
    home: home ?? '',
    branch,
    pyenv,
    user: user ?? '',
    host: name,
    settingsEffort: effortFromSettings(merged),
  }
}

function toLimit(limit: { percentUsed: number; resetsAt?: string } | undefined): Readings['fiveHour'] {
  if (!limit) return null
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return { used: limit.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

/** Reads every sensor; with `isSlow`, the directory, branch, env and settings too. */
async function refresh($: EngineInterface, isSlow: boolean): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    if (isSlow || surroundings === null) surroundings = await readSurroundings($)
    const near = surroundings
    const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
    const limits = usage.rateLimits
    const fresh: Readings = {
      model,
      effort: stepEffort !== undefined ? stepEffort : near.settingsEffort(model),
      context: {
        percent: usage.context.percent ?? null,
        tokens: usage.context.tokens ?? null,
        window: usage.context.window || null,
      },
      fiveHour: toLimit(limits.find(limit => limit.kind === 'five_hour')),
      sevenDay: toLimit(limits.find(limit => limit.kind === 'seven_day')),
      costUsd: usage.cost?.usd ?? null,
      cwd: near.cwd,
      home: near.home,
      branch: near.branch,
      pyenv: near.pyenv,
      user: near.user,
      host: near.host,
    }
    const current = await read($, readings)
    if (JSON.stringify(current) !== JSON.stringify(fresh)) {
      await update($, readings, () => fresh)
    }
    const minute = Math.floor((await $.clock.now()) / 60_000) * 60_000
    if (minute !== (await read($, clock))) {
      await update($, clock, () => minute)
    }
    await syncBlink($)
  } catch (error) {
    $.ui.log(`starfleet-panel: sensor sweep failed: ${errorText(error)}`, { to: 'debug' })
  } finally {
    isRefreshing = false
  }
}

// ---------------------------------------------------------------------------
// red-alert, read only
// ---------------------------------------------------------------------------

async function redAlertLink($: EngineInterface): Promise<RedAlertLink | null> {
  if (!settings.followRedAlert) return null
  try {
    return (await $.state.get(RED_ALERT_LINK)).value ?? null
  } catch {
    return null
  }
}

async function redAlertActive($: EngineInterface): Promise<RedAlertActive | null> {
  if (!settings.followRedAlert) return null
  try {
    return (await $.state.get(RED_ALERT_ACTIVE)).value ?? null
  } catch {
    return null
  }
}

function alertTitle(active: RedAlertActive): string {
  return active.title || `${active.level.toUpperCase()} ALERT`
}

function conditionOf(link: RedAlertLink | null, active: RedAlertActive | null): Condition | null {
  if (active) return { label: alertTitle(active), color: active.color }
  if (!link) return null
  if (link.checkedAt === 0) return { label: 'LINKING', color: LCARS.tan }
  if (!link.online) return { label: 'ALERTS OFFLINE', color: LCARS.red }
  if (link.mute) return { label: 'GREEN · MUTED', color: LCARS.peach }
  return { label: 'CONDITION GREEN', color: LCARS.green }
}

/** Blinks the sidebar while red-alert animates a red or yellow alert, as every console on the ship does. */
async function syncBlink($: EngineInterface): Promise<void> {
  const active = await redAlertActive($)
  const now = await $.clock.now()
  const isBlinking = active !== null && active.style !== 'sweep' && now < active.animateUntil
  if (isBlinking) {
    blinkTimer ??= $.clock.every(BLINK_MS, () => void update($, blink, phase => !phase))
    return
  }
  blinkTimer?.cancel()
  blinkTimer = undefined
  // the phase outlives a reload, the timer does not: never leave it dark
  if (await read($, blink)) await update($, blink, () => false)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

async function viewOf($: EngineInterface, isWorking: boolean): Promise<PanelView> {
  const [values, , isDark, link, active, now] = await Promise.all([
    read($, readings),
    read($, clock),
    read($, blink),
    redAlertLink($),
    redAlertActive($),
    $.clock.now(),
  ])
  return {
    readings: values,
    now,
    isWorking,
    labels: settings.labels,
    showCost: settings.showCost,
    showUserHost: settings.showUserHost,
    alert: active ? { title: alertTitle(active), level: active.level, color: active.color } : null,
    isBlinkDark: isDark,
    condition: conditionOf(link, active),
  }
}

/** A piece's style as Text props, leaving out what it does not set. */
function textProps(piece: Piece): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {}
  if (piece.color) props.color = piece.color
  if (piece.backgroundColor) props.backgroundColor = piece.backgroundColor
  if (piece.bold) props.bold = true
  if (piece.dimColor) props.dimColor = true
  return props
}

async function report($: EngineInterface): Promise<string> {
  await refresh($, true)
  const [override, merged] = await Promise.all([read($, layoutOverride), $.settings.read().catch(() => ({}))])
  return reportText(await viewOf($, false), {
    layout: override ?? settings.layout,
    isLayoutOverridden: override !== null,
    hasStatusLine: 'statusLine' in merged && merged.statusLine !== null,
    redAlert: !settings.followRedAlert ? 'ignored' : (await redAlertLink($)) ? 'followed' : 'absent',
  })
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'LCARS status report, or switch the status panel layout',
      argumentHint: '[report | bridge | compact | off | reset]',
      immediate: true,
    })
    await Promise.race([refresh($, true), $.clock.sleep(1500)])
    fastTimer?.cancel()
    slowTimer?.cancel()
    fastTimer = $.clock.every(settings.refreshMs, () => void refresh($, false))
    slowTimer = $.clock.every(SLOW_MS, () => void refresh($, true))
    if (hasStatusLine && (await $.store.get(NOTICE_KEY)) !== true) {
      $.ui.toast(
        'starfleet-panel: your statusLine command still draws its own line. Remove "statusLine" from settings to let the LCARS panel take over (/lcars has the details).',
        { timeoutMs: 9000 },
      )
      await $.store.set(NOTICE_KEY, true)
    }
    return next(e)
  })

  // A /clear ends the conversation but not the process, and no session.start
  // follows it: the timers run on, and the next sweep reads the fresh figures.
  on('session.end', ($, e, next) => {
    if (e.reason !== 'clear') {
      fastTimer?.cancel()
      slowTimer?.cancel()
      blinkTimer?.cancel()
    }
    return next(e)
  })

  // The effort each main-loop request is really sent with, after any downgrade
  // for the model; observed only, the stream passes through untouched.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      stepEffort = e.effort === undefined ? null : String(e.effort)
      void refresh($, false)
    }
    return result
  })

  // Claude may have switched branches or directories during the turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($, true)
    return result
  })

  // Starts the blink the moment red-alert raises an alert. Observe only: the
  // value passes through as red-alert wrote it.
  on('state.set', { plugin: 'red-alert', key: 'active' }, async ($, e, next) => {
    const result = await next(e)
    void syncBlink($).catch(() => null)
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    switch (word) {
      case '':
      case 'report':
      case 'status':
        return { text: await report($) }
      case 'bridge':
      case 'compact':
      case 'off':
        await update($, layoutOverride, () => word)
        return { text: `LCARS panel: ${word}, for this session. The default is starfleet-panel's "Panel layout" in /config.` }
      case 'reset':
      case 'auto':
        await update($, layoutOverride, () => null)
        return { text: `LCARS panel follows the setting again: ${settings.layout}.` }
      default:
        return { text: USAGE }
    }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const layout = (await read($, layoutOverride)) ?? settings.layout
    if (layout === 'off') return next(e)
    const [hint, view] = await Promise.all([next(e), viewOf($, e.props.isWorking)])
    // With the engine's own line in the tree, the engine draws that line (the
    // mode pill, the hints) first and gives the rows below it the full width.
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(24, (e.viewport?.columns ?? 100) - MARGIN)
    const rows =
      e.surface === 'terminal' && layout === 'bridge' && width >= BRIDGE_MIN_WIDTH
        ? bridgeRows(view, width)
        : [compactRow(view, width)]
    return (
      <Box flexDirection="column">
        {hint}
        {rows.map((row, i) => (
          <Box key={`lcars:row:${i}`} flexDirection="row">
            {row.map(piece => (
              <Text {...textProps(piece)} wrap="truncate">{piece.text}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
