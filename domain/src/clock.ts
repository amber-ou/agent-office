/**
 * Time, as a port.
 *
 * Every domain timestamp is an ISO 8601 string in UTC. Control Plane and Agent
 * Runtime may not share a machine (see ADR 003), so a numeric epoch read on one
 * side and compared on the other is a latent bug; a string that always carries
 * its offset is not. The Control Plane stamps the times it records — a runtime's
 * self-reported clock is never trusted for ordering.
 */

import type { IdGenerator } from './ids.js';

export type Timestamp = string;

export interface Clock {
  now(): Timestamp;
}

export const systemClock: Clock = {
  now(): Timestamp {
    return new Date().toISOString();
  },
};

/** Dependencies every entity factory needs: identity and time. */
export interface DomainDeps {
  ids: IdGenerator;
  clock: Clock;
}
