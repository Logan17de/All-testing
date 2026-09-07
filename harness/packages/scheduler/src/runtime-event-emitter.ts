export interface RuntimeEventLike {
  readonly type: string;
}

export type RuntimeEventType<TEvent extends RuntimeEventLike> = TEvent["type"];

export type RuntimeEventOfType<
  TEvent extends RuntimeEventLike,
  TType extends RuntimeEventType<TEvent>,
> = Extract<TEvent, { readonly type: TType }>;

export type RuntimeEventListener<TEvent extends RuntimeEventLike> = (event: TEvent) => void;

export type RuntimeEventUnsubscribe = () => void;

interface RuntimeEventSubscription<TEvent extends RuntimeEventLike> {
  readonly type: RuntimeEventType<TEvent> | undefined;
  readonly listener: RuntimeEventListener<TEvent>;
}

/**
 * Tiny synchronous typed event emitter for in-process runtime/scheduler events.
 *
 * Listeners are invoked in subscription order. Each emit snapshots the current
 * subscriptions first, so listeners added or removed while handling an event do
 * not change delivery for that in-flight emit. Listener exceptions are not
 * swallowed; callers decide whether an event boundary is best-effort or critical.
 *
 * Event durability/streaming classification is deliberately not part of this
 * primitive. Phase 3.14 owns the transient-versus-durable event contract.
 */
export class TypedRuntimeEventEmitter<TEvent extends RuntimeEventLike> {
  private readonly subscriptions = new Set<RuntimeEventSubscription<TEvent>>();

  on<TType extends RuntimeEventType<TEvent>>(
    type: TType,
    listener: RuntimeEventListener<RuntimeEventOfType<TEvent, TType>>,
  ): RuntimeEventUnsubscribe {
    const subscription: RuntimeEventSubscription<TEvent> = Object.freeze({
      type,
      listener: listener as RuntimeEventListener<TEvent>,
    });
    this.subscriptions.add(subscription);
    return this.unsubscribeHandle(subscription);
  }

  onAny(listener: RuntimeEventListener<TEvent>): RuntimeEventUnsubscribe {
    const subscription: RuntimeEventSubscription<TEvent> = Object.freeze({
      type: undefined,
      listener,
    });
    this.subscriptions.add(subscription);
    return this.unsubscribeHandle(subscription);
  }

  emit(event: TEvent): void {
    for (const subscription of [...this.subscriptions]) {
      if (subscription.type === undefined || subscription.type === event.type) {
        subscription.listener(event);
      }
    }
  }

  private unsubscribeHandle(
    subscription: RuntimeEventSubscription<TEvent>,
  ): RuntimeEventUnsubscribe {
    let active = true;

    return (): void => {
      if (!active) {
        return;
      }
      active = false;
      this.subscriptions.delete(subscription);
    };
  }
}
