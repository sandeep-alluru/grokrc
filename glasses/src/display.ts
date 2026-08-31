import {
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import { SCREEN_W, SCREEN_H, PADDING, BODY_LINES, wrapToWidth, paginate } from './lib/text'

type Bridge = Awaited<
  ReturnType<(typeof import('@evenrealities/even_hub_sdk'))['waitForEvenAppBridge']>
>

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

/**
 * Everything drawn on the lenses.
 *
 * One text container, redrawn in place via `textContainerUpgrade` — it updates
 * without flicker, unlike rebuilding the page for every token that streams in.
 * Content is wrapped at real LVGL glyph widths and pre-paginated, because the
 * canvas holds ten lines and an agent turn does not.
 *
 * `follow` is what makes a live turn readable: while the wearer is at the end,
 * new content keeps the view pinned to the tail. The moment they scroll back to
 * read something, following stops so the text does not yank away mid-sentence.
 */
export class Display {
  #bridge: Bridge
  #pages: string[][] = [['']]
  #page = 0
  #footer = ''
  #follow = true

  constructor(bridge: Bridge) {
    this.#bridge = bridge
  }

  async start(initial: string, footer = ''): Promise<number> {
    this.#setBody(initial, footer)
    return this.#bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: SCREEN_W,
            height: SCREEN_H,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: PADDING,
            containerID: CONTAINER_ID,
            containerName: CONTAINER_NAME,
            content: this.#render(),
            isEventCapture: 1,
          }),
        ],
      }),
    )
  }

  #setBody(text: string, footer: string): void {
    const wasAtEnd = this.#follow
    this.#pages = paginate(wrapToWidth(text), BODY_LINES)
    this.#footer = footer
    if (wasAtEnd) this.#page = this.#pages.length - 1
    else this.#page = Math.min(this.#page, this.#pages.length - 1)
  }

  #render(): string {
    const body = this.#pages[this.#page] ?? ['']
    const pager = this.#pages.length > 1 ? `  [${this.#page + 1}/${this.#pages.length}]` : ''
    // Pad to a fixed height so the footer sits on the same line every frame and
    // the text does not jump as pages of different length go by.
    const padded = [...body, ...Array(Math.max(0, BODY_LINES - body.length)).fill('')]
    return [...padded, `${this.#footer}${pager}`].join('\n')
  }

  #push(): void {
    this.#bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        content: this.#render(),
      }),
    )
  }

  /** Replace the screen. Resets to the top and stops following. */
  show(text: string, footer = ''): void {
    this.#follow = false
    this.#pages = paginate(wrapToWidth(text), BODY_LINES)
    this.#page = 0
    this.#footer = footer
    this.#push()
  }

  /** Replace the screen, keeping the tail in view while the wearer is at the end. */
  stream(text: string, footer = ''): void {
    this.#setBody(text, footer)
    this.#push()
  }

  /** Jump to the newest content and resume following. */
  toEnd(): void {
    this.#follow = true
    this.#page = this.#pages.length - 1
    this.#push()
  }

  redraw(): void {
    this.#push()
  }

  nextPage(): boolean {
    if (this.#page >= this.#pages.length - 1) {
      this.#follow = true // already at the end — treat a further scroll as "keep up"
      return false
    }
    this.#page += 1
    this.#follow = this.#page >= this.#pages.length - 1
    this.#push()
    return true
  }

  prevPage(): boolean {
    if (this.#page <= 0) return false
    this.#page -= 1
    this.#follow = false // reading back; stop yanking to the tail
    this.#push()
    return true
  }
}
