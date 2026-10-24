/**
 * Sonde de blocage de la boucle d'événements : un calcul synchrone qui retient
 * la boucle doit produire une alerte, une boucle libre aucune.
 */
import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const warnings: string[] = [];
const recordingLogger = {
  info: () => {}, error: () => {}, success: () => {}, debug: () => {},
  warn: (tag: string, message: string) => { warnings.push(`${tag}: ${message}`); },
};

for (const extension of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/logger.${extension}`), () => ({
    logger: recordingLogger, default: recordingLogger,
  }));
}

const { startEventLoopLagMonitor } = await import('../../observability/eventLoopLag.js');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startEventLoopLagMonitor', () => {
  test("signale un blocage de la boucle, et seulement lui", async () => {
    startEventLoopLagMonitor();

    await wait(1200);
    expect(warnings).toHaveLength(0);

    const blockedUntil = performance.now() + 1300; // > seuil + intervalle, quel que soit le moment du tick
    while (performance.now() < blockedUntil) { /* blocage volontaire */ }
    await wait(700);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^EventLoop: Boucle d'événements bloquée \d+ms/);
  });
});
