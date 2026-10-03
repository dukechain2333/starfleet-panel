// Tests for starfleet-panel. Run: claude plugin test plugin
//
// The session's figures, git, the environment and the settings are answered
// beneath the plugin; red-alert's state is answered by a `state.get` hook, the
// way red-alert holds it. The panel is drawn on the terminal and the desktop,
// so every tree is validated against both element tables.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { widthOf } from '../hooks/lcars'
import { BRIDGE_MIN_WIDTH, bridgeRows, compactRow } from '../hooks/panel'
import type { PanelView } from '../hooks/panel'
import { cellWidth, clip, clipStart, countdown, modelName, stardate, warpFactor } from '../hooks/readouts'
import type { Readings } from '../types'

const PLUGIN = 'starfleet-panel'
const NOW = 1_790_998_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const START = { cwd: '/home/picard/enterprise', surface: 'terminal', isInteractive: true } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 150 } } as const

function hint(columns: number, isWorking = false) {
  return {
    component: 'PromptHint',
    props: { isDraft: false, isWorking, hint: '? for shortcuts' },
    viewport: { columns, rows: 40 },
  } as const
}

type Ship = {
  model?: string
  percent?: number
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
  branch?: string | null
  settings?: Record<string, unknown>
  redAlert?: { link?: unknown; active?: unknown }
}

function ran(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** A session beneath the plugin: its figures, git, settings, and optionally red-alert's state. */
function ship(on: On, options: Ship = {}) {
  const toasts: string[] = []
  const commands: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { USER: 'picard', HOME: '/home/picard', CONDA_DEFAULT_ENV: 'warpcore' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  // the engine's own hint line, which the panel keeps above its rows
  on('ui.render', { component: 'PromptHint' }, ($, e) => ({ type: 'Text', props: { dimColor: true }, children: [e.props.hint] }))
  on('session.cwd', () => ({ value: '/home/picard/enterprise' }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - HOUR,
      context:
        options.percent === undefined
          ? { window: 200_000 }
          : { window: 200_000, percent: options.percent, tokens: options.percent * 2000 },
      rateLimits: options.rateLimits ?? [
        { kind: 'five_hour', percentUsed: 28, resetsAt: new Date(NOW + 2 * HOUR + 14 * MINUTE).toISOString() },
        { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
      ],
      cost: { usd: 1.25 },
    },
  }))
  on('settings.read', () => ({ value: options.settings ?? { effortLevel: 'xhigh' } }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.startsWith('hostname')) return { value: ran('enterprise.local\n') }
    if (argv.includes('symbolic-ref')) {
      return { value: options.branch === null ? ran('', 1) : ran(`${options.branch ?? 'main'}\n`) }
    }
    return { value: ran('', 128) }
  })
  if (options.redAlert) {
    const values = options.redAlert as Record<string, unknown>
    on('state.get', { plugin: 'red-alert' }, ($, e) => ({ value: { value: values[e.key] ?? null, version: 1 } }))
  }
  return { toasts, commands, clock }
}

const RED_ALERT_ONLINE = { online: true, checkedAt: NOW, mute: null }
const RED_ALERT_KLAXON = {
  id: 'a1',
  level: 'red',
  color: '#FF3333',
  style: 'klaxon',
  title: 'RED ALERT',
  animateUntil: NOW + 10_000,
}

