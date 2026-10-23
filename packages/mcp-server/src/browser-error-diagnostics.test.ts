import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {permissionProfiles} from '@lnwjud/permissions';
import {BrowserCdpBackend, type BrowserCdpProtocol, type BrowserCdpTab} from '../../capabilities/src/browser-cdp-backend.js';
import {mapError, type McpToolResponse} from './result-mapper.js';
import {ToolRegistry} from './tool-registry.js';

const privateDetail = 'DO-NOT-ECHO-PRIVATE-fixture-url-token-expression';
const tab = {id: 'diagnostic-fixture', title: 'Local fixture', url: 'https://fixture.invalid/', webSocketDebuggerUrl: 'FAKE-NOT-OPENED'};
const request = {action: 'evaluate', tab_id: tab.id, userConfirmed: true, parameters: {expression: privateDetail}};
let temp: string;
beforeEach(async () => {temp = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-browser-diag-'));});
afterEach(async () => {
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('lnwjud-browser-diag-')) throw new Error('Unsafe fixture cleanup');
  await rm(resolved, {recursive: true, force: true});
});
function protocol(response: () => unknown): BrowserCdpProtocol {
  return {
    async status(): Promise<{ready: boolean; port: number}> {return {ready: true, port: 0};},
    async listTabs(): Promise<readonly BrowserCdpTab[]> {return [tab];},
    async newTab(): Promise<never> {throw new Error('No real browser is used');},
    async closeTab(): Promise<never> {throw new Error('No real browser is used');},
    async request(): Promise<unknown> {return response();},
  };
}
function diagnostic(response: McpToolResponse): unknown {
  const extra = response.content[1];
  expect(extra?.type).toBe('text');
  return extra?.type === 'text' ? JSON.parse(extra.text) as unknown : undefined;
}
function registry(response: () => unknown, allow = true): ToolRegistry {
  const backend = new BrowserCdpBackend({protocol: protocol(response)});
  return new ToolRegistry({capabilities: {execute: (_tool, input, signal, authorization) => backend.execute(input, signal, authorization)},
    runtimeStatePath: path.join(temp, 'runtime.json')}, {clientId: 'diagnostic-fixture', clientName: 'local fixture'}, {
    profileProvider: () => permissionProfiles.full,
    activeWorkspaceScopeProvider: async () => ({workspaceId: 'local-fixture', rootPath: temp}),
    hostMutationApprovalProvider: async () => allow,
  });
}
const scenarios: readonly [string, string, () => unknown, boolean][] = [
  ['script syntax exception', 'SCRIPT_EXCEPTION', (): unknown => ({result: {exceptionDetails: {text: privateDetail, exception: {description: 'SyntaxError: ' + privateDetail}}}}), false],
  ['application exception', 'SCRIPT_EXCEPTION', (): unknown => ({result: {exceptionDetails: {text: privateDetail, exception: {description: 'ValidationError: ' + privateDetail}}}}), false],
  ['destroyed context response', 'PROTOCOL_ERROR', (): unknown => ({error: {code: -32000, message: 'Execution context was destroyed. ' + privateDetail}}), false],
  ['unrelated protocol error', 'PROTOCOL_ERROR', (): unknown => ({error: {code: -32601, message: privateDetail}}), false],
  ['null response', 'MALFORMED_RESPONSE', (): unknown => null, false],
  ['missing result', 'MALFORMED_RESPONSE', (): unknown => ({privateDetail}), false],
  ['null result', 'MALFORMED_RESPONSE', (): unknown => ({result: null, privateDetail}), false],
  ['invalid result type', 'MALFORMED_RESPONSE', (): unknown => ({result: privateDetail}), false],
  ['request rejection', 'REQUEST_FAILED', (): unknown => {throw new Error(privateDetail);}, true],
];

describe('safe public browser diagnostics', () => {
  it.each(scenarios)('separates %s while preserving the error contract', async (_name, kind, response, recoverable) => {
    let dispatches = 0;
    const result = await registry(() => {dispatches++; return response();}).invoke('dom_cdp', request);
    expect(result).toMatchObject({isError: true, structuredContent: {error: {code: 'INTERNAL_ERROR', message: 'Operation failed', recoverable,
      details: {browserFailureKind: kind, effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0}}}});
    expect(result.content[0]).toEqual({type: 'text', text: 'INTERNAL_ERROR: Operation failed'});
    expect(diagnostic(result)).toEqual({browserFailureKind: kind, effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0});
    expect(JSON.stringify(result)).not.toContain(privateDetail);
    expect(dispatches).toBe(1);
  });

  it('adds only the diagnostic category to a read-only query failure', async () => {
    const result = await registry(() => {throw new Error(privateDetail);}).invoke('dom_cdp', {action: 'query', tab_id: tab.id, parameters: {selector: 'main'}});
    expect(result).toMatchObject({isError: true, structuredContent: {error: {details: {browserFailureKind: 'REQUEST_FAILED'}}}});
    expect(diagnostic(result)).toEqual({browserFailureKind: 'REQUEST_FAILED'});
    expect(JSON.stringify(result)).not.toContain('effectState');
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });

  it('retains batch uncertainty without relabeling it as a single mutation', async () => {
    const result = await registry(() => {throw new Error(privateDetail);}).invoke('dom_cdp', {tab_id: tab.id, userConfirmed: true,
      steps: [{action: 'evaluate', parameters: request.parameters}]});
    expect(result).toMatchObject({isError: true, structuredContent: {error: {details: {browserBatch: 1, browserFailureKind: 'REQUEST_FAILED',
      effectState: 'UNKNOWN', automaticReplayAllowed: 0}}}});
    expect(JSON.stringify(result)).not.toContain('browserSingle');
  });

  it('preserves denial with zero dispatch and no browser diagnostics', async () => {
    let dispatches = 0;
    const result = await registry(() => {dispatches++;}, false).invoke('dom_cdp', request);
    expect(result).toMatchObject({isError: true, structuredContent: {error: {code: 'PERMISSION_DENIED'}}});
    expect(result.content).toHaveLength(1);
    expect(dispatches).toBe(0);
  });

  it('leaves a normal successful response unchanged', async () => {
    const result = await registry(() => ({result: {result: {value: {fixtureSuccess: true}}}})).invoke('dom_cdp', request);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({fixtureSuccess: true});
    expect(result.content).toEqual([{type: 'text', text: '{"fixtureSuccess":true}'}]);
  });

  it('copies only allowlisted diagnostic values into the additional text', () => {
    const result = mapError({code: 'INTERNAL_ERROR', message: privateDetail, recoverable: true,
      details: {browserFailureKind: 'SCRIPT_EXCEPTION', effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0,
        expression: privateDetail, url: privateDetail, rawException: privateDetail}});
    expect(result.content[0]).toEqual({type: 'text', text: 'INTERNAL_ERROR: Operation failed'});
    expect(diagnostic(result)).toEqual({browserFailureKind: 'SCRIPT_EXCEPTION', effectState: 'UNKNOWN', inspectionRequired: 1, automaticReplayAllowed: 0});
    expect(JSON.stringify(result.content)).not.toContain(privateDetail);
  });

  it('drops invalid diagnostic states and retry values from the additional text', () => {
    const result = mapError({code: 'INTERNAL_ERROR', message: 'fixture', recoverable: false,
      details: {browserFailureKind: 'REQUEST_FAILED', effectState: privateDetail, inspectionRequired: 99, automaticReplayAllowed: 1}});
    expect(diagnostic(result)).toEqual({browserFailureKind: 'REQUEST_FAILED'});
  });

  it('preserves proven no-dispatch evidence when it accompanies a valid diagnostic', () => {
    const result = mapError({code: 'INTERNAL_ERROR', message: 'fixture', recoverable: false,
      details: {browserFailureKind: 'REQUEST_FAILED', effectState: 'NO_MUTATION_DISPATCHED', inspectionRequired: 0, automaticReplayAllowed: 0}});
    expect(diagnostic(result)).toEqual({browserFailureKind: 'REQUEST_FAILED', effectState: 'NO_MUTATION_DISPATCHED', inspectionRequired: 0, automaticReplayAllowed: 0});
  });

  it.each(['UNKNOWN_KIND', privateDetail])('ignores an unrecognized category %s', kind => {
    const result = mapError({code: 'INTERNAL_ERROR', message: 'fixture', recoverable: false, details: {browserFailureKind: kind}});
    expect(result.content).toEqual([{type: 'text', text: 'INTERNAL_ERROR: Operation failed'}]);
  });

  it('does not attach browser diagnostics to a permission denial', () => {
    const result = mapError({code: 'PERMISSION_DENIED', message: 'Fixture denied', recoverable: false, details: {browserFailureKind: 'REQUEST_FAILED'}});
    expect(result.content).toEqual([{type: 'text', text: 'PERMISSION_DENIED: Fixture denied'}]);
  });
});
