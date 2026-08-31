import { getTextWidth } from '@evenrealities/pretext'

// The glasses canvas, and what actually fits on it.
//
// `getTextWidth` measures at the glyph widths the G2's LVGL renderer uses, so
// wrapping here matches what the hardware draws. Guessing a character count
// instead produces lines that overflow and trigger a scrollbar.
export const SCREEN_W = 576
export const SCREEN_H = 288
export const PADDING = 4
export const LINE_H = 27

/** LVGL subtracts padding from the text area on both sides. */
export const INNER_W = SCREEN_W - PADDING * 2
export const INNER_H = SCREEN_H - PADDING * 2

/** 280 / 27 = 10 whole lines. The last is reserved for the status footer. */
export const MAX_LINES = Math.floor(INNER_H / LINE_H)
export const BODY_LINES = MAX_LINES - 1

/** Greedy word wrap at real glyph widths. Preserves paragraph breaks. */
export function wrapToWidth(text: string, maxWidth = INNER_W): string[] {
  const lines: string[] = []

  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word
      if (getTextWidth(candidate) <= maxWidth) {
        current = candidate
        continue
      }
      if (current) lines.push(current)

      // A single token wider than the line (a URL, a long path) never fits by
      // word, so it has to be broken by character or it would loop forever.
      let chunk = ''
      for (const ch of word) {
        if (chunk && getTextWidth(chunk + ch) > maxWidth) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      current = chunk
    }
    if (current) lines.push(current)
  }

  return lines.length ? lines : ['']
}

export function paginate(lines: string[], perPage = BODY_LINES): string[][] {
  if (!lines.length) return [['']]
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage))
  return pages
}
