/**
 * Deterministic test dependencies.
 *
 * Real ids and real clocks make assertions unstable, so tests get a counting id
 * generator that still emits canonical uuids (the branded-id guards reject
 * anything else, and they should) and a clock that advances one second per read.
 */

import type { Clock, DomainDeps, IdGenerator } from '../src/index.js';

export function sequentialIds(prefix = 0): IdGenerator {
  let n = 0;
  return {
    next(): string {
      n += 1;
      const tail = n.toString(16).padStart(12, '0');
      const head = prefix.toString(16).padStart(8, '0');
      return `${head}-0000-4000-8000-${tail}`;
    },
  };
}

export function fixedClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)): Clock {
  let current = startMs;
  return {
    now(): string {
      const value = new Date(current).toISOString();
      current += 1000;
      return value;
    },
  };
}

export function testDeps(prefix = 0): DomainDeps {
  return { ids: sequentialIds(prefix), clock: fixedClock() };
}
