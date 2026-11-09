import { describe, expect, mock, test } from 'bun:test';
import { PausableTimers } from './pausableTimers';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PausableTimers', () => {
  test("declenche le rappel a l'echeance", async () => {
    const timers = new PausableTimers();
    const done = mock(() => {});
    timers.start('a', 20, done);
    await wait(40);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test("relancer une minuterie remplace l'ancienne", async () => {
    const timers = new PausableTimers();
    const done = mock(() => {});
    timers.start('a', 20, done);
    timers.start('a', 60, done);
    await wait(40);
    expect(done).not.toHaveBeenCalled();
    await wait(40);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('en pause, rien ne se declenche (RGAA 13.1)', async () => {
    const timers = new PausableTimers();
    const done = mock(() => {});
    timers.start('a', 20, done);
    timers.pause('a');
    await wait(40);
    expect(done).not.toHaveBeenCalled();
  });

  test('la reprise repart du temps restant, pas du debut', async () => {
    let now = 0;
    const timers = new PausableTimers(() => now);
    const done = mock(() => {});
    timers.start('a', 50, done);
    now = 30;
    timers.pause('a');
    expect(timers.remaining('a')).toBe(20);
    timers.resume('a');
    await wait(35);
    expect(done).toHaveBeenCalledTimes(1);
  });

  test('clear annule sans declencher', async () => {
    const timers = new PausableTimers();
    const done = mock(() => {});
    timers.start('a', 20, done);
    timers.clear('a');
    timers.resume('a');
    await wait(40);
    expect(done).not.toHaveBeenCalled();
  });

  test('une duree nulle ne programme rien', async () => {
    const timers = new PausableTimers();
    const done = mock(() => {});
    timers.start('a', 0, done);
    await wait(10);
    expect(done).not.toHaveBeenCalled();
  });
});
