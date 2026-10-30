// Runtime proof of the App.destroy teardown contract and the viewport-prime
// scroll handler (#8690, replacing the source-text checks in
// tests/app-destroy-lifecycle.test.mjs).
//
// App is constructed for real (the constructor needs only the container) and
// destroyed without init, the same way main.ts tears down a boot that failed.
// Module teardown, the map/AIS tail, listener removal, the queued-frame
// cancel and the WebMCP controller are observed through spies; the viewport
// handler is driven with real Events; the lazy vessel runtime is driven
// through its public functions with the heavy module mocked.
//
// One text check stays, with its reason: src/main.ts calls app.destroy() in
// the boot .catch, and main.ts cannot be imported (it boots the dashboard on
// evaluation), so that wiring is pinned by text.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  disconnectAisStream: vi.fn(),
  stopFlightHistoryCleanup: vi.fn(),
  terminate: vi.fn(),
  destroyBreakingNewsAlerts: vi.fn(),
  cancelBootstrapSlowTier: vi.fn(),
  vessels: {
    startVesselHistoryCleanup: vi.fn(),
    stopVesselHistoryCleanup: vi.fn(),
    disconnectMilitaryVesselStream: vi.fn(),
  },
  badgeDestroy: vi.fn(),
}));

vi.mock('@/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services')>()),
  initDB: vi.fn(async () => undefined),
  disconnectAisStream: spies.disconnectAisStream,
  stopFlightHistoryCleanup: spies.stopFlightHistoryCleanup,
}));
vi.mock('@/services/ml-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ml-worker')>();
  return { ...actual, mlWorker: { ...actual.mlWorker, terminate: spies.terminate } };
});
vi.mock('@/services/breaking-news-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/breaking-news-alerts')>()),
  destroyBreakingNewsAlerts: spies.destroyBreakingNewsAlerts,
}));
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bootstrap')>()),
  cancelBootstrapSlowTier: spies.cancelBootstrapSlowTier,
  fetchBootstrapData: vi.fn(async () => undefined),
}));
vi.mock('@/services/military-vessels', () => ({
  fetchMilitaryVessels: vi.fn(async () => []),
  disconnectMilitaryVesselStream: spies.vessels.disconnectMilitaryVesselStream,
  initMilitaryVesselStream: vi.fn(),
  isMilitaryVesselTrackingConfigured: () => false,
  startVesselHistoryCleanup: spies.vessels.startVesselHistoryCleanup,
  stopVesselHistoryCleanup: spies.vessels.stopVesselHistoryCleanup,
}));
vi.mock('@/components/IntelligenceGapBadge', () => ({
  IntelligenceGapBadge: class {
    setOnSignalClick(): void {}
    destroy = spies.badgeDestroy;
  },
}));

import { App } from '@/App';
import {
  VesselRuntimeStoppedError,
  enableVesselRuntime,
  getMilitaryVesselsModule,
  isVesselRuntimeStoppedError,
  stopLoadedVesselHistoryCleanup,
} from '@/services/military-vessels-lazy';

type AppInternals = {
  state: { isDestroyed: boolean; map: { destroy: () => void } | null; findingsBadge: { destroy: () => void } | null };
  modules: Array<{ destroy(): void }>;
  lifecycleController: AbortController;
  webMcpController: AbortController | null;
  visiblePanelPrimeRaf: number | null;
  viewportHydrationReady: boolean;
  viewportHydrationReadyAt: number;
  viewportTriggersArmed: boolean;
  handleViewportPrime: (event?: Event) => void;
  runVisibleDataFanout: () => Promise<void>;
  primeVisiblePanelData: () => Promise<void>;
  dataLoader: { loadAllData: (forceAll?: boolean, trigger?: 'full' | 'viewport') => Promise<void> };
  initFindingsBadge: () => Promise<void>;
};

function makeApp(): { app: App; internals: AppInternals } {
  const container = document.createElement('div');
  container.id = 'app';
  document.body.appendChild(container);
  const app = new App('app');
  return { app, internals: app as unknown as AppInternals };
}

