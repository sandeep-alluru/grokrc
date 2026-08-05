/**
 * Fixture: a pattern that matches nothing.
 *
 * A silent no-op would report the guard as verified while changing no code —
 * the failure mode that once shipped a stale README claim.
 */
export const GUARDS = [
  {
    id: 'fixture-pattern-drift',
    why: 'a find string that no longer matches must be reported, never skipped',
    file: 'src/daemon/events.ts',
    find: 'THIS_STRING_DOES_NOT_EXIST_ANYWHERE_IN_THE_FILE',
    replace: 'irrelevant',
    test: 'test/events.test.ts',
  },
];
