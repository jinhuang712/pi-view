import assert from "node:assert/strict";
import test from "node:test";
import { bindRowDecoration, readToolRowDecoratorHub, type ToolRowDecoratorHub } from "../src/row-decoration.ts";

const KEY = Symbol.for("pi.toolRowDecorator.v1");

interface Host {
  on: (event: string, handler: () => void) => void;
  emit: (event: "session_start" | "session_shutdown") => void;
}

function createHost(): Host {
  const handlers = new Map<string, Array<() => void>>();
  return {
    on: (event: string, handler: () => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit: (event) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

function withHub<T>(hub: unknown, run: () => T): T {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const previous = globals[KEY];
  globals[KEY] = hub;
  try {
    return run();
  } finally {
    if (previous === undefined) delete globals[KEY];
    else globals[KEY] = previous;
  }
}

function fakeHub(): ToolRowDecoratorHub & { notify: () => void; subscribed: number } {
  const listeners = new Set<() => void>();
  return {
    subscribed: 0,
    decorate: () => undefined,
    subscribe(listener) {
      this.subscribed = listeners.size + 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        this.subscribed = listeners.size;
      };
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

test("the hub is absent unless pi-briefly published one", () => {
  withHub(undefined, () => assert.equal(readToolRowDecoratorHub(), undefined));
  withHub({}, () => assert.equal(readToolRowDecoratorHub(), undefined));
  withHub({ decorate: () => undefined }, () => assert.ok(readToolRowDecoratorHub()));
});

test("a session applies the decoration, follows the hub, and cleans up", () => {
  const host = createHost();
  const hub = fakeHub();
  let applied = 0;
  bindRowDecoration(host, () => {
    applied += 1;
  });

  host.emit("session_start");
  assert.equal(applied, 1, "the hub is only guaranteed to exist by session_start");
  assert.equal(hub.subscribed, 0, "nothing to subscribe to without a hub");

  withHub(hub, () => {
    // A new session picks the hub up, which is also the reload path.
    host.emit("session_start");
    assert.equal(applied, 2);
    assert.equal(hub.subscribed, 1);

    // /briefly flips mid-session: re-apply without a restart, exactly once.
    hub.notify();
    assert.equal(applied, 3);

    host.emit("session_shutdown");
    assert.equal(hub.subscribed, 0);
  });

  hub.notify();
  assert.equal(applied, 3, "a shut-down session must not keep re-registering tools");
});
