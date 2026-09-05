/**
 * #6501 — unit contract for the boot-window browser-loss watch: exactly one
 * `[browser-loss]` line, naming the FIRST terminal signal, only while armed.
 * The whole point is disambiguation (renderer-crash vs browser-disconnected
 * vs context-closed), so double-reporting or reporting normal teardown would
 * recreate the ambiguity the helper exists to remove.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attachBrowserLossDiagnostics,
  type BrowserLossEvents,
} from '../e2e/browser-loss-diagnostics';

function fakeEvents(): BrowserLossEvents & {
  crash(): void;
  disconnect(): void;
  closeContext(): void;
} {
  const listeners = { crash: [] as Array<() => void>, disc: [] as Array<() => void>, close: [] as Array<() => void> };
  return {
    onCrash: (l) => listeners.crash.push(l),
    onBrowserDisconnected: (l) => listeners.disc.push(l),
    onContextClose: (l) => listeners.close.push(l),
    crash: () => listeners.crash.forEach((l) => l()),
    disconnect: () => listeners.disc.forEach((l) => l()),
    closeContext: () => listeners.close.forEach((l) => l()),
  };
}

const NOW = () => '2026-09-05T00:00:00.000Z';

describe('attachBrowserLossDiagnostics (#6501)', () => {
  it('names a renderer crash', () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.crash();

    assert.deepEqual(lines, ['[browser-loss] kind=renderer-crash spec="spec boot" at=2026-09-05T00:00:00.000Z']);
  });

  it('names a browser-process exit', () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.disconnect();

    assert.match(lines[0]!, /kind=browser-disconnected/);
  });

  it('reports only the FIRST terminal signal — the cascade is a consequence, not a second cause', () => {
    const events = fakeEvents();
    const lines: string[] = [];
    attachBrowserLossDiagnostics(events, 'spec boot', (l) => lines.push(l), NOW);

    events.disconnect();
    events.closeContext();
    events.crash();

    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /kind=browser-disconnected/);
  });

  it('a context close INSIDE the boot window reports; after dispose it is silent teardown', () => {
    const armed = fakeEvents();
    const armedLines: string[] = [];
    attachBrowserLossDiagnostics(armed, 'spec boot', (l) => armedLines.push(l), NOW);
    armed.closeContext();
    assert.match(armedLines[0]!, /kind=context-closed/);

    const disposed = fakeEvents();
    const disposedLines: string[] = [];
    const watch = attachBrowserLossDiagnostics(disposed, 'spec boot', (l) => disposedLines.push(l), NOW);
    watch.dispose();
    disposed.closeContext();
    assert.deepEqual(disposedLines, [], 'every green test closes its context; that must not print');
  });
});