function scrollFrom(target: Element, timeStamp?: number): Event {
  const event = new Event('scroll', { bubbles: true });
  Object.defineProperty(event, 'target', { value: target });
  if (timeStamp !== undefined) Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

beforeEach(() => {
  for (const spy of [spies.disconnectAisStream, spies.stopFlightHistoryCleanup, spies.terminate, spies.destroyBreakingNewsAlerts, spies.cancelBootstrapSlowTier, spies.badgeDestroy]) spy.mockClear();
  for (const spy of Object.values(spies.vessels)) spy.mockClear();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in test'));
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('App.destroy', () => {
  it('tears down the map, AIS, flight cleanup, workers and WebMCP even when a module destructor throws', () => {
    const { app, internals } = makeApp();
    const order: string[] = [];
    internals.modules = [
      { destroy: () => { order.push('first'); } },
      { destroy: () => { order.push('throws'); throw new Error('module teardown failed'); } },
      { destroy: () => { order.push('last'); } },
    ];
    internals.state.map = { destroy: () => { order.push('map'); } };
    internals.state.findingsBadge = { destroy: spies.badgeDestroy };
    const webMcp = new AbortController();
    internals.webMcpController = webMcp;
    const lifecycle = internals.lifecycleController;

    expect(() => app.destroy()).not.toThrow();

    // modules destroy in reverse order and the map still follows a throwing module
    expect(order).toEqual(['last', 'throws', 'first', 'map']);
    expect(internals.state.isDestroyed).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(webMcp.signal.aborted).toBe(true);
    expect(internals.webMcpController).toBeNull();
    expect(spies.disconnectAisStream).toHaveBeenCalledTimes(1);
    expect(spies.stopFlightHistoryCleanup).toHaveBeenCalledTimes(1);
    expect(spies.terminate).toHaveBeenCalledTimes(1);
    expect(spies.destroyBreakingNewsAlerts).toHaveBeenCalledTimes(1);
    expect(spies.cancelBootstrapSlowTier).toHaveBeenCalledTimes(1);
    expect(spies.badgeDestroy).toHaveBeenCalledTimes(1);
    expect(internals.state.findingsBadge).toBeNull();
  });

  it('removes the capture-phase scroll listener and the resize listener, and cancels a queued hydration frame', async () => {
    const { app, internals } = makeApp();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42);
    vi.spyOn(internals, 'primeVisiblePanelData').mockResolvedValue(undefined);
    vi.spyOn(internals.dataLoader, 'loadAllData').mockResolvedValue(undefined);
    const scroller = document.createElement('div');
    scroller.className = 'main-content';
    document.body.appendChild(scroller);

    await internals.runVisibleDataFanout();
    expect(add).toHaveBeenCalledWith('scroll', internals.handleViewportPrime, { passive: true, capture: true });
    expect(add).toHaveBeenCalledWith('resize', internals.handleViewportPrime);
    scroller.dispatchEvent(new Event('scroll'));
    expect(raf).toHaveBeenCalledTimes(1);
    expect(internals.visiblePanelPrimeRaf).toBe(42);

    app.destroy();

    expect(remove).toHaveBeenCalledWith('scroll', internals.handleViewportPrime, { capture: true });
    expect(remove).toHaveBeenCalledWith('resize', internals.handleViewportPrime);
    expect(cancel).toHaveBeenCalledWith(42);
    expect(internals.visiblePanelPrimeRaf).toBeNull();
    expect(internals.viewportHydrationReady).toBe(false);
    expect(internals.viewportHydrationReadyAt).toBe(0);
    expect(internals.viewportTriggersArmed).toBe(false);
    raf.mockClear();
    scroller.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    expect(raf).not.toHaveBeenCalled();
  });

  it('ignores a findings badge chunk that resolves after destroy', async () => {
    const { app, internals } = makeApp();
    const pending = internals.initFindingsBadge();
    app.destroy();
    await pending;
    expect(internals.state.findingsBadge).toBeNull();
  });
});

describe('viewport prime handler', () => {
  function armed() {
    const { app, internals } = makeApp();
    let nextId = 1;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => nextId++);
    internals.viewportHydrationReady = true;
    internals.viewportHydrationReadyAt = 1000;
    internals.viewportTriggersArmed = true;
    return { app, internals, raf };
  }
  const mainContent = (): Element => {
    const el = document.createElement('div');
    el.className = 'main-content';
    document.body.appendChild(el);
    return el;
  };

  it('coalesces repeated scrolls of the dashboard scroller into one frame', () => {
    const { internals, raf } = armed();
    const prime = vi.spyOn(internals, 'primeVisiblePanelData').mockResolvedValue(undefined);
    const load = vi.spyOn(internals.dataLoader, 'loadAllData').mockResolvedValue(undefined);
    const scroller = mainContent();
    internals.handleViewportPrime(scrollFrom(scroller, 2000));
    internals.handleViewportPrime(scrollFrom(scroller, 2001));
    expect(raf).toHaveBeenCalledTimes(1);
    expect(internals.visiblePanelPrimeRaf).toBe(1);
    expect(prime).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();

    raf.mock.calls[0]![0](0);

    expect(internals.visiblePanelPrimeRaf).toBeNull();
    expect(prime).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(false, 'viewport');
    internals.handleViewportPrime(scrollFrom(scroller, 2002));
    expect(raf).toHaveBeenCalledTimes(2);
    expect(internals.visiblePanelPrimeRaf).toBe(2);
  });

  it('ignores nested scrollers, pre-arm timestamps, and a disarmed or unready app', () => {
    const { internals, raf } = armed();
    const nested = document.createElement('div');
    nested.className = 'panel-content';
    document.body.appendChild(nested);
    internals.handleViewportPrime(scrollFrom(nested, 2000));
    expect(raf).not.toHaveBeenCalled();

    internals.handleViewportPrime(scrollFrom(mainContent(), 999));
    expect(raf).not.toHaveBeenCalled();

    internals.viewportTriggersArmed = false;
    internals.handleViewportPrime(scrollFrom(mainContent(), 2000));
    expect(raf).not.toHaveBeenCalled();

    internals.viewportTriggersArmed = true;
    internals.viewportHydrationReady = false;
    internals.handleViewportPrime(scrollFrom(mainContent(), 2000));
    expect(raf).not.toHaveBeenCalled();
  });

  it('stops scheduling once the app is destroyed', () => {
    const { app, internals, raf } = armed();
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    app.destroy();
    internals.handleViewportPrime(scrollFrom(mainContent(), 2000));
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('lazy vessel runtime lifecycle', () => {
  afterEach(() => {
    enableVesselRuntime();
  });

  it('arms the history cleanup on load and tears down a load that lands after destroy', async () => {
    enableVesselRuntime();
    const module = await getMilitaryVesselsModule();
    expect(spies.vessels.startVesselHistoryCleanup).toHaveBeenCalledTimes(1);
    expect(module.isMilitaryVesselTrackingConfigured()).toBe(false);

    stopLoadedVesselHistoryCleanup();
    expect(spies.vessels.stopVesselHistoryCleanup).toHaveBeenCalledTimes(1);
    expect(spies.vessels.disconnectMilitaryVesselStream).toHaveBeenCalledTimes(1);

    await expect(getMilitaryVesselsModule()).rejects.toBeInstanceOf(VesselRuntimeStoppedError);
    // a late call must not re-arm the runtime
    expect(spies.vessels.startVesselHistoryCleanup).toHaveBeenCalledTimes(1);
    expect(spies.vessels.stopVesselHistoryCleanup).toHaveBeenCalledTimes(2);
  });

  it('rejects a load that straddles a teardown, even after the runtime is re-enabled', async () => {
    enableVesselRuntime();
    const pending = getMilitaryVesselsModule();
    stopLoadedVesselHistoryCleanup();
    enableVesselRuntime();
    await expect(pending).rejects.toSatisfy((err: unknown) => isVesselRuntimeStoppedError(err));
    expect(spies.vessels.startVesselHistoryCleanup).not.toHaveBeenCalled();
  });
});

describe('boot failure teardown (text, see header)', () => {
  it('main.ts destroys a partially initialised App when init rejects', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const boot = main.slice(main.indexOf("const app = new App('app');"), main.indexOf('// Debug helpers for geo-convergence testing'));
    expect(boot).toMatch(/\.catch\(\(error: unknown\) => \{[\s\S]*?app\.destroy\(\);[\s\S]*?\} catch \(cleanupError\)/);
  });
});