describe('the panel under the prompt', () => {
  test('draws the bridge frame with every reading, and no Buttons of its own', async ($, on) => {
    ship(on, { percent: 42 })
    await $.session.start(START)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    const top = await ui.find({ key: 'lcars:row:0' })
    const middle = await ui.find({ key: 'lcars:row:1' })
    const bottom = await ui.find({ key: 'lcars:row:2' })
    expect(top?.text).toMatch(/^▗▄+ ▄+ STARDATE \d{5}\.\d ▄▄▄▄ \d\d:\d\d ▄▄▄▖$/)
    expect(middle?.text).toContain('STANDBY ▌ HELM OPUS 5.5 WARP 9 XHIGH   CORE ▰▰▰▰▱▱▱▱▱▱ 42%')
    expect(middle?.text).toContain('DILITHIUM ▰▰▰▰▱▱ 72% T-2H14M   ANTIMATTER 88% T-3D4H')
    expect(bottom?.text).toContain('SECTOR ~/enterprise ▀▀ COURSE main ▀▀ ENV warpcore ▀▀ picard@enterprise')
    // red-alert is not loaded: the bar ends in an elbow, not a condition pill
    expect(bottom?.text).toMatch(/ ▀▀▀▘$/)
    // the engine's hint line stays, above the frame
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    // red-alert's `0` and its band items stay its own: the panel has nothing to press
    expect(await ui.findAll({ type: 'Button' })).toEqual([])
    await ui.unmount()
  })

  test('shows ENGAGED while Claude works', async ($, on) => {
    ship(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150, true) })
    expect((await ui.find({ key: 'lcars:row:1' }))?.text).toMatch(/^ +ENGAGED ▌/)
    await ui.unmount()
  })

  test('is one row on the desktop and on a narrow terminal', async ($, on) => {
    ship(on, { percent: 42 })
    await $.session.start(START)
    for (const [surface, columns] of [['desktop', 150], ['terminal', 60]] as const) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...hint(columns) })
      const row = await ui.find({ key: 'lcars:row:0' })
      expect(row?.text).toContain('STANDBY')
      expect(row?.text).toContain('CORE 42%')
      expect(row?.text).not.toContain('STARDATE')
      expect(await ui.find({ key: 'lcars:row:1' })).toBeUndefined()
      expect(await ui.findAll({ type: 'Button' })).toEqual([])
      await ui.unmount()
    }
  })

  test('takes the effort a model is set to in settings', async ($, on) => {
    ship(on, { settings: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } } } })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:1' }))?.text).toContain('HELM OPUS 5.5 WARP 9.6 MAX')
    await ui.unmount()
  })

  test('leaves out what the session has no reading for', async ($, on) => {
    ship(on, { rateLimits: [], branch: null })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    const middle = (await ui.find({ key: 'lcars:row:1' }))?.text ?? ''
    expect(middle).toContain('CORE ▱▱▱▱▱▱▱▱▱▱ --')
    expect(middle).not.toContain('DILITHIUM')
    expect((await ui.find({ key: 'lcars:row:2' }))?.text).not.toContain('COURSE')
    await ui.unmount()
  })

  test('keeps reading after a /clear, which ends the conversation but not the session', async ($, on) => {
    const options: Ship = { percent: 42 }
    const { clock } = ship(on, options)
    await $.session.start(START)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    options.percent = 7
    await clock.advance(2000)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:1' }))?.text).toContain('CORE ▰▱▱▱▱▱▱▱▱▱ 7%')
    await ui.unmount()
  })

  test('asks once to retire a statusLine command it would duplicate', async ($, on) => {
    const { toasts, commands } = ship(on, { settings: { statusLine: { type: 'command', command: 'x' } } })
    await $.session.start(START)
    await $.session.start(START)
    expect(commands).toContain('lcars')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('Remove "statusLine" from settings')
  })
})

