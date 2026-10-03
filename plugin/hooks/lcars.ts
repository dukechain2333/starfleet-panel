// LCARS drawing primitives: the palette, the frame colors, and rows of styled
// pieces fitted to a width. Pure: the hooks module turns pieces into <Text>.

import { cellWidth, clip } from './readouts'

/**
 * LCARS console colors. The shared ones are red-alert's own values, so the
 * panel under the prompt and red-alert's band above it read as one console.
 */
export const LCARS = {
  orange: '#FF9900',
  sand: '#FFCC99',
  peach: '#FF9966',
  lavender: '#CC99CC',
  violet: '#9999FF',
  blue: '#99CCFF',
  tan: '#CC9966',
  green: '#66DD99',
  yellow: '#FFCC33',
  red: '#FF5555',
  ink: '#000000',
} as const

/** The four colors a frame is painted in. */
export type Frame = {
  /** The elbows and the sidebar. */
  primary: string
  /** The long bars. */
  secondary: string
  /** The short bar segments. */
  accent: string
  /** Labels printed on black. */
  label: string
}

export const STANDARD_FRAME: Frame = {
  primary: LCARS.orange,
  secondary: LCARS.lavender,
  accent: LCARS.peach,
  label: LCARS.tan,
}

type Rgb = readonly [number, number, number]

function rgb(color: string): Rgb {
  const n = Number.parseInt(color.replace('#', '').slice(0, 6), 16)
  return Number.isNaN(n) ? [255, 153, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function channel(v: number): string {
  return Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
}

/** Blends `a` toward `b` by `t` (0..1). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const k = Math.max(0, Math.min(1, t))
  return `#${channel(ar + (br - ar) * k)}${channel(ag + (bg - ag) * k)}${channel(ab + (bb - ab) * k)}`.toUpperCase()
}

/** The frame repainted in an alert's color, as every console on the ship turns red. */
export function alertFrame(color: string): Frame {
  return {
    primary: color,
    secondary: mix(color, LCARS.ink, 0.45),
    accent: mix(color, '#FFFFFF', 0.35),
    label: mix(color, '#FFFFFF', 0.5),
  }
}

/** One run of text in one style. */
export type Piece = {
  text: string
  color?: string
  backgroundColor?: string
  bold?: boolean
  dimColor?: boolean
}

/**
 * Pieces kept or dropped together; the lowest `priority` goes first when room
 * runs out. Items that name the same `group` are dropped together.
 */
export type Item = { pieces: Piece[]; priority: number; group?: string }

/** A row to fit: fixed ends, droppable items, and a filler that takes what is left. */
export type RowSpec = {
  left: Piece[]
  items: Item[]
  /** Where among the items the filler goes (0 = before the first). */
  fillAt: number
  fill: (cells: number) => Piece[]
  right: Piece[]
  /** The filler's least width; items are dropped to keep it. */
  minFill?: number
}

export function widthOf(pieces: readonly Piece[]): number {
  return pieces.reduce((n, piece) => n + cellWidth(piece.text), 0)
}

/** Pieces cut to `max` cells, the last one kept ends in `…`. */
function clipPieces(pieces: readonly Piece[], max: number): Piece[] {
  const out: Piece[] = []
  let left = max
  for (const piece of pieces) {
    if (left <= 0) break
    const width = cellWidth(piece.text)
    if (width <= left) {
      out.push(piece)
      left -= width
    } else {
      out.push({ ...piece, text: clip(piece.text, left) })
      left = 0
    }
  }
  return out
}

function sameStyle(a: Piece, b: Piece): boolean {
  return a.color === b.color && a.backgroundColor === b.backgroundColor && a.bold === b.bold && a.dimColor === b.dimColor
}

/** Joins neighbours of one style, so a row draws as few <Text> runs as it can. */
export function merge(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = []
  for (const piece of pieces) {
    if (piece.text === '') continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, piece)) {
      out[out.length - 1] = { ...last, text: last.text + piece.text }
    } else {
      out.push({ ...piece })
    }
  }
  return out
}

/**
 * Fits a row to exactly `width` cells: drops the lowest-priority items until
 * the rest fit beside the filler's least width, then gives the filler what is
 * left. When even the fixed ends do not fit, they are cut.
 */
export function fitRow(spec: RowSpec, width: number): Piece[] {
  const minFill = spec.minFill ?? 0
  const fixed = widthOf(spec.left) + widthOf(spec.right)
  if (fixed + minFill > width) {
    return merge(clipPieces([...spec.left, ...spec.right], width))
  }
  const kept = spec.items.map(() => true)
  const widths = spec.items.map(item => widthOf(item.pieces))
  const used = () => widths.reduce((n, w, i) => (kept[i] ? n + w : n), fixed)
  while (used() + minFill > width) {
    let drop = -1
    spec.items.forEach((item, i) => {
      const current = spec.items[drop]
      if (kept[i] && (drop === -1 || (current !== undefined && item.priority <= current.priority))) drop = i
    })
    if (drop === -1) break
    const group = spec.items[drop]?.group
    spec.items.forEach((item, i) => {
      if (i === drop || (group !== undefined && item.group === group)) kept[i] = false
    })
  }
  const pieces: Piece[] = [...spec.left]
  const filler = spec.fill(Math.max(0, width - used()))
  spec.items.forEach((item, i) => {
    if (i === spec.fillAt) pieces.push(...filler)
    if (kept[i]) pieces.push(...item.pieces)
  })
  if (spec.fillAt >= spec.items.length) pieces.push(...filler)
  pieces.push(...spec.right)
  return merge(pieces)
}

/** A rounded LCARS pill: `▐ LABEL ▌`, ink on color. */
export function pill(label: string, color: string): Piece[] {
  return [
    { text: '▐', color },
    { text: ` ${label} `, color: LCARS.ink, backgroundColor: color, bold: true },
    { text: '▌', color },
  ]
}
