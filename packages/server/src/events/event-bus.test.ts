import { describe, it, expect, vi } from 'vitest';
import { InProcessEventBus, type AppEvent } from './event-bus.js';

const uploaded = (documentId: string): AppEvent => ({ type: 'document.uploaded', documentId, knowledgeBaseId: 'kb' });

describe('InProcessEventBus', () => {
  it('delivers events to subscribers in publish order', () => {
    const bus = new InProcessEventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push((e as any).documentId));
    bus.publish(uploaded('1'));
    bus.publish(uploaded('2'));
    bus.publish(uploaded('3'));
    expect(seen).toEqual(['1', '2', '3']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new InProcessEventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish(uploaded('1'));
    off();
    bus.publish(uploaded('2'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering to other subscribers when one throws, and never throws into the publisher', () => {
    const bus = new InProcessEventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(good);
    expect(() => bus.publish(uploaded('1'))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('tolerates a subscriber unsubscribing itself during delivery', () => {
    const bus = new InProcessEventBus();
    const second = vi.fn();
    const off = bus.subscribe(() => off());
    bus.subscribe(second);
    bus.publish(uploaded('1'));
    bus.publish(uploaded('2'));
    expect(second).toHaveBeenCalledTimes(2);
  });
});