describe('with red-alert', () => {
  test('shows CONDITION GREEN while red-alert is online', async ($, on) => {
    ship(on, { redAlert: { link: RED_ALERT_ONLINE, active: null } })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:2' }))?.text).toMatch(/▐ CONDITION GREEN ▌$/)
    await ui.unmount()
  })

  test('says so when red-alert is offline or muted', async ($, on) => {
    ship(on, { redAlert: { link: { online: true, checkedAt: NOW, mute: { until: null } }, active: null } })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:2' }))?.text).toMatch(/▐ GREEN · MUTED ▌$/)
    await ui.unmount()
  })

  test('repaints the frame in the alert color and blinks while the klaxon animates', async ($, on) => {
    const { clock } = ship(on, { redAlert: { link: RED_ALERT_ONLINE, active: RED_ALERT_KLAXON } })
    await $.session.start(START)

    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:1' }))?.text).toMatch(/^ +RED ALERT ▌/)
    expect((await ui.find({ key: 'lcars:row:2' }))?.text).toMatch(/▐ RED ALERT ▌$/)
    const lit = await ui.find({ type: 'Text', text: /RED ALERT $/ })
    expect(lit?.props.backgroundColor).toBe('#FF3333')
    expect(lit?.props.color).toBe('#000000')
    const elbow = await ui.find({ type: 'Text', text: /^▗▄+$/ })
    expect(elbow?.props.color).toBe('#FF3333')
    await ui.unmount()

    await clock.advance(500)
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    const dark = await ui.find({ type: 'Text', text: /RED ALERT $/ })
    expect(dark?.props.color).toBe('#FF3333')
    expect(dark?.props.backgroundColor).not.toBe('#FF3333')
    await ui.unmount()

    // the animation is over: the frame stays red, steady, until red-alert clears it
    await clock.advance(12_000)
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    const steady = await ui.find({ type: 'Text', text: /RED ALERT $/ })
    expect(steady?.props.backgroundColor).toBe('#FF3333')
    await ui.unmount()
  })

  test('is left alone when followRedAlert is off', { options: { followRedAlert: false } }, async ($, on) => {
    ship(on, { redAlert: { link: RED_ALERT_ONLINE, active: RED_ALERT_KLAXON } })
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect((await ui.find({ key: 'lcars:row:1' }))?.text).toMatch(/^ +STANDBY ▌/)
    expect((await ui.find({ key: 'lcars:row:2' }))?.text).toMatch(/ ▀▀▀▘$/)
    await ui.unmount()
  })
})

