import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

// Post-commit observability: by the time a publish runs, the side effect has
// already committed. EventEmitter dispatches listeners synchronously, so a
// listener that throws (e.g. socket.send on a closing connection, JSON.stringify
// on a circular payload) would surface as a 5xx for a successful request and
// trigger retry-driven duplicates. See PLA-9 / PLA-12 and doc/route-response-rules.md.
function safeEmit(channel: string, event: LiveEvent): void {
  try {
    emitter.emit(channel, event);
  } catch (err) {
    logger.warn(
      { err, channel, type: event.type, companyId: event.companyId },
      "publishLiveEvent listener threw; suppressing to keep post-commit response path stable",
    );
  }
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  safeEmit(input.companyId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  safeEmit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
