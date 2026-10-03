/** Which panel the mod draws under the prompt. */
export type PanelLayout = 'bridge' | 'compact' | 'off'

/** One rate-limit window, as `$.session.usage()` last reported it. */
export type LimitReading = {
  /** Percent of the window used, 0 to 100 (past 100 on an exceeded spend limit). */
  used: number
  /** When the window resets, in milliseconds since the epoch; null when unknown. */
  resetsAt: number | null
}

/** Everything the panel reads out, refreshed by the mod's timers and turn events. */
export type Readings = {
  /** The main loop's model as /model shows it (`claude-opus-5-5`, `opus`). */
  model: string
  /** `low` … `max`, or null for a model without an effort setting. */
  effort: string | null
  /** The context window's fill; `percent` and `tokens` are null until the first response. */
  context: { percent: number | null; tokens: number | null; window: number | null }
  fiveHour: LimitReading | null
  sevenDay: LimitReading | null
  /** US dollars this session, as /cost totals it. */
  costUsd: number | null
  cwd: string
  home: string
  branch: string | null
  /** The active conda env (not `base`) or virtualenv. */
  pyenv: string | null
  user: string
  host: string
}

/** red-alert's daemon link, as much of it as the panel reads. */
export type RedAlertLink = {
  online: boolean
  /** Milliseconds since the epoch of the last check; 0 before the first. */
  checkedAt: number
  mute: { until: number | null } | null
}

/** The alert red-alert's band is showing, as much of it as the panel reads. */
export type RedAlertActive = {
  id: string
  level: string
  color: string
  style: 'sweep' | 'pulse' | 'klaxon'
  title: string
  /** Milliseconds since the epoch: the band animates at least until then. */
  animateUntil: number
}

declare module 'claude-code' {
  interface PluginState {
    'starfleet-panel': {
      readings: Readings | null
      /** The minute the panel last ticked, in epoch milliseconds: redraws the clock and countdowns. */
      clock: number
      /** The blink phase while a red or yellow alert animates. */
      blink: boolean
      /** A layout picked with /lcars for this session; null follows the setting. */
      layout: PanelLayout | null
    }
    /**
     * red-alert's own values (github.com/dukechain2333/red-alert), read and
     * never written, so the panel follows its alert condition. A subset of its
     * contract; absent (`undefined`) when red-alert is not loaded.
     */
    'red-alert': {
      link: RedAlertLink | null
      active: RedAlertActive | null
    }
  }
}
