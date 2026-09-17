/**
 * Domain errors.
 *
 * Every failure the domain can express is one of these. They carry structured
 * detail rather than a formatted sentence so the Control Plane can map them onto
 * HTTP status codes, and the office UI onto copy, without string matching.
 */

export const DomainErrorCode = {
  VALIDATION: 'validation',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  ILLEGAL_TRANSITION: 'illegal_transition',
  CROSS_PROJECT: 'cross_project',
  DEPENDENCY_CYCLE: 'dependency_cycle',
} as const;
export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function validationError(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(DomainErrorCode.VALIDATION, message, details);
}

export function illegalTransitionError(
  kind: string,
  from: string,
  to: string,
  reason?: string,
): DomainError {
  const suffix = reason === undefined ? '' : ` (${reason})`;
  return new DomainError(
    DomainErrorCode.ILLEGAL_TRANSITION,
    `illegal ${kind} transition: ${from} -> ${to}${suffix}`,
    { kind, from, to, reason },
  );
}

export function crossProjectError(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(DomainErrorCode.CROSS_PROJECT, message, details);
}

export function dependencyCycleError(cycle: readonly string[]): DomainError {
  return new DomainError(
    DomainErrorCode.DEPENDENCY_CYCLE,
    `task dependency cycle: ${cycle.join(' -> ')}`,
    { cycle: [...cycle] },
  );
}

/** Reject empty / whitespace-only required text and return it trimmed. */
export function requireText(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw validationError(`${field} must not be empty`, { field });
  }
  return trimmed;
}
