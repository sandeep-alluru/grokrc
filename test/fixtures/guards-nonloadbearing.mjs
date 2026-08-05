/**
 * Fixture: a "control" that is not load-bearing.
 *
 * Mutating a comment changes no behaviour, so test/events.test.ts still passes.
 * The runner must call that out rather than count it as proven.
 */
export const GUARDS = [
  {
    id: 'fixture-comment-only',
    why: 'mutating a comment must not count as a proven control',
    file: 'src/daemon/events.ts',
    find: ' * The client-facing event model.',
    replace: ' * The client-facing event model (fixture mutation).',
    test: 'test/events.test.ts',
  },
];
