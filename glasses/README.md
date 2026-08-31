# grokrc glasses

An [Even Realities G2](https://www.evenrealities.com) client for the grokrc
daemon. Drive a Grok Build session from your glasses: read the turn on the
lenses, approve tool calls with a tap, type prompts on the phone.

The daemon is unchanged in every way that matters — this speaks the same
WebSocket protocol the PWA does. See `src/daemon/server.ts` (`ClientMsg`) and
`src/daemon/events.ts` (`RcEvent`).

## Why it is not just the PWA on a smaller screen

The G2 is a 576 × 288 monochrome display with a four-gesture touchpad: tap,
double-tap, swipe up, swipe down. No keyboard, no pointer, no camera. The R1
ring emits the *same* event codes, so everything here works from the ring with
no extra handling.

That budget drives the whole design:

| View | scroll | tap | double-tap |
|---|---|---|---|
| sessions | move cursor | open | exit app |
| session | page transcript | jump to newest | back to list |
| approval | choose option | confirm | back to session |

Double-tap is always "back", and backs out of the list by exiting — so the
wearer can always leave, from anywhere.

## Three things that are not obvious

**Pairing runs over the WebSocket, not `POST /api/pair`.** An installed `.ehpk`
is served by the Even Hub host, so it is a *foreign origin* to the daemon, and
the browser blocks that fetch. There is no CORS on `/api/*`, and adding some
would widen the HTTP surface for every caller. WebSockets are not CORS-gated,
so `{t:'pair', code}` rides the socket the client is opening anyway. The daemon
answers `{t:'paired', token}` and the client then sends the normal `hello`, so
there is still exactly one path that authenticates a socket.

**The daemon URL must be https/wss and must be configured.** An installed build
cannot derive it — `location` is the Even Hub host, not grokrc. And a secure
page may not open a plain `ws://` socket; that is a browser rule, and it fails
before anything leaves the device. Set it in the phone panel's *Daemon address*.

**Persistence uses the SDK's storage, not `localStorage`.** The Even Hub WebView
does not keep browser `localStorage` across an app exit, so a token stored there
vanishes every launch and the app demands re-pairing forever. `bridge.setLocalStorage`
survives. See `src/lib/store.ts`.

## Layout

```
src/
  main.ts            views + the four gestures
  display.ts         the lenses: one container, paged, follows the tail
  rc/protocol.ts     wire types, MIRRORED from the daemon (see its header)
  rc/client.ts       one socket: pair, hello, sessions, prompts, approvals
  rc/transcript.ts   folds the event stream into ten readable lines
  ui/phone.ts        setup + the keyboard the glasses do not have
  lib/text.ts        wrapping at real LVGL glyph widths, via @evenrealities/pretext
  lib/store.ts       persistence that survives an app exit
```

`rc/protocol.ts` is a hand-kept copy of the daemon's types, because the daemon
is Node-targeted and this is a browser bundle. It is type-only and small, and
the compiler catches drift the moment a message is added on one side — which it
already did once during development.

## Develop

```bash
npm install
npm run dev          # vite on :5174
npm run build        # tsc --noEmit && vite build
npm run pack         # -> grokrc-glasses.ehpk
```

Test without hardware using the Even Hub simulator:

```bash
npx @evenrealities/evenhub-simulator --automation-port 9898 http://localhost:5173
```

The simulator drives the glasses display only; the phone panel is the page
itself, so a desktop browser is the faster loop for the setup and prompt UI.

## Status

Builds and typechecks; the daemon suite passes. Not yet exercised against real
G2 hardware — the display, gestures and reconnect logic are unproven on a
device, and that is the next thing to do.

## Licence

MIT, same as grokrc. Design of the G2 voice/compose flow was informed by
[ThatCrispyToast/g2-claude-remote](https://github.com/ThatCrispyToast/g2-claude-remote)
(MIT, © 2026 Aniket Chadalavada); no code from it is copied here.
