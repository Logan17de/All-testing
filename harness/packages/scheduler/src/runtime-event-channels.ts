import {
  TypedRuntimeEventEmitter,
  type RuntimeEventLike,
  type RuntimeEventListener,
  type RuntimeEventOfType,
  type RuntimeEventType,
  type RuntimeEventUnsubscribe,
} from "./runtime-event-emitter.js";

export type RuntimeEventPersistence = "transient" | "durable";

/**
 * Runtime event with an explicit retention intent.
 *
 * `transient` means live/in-process delivery only. `durable` means the event is
 * eligible for the later durable event journal. This marker is classification,
 * not proof that an event has already been persisted.
 */
export interface ClassifiedRuntimeEventLike extends RuntimeEventLike {
  readonly persistence: RuntimeEventPersistence;
}

export type TransientRuntimeEvent<TEvent extends ClassifiedRuntimeEventLike> = Extract<
  TEvent,
  { readonly persistence: "transient" }
>;

export type DurableRuntimeEvent<TEvent extends ClassifiedRuntimeEventLike> = Extract<
  TEvent,
  { readonly persistence: "durable" }
>;

export function isTransientRuntimeEvent<TEvent extends ClassifiedRuntimeEventLike>(
  event: TEvent,
): event is TransientRuntimeEvent<TEvent> {
  return event.persistence === "transient";
}

export function isDurableRuntimeEvent<TEvent extends ClassifiedRuntimeEventLike>(
  event: TEvent,
): event is DurableRuntimeEvent<TEvent> {
  return event.persistence === "durable";
}

/**
 * Routes classified runtime events into disjoint transient and durable channels.
 *
 * The channels are intentionally separate instead of a persistence flag checked
 * by every listener. Future live-stream code may subscribe to both explicitly,
 * while a persistence sink can subscribe only to `onDurable*` and therefore
 * cannot accidentally receive token deltas/progress chatter at the type level.
 *
 * This class does not persist, serialize, sequence, replay, buffer, or retain
 * anything. Phase 4 owns the durable journal and SSE transport details.
 */
export class RuntimeEventChannels<TEvent extends ClassifiedRuntimeEventLike> {
  private readonly transientEmitter =
    new TypedRuntimeEventEmitter<TransientRuntimeEvent<TEvent>>();
  private readonly durableEmitter = new TypedRuntimeEventEmitter<DurableRuntimeEvent<TEvent>>();

  onTransient<TType extends RuntimeEventType<TransientRuntimeEvent<TEvent>>>(
    type: TType,
    listener: RuntimeEventListener<RuntimeEventOfType<TransientRuntimeEvent<TEvent>, TType>>,
  ): RuntimeEventUnsubscribe {
    return this.transientEmitter.on(type, listener);
  }

  onTransientAny(
    listener: RuntimeEventListener<TransientRuntimeEvent<TEvent>>,
  ): RuntimeEventUnsubscribe {
    return this.transientEmitter.onAny(listener);
  }

  onDurable<TType extends RuntimeEventType<DurableRuntimeEvent<TEvent>>>(
    type: TType,
    listener: RuntimeEventListener<RuntimeEventOfType<DurableRuntimeEvent<TEvent>, TType>>,
  ): RuntimeEventUnsubscribe {
    return this.durableEmitter.on(type, listener);
  }

  onDurableAny(
    listener: RuntimeEventListener<DurableRuntimeEvent<TEvent>>,
  ): RuntimeEventUnsubscribe {
    return this.durableEmitter.onAny(listener);
  }

  emit(event: TEvent): void {
    switch (event.persistence) {
      case "transient":
        this.transientEmitter.emit(event as TransientRuntimeEvent<TEvent>);
        return;
      case "durable":
        this.durableEmitter.emit(event as DurableRuntimeEvent<TEvent>);
        return;
      default:
        throw new TypeError(
          `Unknown runtime event persistence classification '${String(event.persistence)}'.`,
        );
    }
  }
}
