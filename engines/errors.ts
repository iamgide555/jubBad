/**
 * Thrown when the engine is handed input it cannot mean anything sensible
 * about — a duplicated player, a negative game count, a fractional court.
 *
 * The engine used to absorb these silently. A roster with the same id twice
 * produces fewer distinct players than it appears to, so `usableCourts` can
 * fall to zero and the caller reports "not enough players" — which is a lie
 * that sends the host looking for absent players instead of at the corrupt
 * state that actually caused it. Failing loudly is worth more than a plausible
 * wrong answer, because the plausible wrong answer is unfalsifiable at
 * courtside.
 */
export class InvalidRoundInputError extends Error {
  readonly code = 'INVALID_ROUND_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoundInputError';
  }
}
