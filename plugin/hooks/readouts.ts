// Readouts: pure conversions from what the session reports to what the panel
// prints. No `$` here, so every function is a plain value in, value out.

/** Reasoning effort as a warp factor: the harder Claude thinks, the faster the ship. */
const WARP: Record<string, string> = {
  low: 'IMPULSE',
  medium: 'WARP 5',
  high: 'WARP 7',
  xhigh: 'WARP 9',
  max: 'WARP 9.6',
}

/** `claude-opus-5-5` → `OPUS 5.5`; `opus[1m]` → `OPUS 1M`; `Sonnet 4.5` → `SONNET 4.5`. */
export function modelName(model: string): string {
  const raw = model.trim()
  if (!raw) return 'NO MODEL'
  const isLong = /\[1m\]/i.test(raw)
  const base = raw.replace(/\[1m\]/i, '').trim()
  const modern = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base)
  const legacy = /^claude-(\d+)(?:-(\d+))?-([a-z]+)(?:-\d{8})?$/i.exec(base)
  let name: string
  if (modern) {
    name = `${modern[1]} ${modern[2]}${modern[3] ? `.${modern[3]}` : ''}`
  } else if (legacy) {
    name = `${legacy[3]} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ''}`
  } else {
    name = base.replace(/^claude-/i, '').replace(/-/g, ' ')
  }
  return `${name.toUpperCase()}${isLong ? ' 1M' : ''}`
}

/** The effort level as a warp factor, or null when the model takes none. */
export function warpFactor(effort: string | null): string | null {
  if (effort === null || effort === '') return null
  return WARP[effort.toLowerCase()] ?? `WARP ${effort.toUpperCase()}`
}

/**
 * The stardate by TNG's broadcast reckoning: 41000 when the show began in
 * 1987, a thousand units a year, the year's fraction after the point.
 */
export function stardate(ms: number): string {
  const date = new Date(ms)
  const year = date.getFullYear()
  const start = new Date(year, 0, 1).getTime()
  const end = new Date(year + 1, 0, 1).getTime()
  const value = 41000 + (year - 1987) * 1000 + ((ms - start) / (end - start)) * 1000
  return (Math.floor(value * 10) / 10).toFixed(1)
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** The local date, `OCT 02`: the plain counterpart of the stardate. */
export function shortDate(ms: number): string {
  const date = new Date(ms)
  return `${MONTHS[date.getMonth()] ?? ''} ${String(date.getDate()).padStart(2, '0')}`
}

/** Local wall-clock time, `HH:MM`. */
export function clockTime(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Time left as `T-2H14M`, `T-3D4H`, `T-45M`. */
export function countdown(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60000))
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    return `T-${days}D${hours ? `${hours}H` : ''}`
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return `T-${hours}H${rest ? `${rest}M` : ''}`
  }
  return `T-${minutes}M`
}

/** The same span in words, for the /lcars report: `2h14m`, `3d4h`. */
export function spanText(ms: number): string {
  return countdown(ms).slice(2).toLowerCase()
}

/** `96000` → `96K`; `1200000` → `1.2M`. */
export function tokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(Math.round(tokens))
}

/** A segmented LCARS meter, `cells` wide: the lit segments and the dark ones. */
export function gauge(percent: number, cells: number): { lit: string; dark: string } {
  const lit = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return { lit: '▊'.repeat(lit), dark: '▊'.repeat(cells - lit) }
}

/** `/home/me/src/app` → `~/src/app` when `home` is `/home/me`. */
export function homePath(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`
  return path
}

// ---------------------------------------------------------------------------
// Terminal cell widths
// ---------------------------------------------------------------------------

function charWidth(code: number): number {
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || (code >= 0xfe00 && code <= 0xfe0f)) {
    return 0
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** Cells `text` takes in a terminal: CJK and emoji two, combining marks none. */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
  return width
}

/** `text` cut to at most `max` cells, ending in `…` when cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (cellWidth(text) <= max) return text
  let out = ''
  let width = 0
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0)
    if (width + w > max - 1) break
    out += char
    width += w
  }
  return `${out}…`
}

/** `text` cut from the left to at most `max` cells: `…/deep/path`. */
export function clipStart(text: string, max: number): string {
  if (max <= 0) return ''
  if (cellWidth(text) <= max) return text
  const chars = [...text]
  let out = ''
  let width = 0
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const char = chars[i] ?? ''
    const w = charWidth(char.codePointAt(0) ?? 0)
    if (width + w > max - 1) break
    out = char + out
    width += w
  }
  return `…${out}`
}