describe('/lcars', () => {
  test('reports every reading beside what its label stands for', async ($, on) => {
    ship(on, { percent: 42, redAlert: { link: RED_ALERT_ONLINE, active: null } })
    await $.session.start(START)
    const { text } = await $.command.run({ command: 'lcars', args: '', ...TYPED })
    expect(text).toContain('LCARS STATUS REPORT · STARDATE')
    expect(text).toContain('HELM        (model, effort)      OPUS 5.5 · xhigh effort (warp 9)')
    expect(text).toContain('CORE        (context window)     42% used · 84K of 200K tokens')
    expect(text).toContain('DILITHIUM   (5-hour limit)       72% left · resets in 2h14m')
    expect(text).toContain('ANTIMATTER  (7-day limit)        88% left · resets in 3d4h')
    expect(text).toContain('COURSE      (git branch)         main')
    expect(text).toContain('CONDITION   (red-alert)          condition green')
  })

  test('switches the layout for the session, and back', async ($, on) => {
    ship(on)
    await $.session.start(START)

    expect((await $.command.run({ command: 'lcars', args: 'compact', ...TYPED })).text).toContain('compact')
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect(await ui.find({ key: 'lcars:row:0' })).toBeDefined()
    expect(await ui.find({ key: 'lcars:row:1' })).toBeUndefined()
    await ui.unmount()

    await $.command.run({ command: 'lcars', args: 'off', ...TYPED })
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect(await ui.find({ key: 'lcars:row:0' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
    await ui.unmount()

    await $.command.run({ command: 'lcars', args: 'reset', ...TYPED })
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...hint(150) })
    expect(await ui.find({ key: 'lcars:row:2' })).toBeDefined()
    await ui.unmount()

    expect((await $.command.run({ command: 'lcars', args: 'warp 10', ...TYPED })).text).toContain('Usage: /lcars')
  })
})

// ---------------------------------------------------------------------------
// Pure readouts and layout
// ---------------------------------------------------------------------------

const READINGS: Readings = {
  model: 'claude-opus-5-5',
  effort: 'xhigh',
  context: { percent: 42, tokens: 84_000, window: 200_000 },
  fiveHour: { used: 28, resetsAt: NOW + 2 * HOUR },
  sevenDay: { used: 12, resetsAt: NOW + 76 * HOUR },
  costUsd: 1.25,
  cwd: '/home/picard/星舰/enterprise-d',
  home: '/home/picard',
  branch: 'feature/saucer-separation',
  pyenv: 'warpcore',
  user: 'picard',
  host: 'enterprise',
}

function view(overrides: Partial<PanelView> = {}): PanelView {
  return {
    readings: READINGS,
    now: NOW,
    isWorking: false,
    labels: 'starfleet',
    showCost: true,
    showUserHost: true,
    alert: null,
    isBlinkDark: false,
    condition: { label: 'CONDITION GREEN', color: '#66DD99' },
    ...overrides,
  }
}

describe('readouts', () => {
  test('model names', () => {
    expect(modelName('claude-opus-5-5')).toBe('OPUS 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('HAIKU 4.5')
    expect(modelName('claude-sonnet-4-20250514')).toBe('SONNET 4')
    expect(modelName('claude-3-5-sonnet-20241022')).toBe('SONNET 3.5')
    expect(modelName('opus[1m]')).toBe('OPUS 1M')
    expect(modelName('Fable 5.1')).toBe('FABLE 5.1')
  })

  test('effort as a warp factor', () => {
    expect(warpFactor('low')).toBe('IMPULSE')
    expect(warpFactor('xhigh')).toBe('WARP 9')
    expect(warpFactor('max')).toBe('WARP 9.6')
    expect(warpFactor(null)).toBeNull()
  })

  test('stardates and countdowns', () => {
    expect(stardate(NOW)).toMatch(/^80\d{3}\.\d$/)
    expect(Number(stardate(NOW + 24 * HOUR))).toBeGreaterThan(Number(stardate(NOW)))
    expect(countdown(2 * HOUR + 14 * MINUTE)).toBe('T-2H14M')
    expect(countdown(76 * HOUR)).toBe('T-3D4H')
    expect(countdown(45 * MINUTE)).toBe('T-45M')
    expect(countdown(-5)).toBe('T-0M')
  })

  test('terminal cell widths', () => {
    expect(cellWidth('星舰')).toBe(4)
    expect(cellWidth('LCARS')).toBe(5)
    expect(clip('ENTERPRISE', 6)).toBe('ENTER…')
    expect(clipStart('~/星舰/enterprise', 9)).toBe('…terprise')
  })
})

describe('layout', () => {
  test('every row fills the width exactly, at any width', () => {
    for (const width of [BRIDGE_MIN_WIDTH, 80, 101, 146, 220]) {
      for (const overrides of [{}, { alert: { title: 'RED ALERT', level: 'red', color: '#FF3333' } }, { readings: null }]) {
        for (const row of bridgeRows(view(overrides), width)) expect(widthOf(row)).toBe(width)
      }
    }
    for (const width of [24, 40, 56, 100, 146]) {
      expect(widthOf(compactRow(view(), width))).toBe(width)
    }
  })

  test('drops the gauges before any reading', () => {
    const middle = bridgeRows(view({ showCost: false }), 76)[1] ?? []
    const text = middle.map(piece => piece.text).join('')
    expect(text).toContain('ANTIMATTER 88%')
    expect(text).not.toContain('▰')
  })

  test('plain labels', () => {
    const [, middle, bottom] = bridgeRows(view({ labels: 'plain' }), 200).map(row => row.map(piece => piece.text).join(''))
    expect(middle).toContain('IDLE ▌ MODEL OPUS 5.5 XHIGH   CTX ▰▰▰▰▱▱▱▱▱▱ 42%   5H ▰▰▰▰▱▱ 72% T-2H   7D 88% T-3D4H   COST $1.25')
    expect(bottom).toContain('DIR ~/星舰/enterprise-d ▀▀ GIT feature/saucer-separation ▀▀ ENV warpcore')
  })
})
