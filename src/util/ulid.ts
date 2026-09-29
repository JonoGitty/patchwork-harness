import { ulid } from "ulid";

export function newSessionId(): string {
  return `ses_${ulid()}`;
}

export function newEventId(): string {
  return `evt_${ulid()}`;
}
