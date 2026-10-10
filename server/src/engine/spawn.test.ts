import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "./spawn.js";

const tick = () => new Promise((r) => setImmediate(r));

/** How many slots can be taken right now without waiting. */
function free(sem: Semaphore): number {
  let n = 0;
  while (sem.tryAcquire()) n++;
  for (let i = 0; i < n; i++) sem.release();
  return n;
}

test("a released slot goes to the waiter, never to a newcomer", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  let waiterHasIt = false;
  const waiting = sem.acquire().then(() => (waiterHasIt = true));
  sem.release();
  // The waiter has not resumed yet; the slot is already its.
  assert.equal(sem.tryAcquire(), false);
  await waiting;
  assert.equal(waiterHasIt, true);
  assert.equal(sem.tryAcquire(), false);
  sem.release();
  assert.equal(free(sem), 1);
});

test("waiters are served in the order they queued", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  const order: number[] = [];
  const waiters = [1, 2, 3].map((n) => sem.acquire().then(() => order.push(n)));
  for (let i = 0; i < 3; i++) {
    sem.release();
    await tick();
  }
  await Promise.all(waiters);
  assert.deepEqual(order, [1, 2, 3]);
  sem.release();
  assert.equal(free(sem), 1);
});

test("tryAcquire refuses while anyone is queued, even with a slot free", async () => {
  const sem = new Semaphore(2);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), true);
  const waiting = sem.acquire();
  assert.equal(sem.tryAcquire(), false);
  sem.release();
  await waiting;
  assert.equal(sem.tryAcquire(), false);
  sem.release();
  sem.release();
  assert.equal(free(sem), 2);
});

test("mixed acquires and releases return every slot", async () => {
  const sem = new Semaphore(2);
  const holders = Array.from({ length: 6 }, () => sem.acquire());
  for (let i = 0; i < 6; i++) {
    await Promise.race(holders.map((h) => h.then(() => undefined)));
    sem.release();
    await tick();
  }
  await Promise.all(holders);
  assert.equal(free(sem), 2);
});
