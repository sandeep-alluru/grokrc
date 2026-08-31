import type { RcClient } from '../rc/client'

/**
 * The phone half.
 *
 * The G2 has no keyboard — the touchpad reports taps and scrolls and nothing
 * else — so setup and typed prompts happen here, in the companion WebView, and
 * the session is read on the lenses.
 *
 * The daemon URL is editable here on purpose. An installed build cannot derive
 * it, and when it is wrong the only symptom on the glasses is silence; showing
 * the address and letting it be corrected turns that into something fixable.
 */

export interface PhoneHooks {
  onPrompt(text: string): void
  onRefresh(): void
  status(): string
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  for (const c of children) node.append(c)
  return node
}

export function mountPhoneUI(root: HTMLElement, client: RcClient, hooks: PhoneHooks): () => void {
  const status = el('p', { className: 'status' })

  const render = () => {
    root.replaceChildren(client.paired ? promptView() : setupView())
  }

  function daemonRow(): HTMLElement {
    const field = el('input', {
      className: 'url',
      value: client.baseUrl,
      placeholder: 'https://your-machine.ts.net:8445',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
    })
    const test = el('button', { className: 'link', textContent: 'Save & connect' })
    const out = el('p', { className: 'tiny' })
    test.onclick = async () => {
      out.textContent = 'Connecting…'
      await client.setBaseUrl(field.value)
      // Reachability is the socket opening — there is no fetch to test with,
      // by design, since a foreign origin cannot call the daemon's HTTP API.
      window.setTimeout(() => {
        out.textContent = client.connected
          ? `Connected to ${client.baseUrl}`
          : `No answer from ${client.baseUrl}`
      }, 1500)
    }
    return el('details', { className: 'settings' }, [
      el('summary', { textContent: 'Daemon address' }),
      field,
      test,
      out,
    ])
  }

  function setupView(): HTMLElement {
    const code = el('input', {
      className: 'code',
      placeholder: 'ABC123',
      maxLength: 6,
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: false,
    })
    const go = el('button', { className: 'primary', textContent: 'Pair these glasses' })
    go.onclick = async () => {
      if (code.value.trim().length !== 6) {
        status.textContent = 'The code is 6 characters.'
        return
      }
      if (!client.connected) {
        status.textContent = 'Not connected — set the daemon address first.'
        return
      }
      go.disabled = true
      status.textContent = 'Pairing…'
      try {
        await client.pair(code.value)
        status.textContent = 'Paired'
        render()
      } catch (e) {
        status.textContent = e instanceof Error ? e.message : String(e)
        go.disabled = false
      }
    }
    return el('div', { className: 'card' }, [
      el('h1', { textContent: 'grokrc' }),
      el('p', {
        className: 'muted',
        textContent:
          'Set the daemon address, then run `grokrc pair` on your machine and enter the code it prints.',
      }),
      daemonRow(),
      code,
      go,
      status,
    ])
  }

  function promptView(): HTMLElement {
    const box = el('textarea', {
      className: 'prompt',
      placeholder: 'Tell Grok what to do…',
      rows: 4,
    })
    const send = el('button', { className: 'primary', textContent: 'Send' })
    const submit = () => {
      const text = box.value.trim()
      if (!text) return
      hooks.onPrompt(text)
      box.value = ''
      status.textContent = 'Sent — watch your glasses'
    }
    send.onclick = submit
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
    }

    const refresh = el('button', { className: 'link', textContent: 'Refresh sessions' })
    refresh.onclick = () => hooks.onRefresh()

    const unpair = el('button', { className: 'link', textContent: 'Unpair' })
    unpair.onclick = async () => {
      await client.unpair()
      render()
    }

    return el('div', { className: 'card' }, [
      el('h1', { textContent: 'grokrc' }),
      box,
      send,
      status,
      daemonRow(),
      refresh,
      unpair,
    ])
  }

  render()
  return render
}

export function setPhoneStatus(root: HTMLElement, text: string): void {
  const s = root.querySelector('.status')
  if (s) s.textContent = text
}
