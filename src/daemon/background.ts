/**
 * Run a promise nobody awaits, without letting its failure kill the daemon.
 *
 * The daemon is a long-lived process holding every live session, and Node
 * terminates on an unhandled rejection. So `void somethingAsync()` is a loaded
 * gun: the call site reads as "this is not important enough to await", and the
 * consequence is the opposite — the whole process dies, taking every unrelated
 * session with it.
 *
 * Four sites had it, all reachable from ordinary traffic and all ending in a
 * write to `~/.grokrc`:
 *
 *   auth.verify()     -> `void this.#save()`      every WebSocket `hello`
 *   push.notify*()    -> #send -> #save()         an expired subscription
 *   #handlePair       -> redeem() -> #save()      a phone pairing
 *   #handleSubscribe  -> subscribe() -> #save()   enabling notifications
 *
 * Two were reproduced by making the store a directory and watching a real
 * process die with `EISDIR ... at async #save`. See
 * `test/store-write-failure.test.ts`.
 *
 * This is deliberately NOT a global `process.on('unhandledRejection')` handler.
 * That would swallow the class everywhere, including in code that genuinely
 * ought to fail loudly — the alarm removed and the cause left alive. Each call
 * site names what it was doing, so a failure is reported rather than hidden.
 *
 * It logs. Silence would trade a crash for an invisible fault, and an operator
 * who cannot see that the device store stopped saving has been given the worse
 * of the two problems.
 */

/**
 * @param what   what was being attempted, phrased for a log line
 * @param p      the promise to run in the background
 */
export function background(what: string, p: Promise<unknown>): void {
  void p.catch((err: unknown) => {
    console.warn(`  ⚠ ${what} failed: ${(err as Error)?.message ?? String(err)}`);
  });
}
