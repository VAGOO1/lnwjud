import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRetryableShutdown, DesktopShutdownCoordinator } from '../src/main/desktop-shutdown.js';

describe('Desktop main shutdown coordinator', () => {
  it('allows app quit only after runtime shutdown is confirmed', async () => {
    const closed = deferred<void>();
    const quit = vi.fn();
    const coordinator = new DesktopShutdownCoordinator({ closeRuntime: (): Promise<void> => closed.promise, onDeferred: vi.fn() });

    const shuttingDown = coordinator.requestQuit(quit);
    expect(coordinator.canQuit()).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    closed.resolve();

    await expect(shuttingDown).resolves.toBe('quit');
    expect(coordinator.canQuit()).toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent quit attempts through one owned-runtime shutdown', async () => {
    const closeRuntime = vi.fn(async () => undefined);
    const quit = vi.fn();
    const coordinator = new DesktopShutdownCoordinator({ closeRuntime, onDeferred: vi.fn() });
    await expect(Promise.all([coordinator.requestQuit(quit), coordinator.requestQuit(quit)])).resolves.toEqual(['quit', 'quit']);
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('retries a failed runtime shutdown without re-running a successful shutdown', async () => {
    const closeRuntime = vi.fn()
      .mockRejectedValueOnce(new Error('transient shutdown verification failure'))
      .mockResolvedValueOnce(undefined);
    const close = createRetryableShutdown(closeRuntime);

    await expect(close()).rejects.toThrow('transient shutdown verification failure');
    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
    expect(closeRuntime).toHaveBeenCalledTimes(2);
  });

  it('verifies tunnel shutdown before tearing down unrelated desktop runtime services', () => {
    const source = readFileSync(new URL('../src/main/desktop-services.ts', import.meta.url), 'utf8');
    const closeStart = source.indexOf('const closeRuntime = createRetryableShutdown');
    const tunnelShutdown = source.indexOf('await tunnelController.shutdownForDesktopExit();', closeStart);
    const watcherStop = source.indexOf('stopToolAvailabilityWatch();', closeStart);
    const remoteClose = source.indexOf('await remoteMcpController.close();', closeStart);

    expect(closeStart).toBeGreaterThanOrEqual(0);
    expect(tunnelShutdown).toBeGreaterThan(closeStart);
    expect(watcherStop).toBeGreaterThan(tunnelShutdown);
    expect(remoteClose).toBeGreaterThan(watcherStop);
  });

  it('upgrades an in-flight ordinary quit to quitAndInstall before cleanup completes', async () => {
    const closed = deferred<void>();
    const closeRuntime = vi.fn((): Promise<void> => closed.promise);
    const ordinaryQuit = vi.fn();
    const quitAndInstall = vi.fn();
    const coordinator = new DesktopShutdownCoordinator({ closeRuntime, onDeferred: vi.fn() });

    const ordinary = coordinator.requestQuit(ordinaryQuit);
    const install = coordinator.requestQuit(quitAndInstall, 'install');
    expect(closeRuntime).toHaveBeenCalledOnce();
    expect(ordinaryQuit).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();

    closed.resolve();
    await expect(Promise.all([ordinary, install])).resolves.toEqual(['quit', 'quit']);
    expect(ordinaryQuit).not.toHaveBeenCalled();
    expect(quitAndInstall).toHaveBeenCalledOnce();
  });

  it('defers quit on a stubborn or unverifiable owned child and permits a later retry', async () => {
    const onDeferred = vi.fn();
    const quit = vi.fn();
    const closeRuntime = vi.fn()
      .mockRejectedValueOnce(new Error('Tunnel child liveness is unverifiable; ownership retained'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new DesktopShutdownCoordinator({ closeRuntime, onDeferred });

    await expect(coordinator.requestQuit(quit)).resolves.toBe('deferred');
    expect(coordinator.canQuit()).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    expect(onDeferred).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('ownership retained') }));

    await expect(coordinator.requestQuit(quit)).resolves.toBe('quit');
    expect(coordinator.canQuit()).toBe(true);
    expect(quit).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}
