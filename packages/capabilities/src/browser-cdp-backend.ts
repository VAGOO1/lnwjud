import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, isApplicationAuthorized, isFullBypassAuthorization, ok, type AppError, type InvocationAuthorization, type Result } from '@lnwjud/domain';
import type { CapabilityBackend } from './local-capability-service.js';
import { BrowserCdpUnavailableError, NodeBrowserCdpProtocol } from './browser-cdp-protocol.js';
import { readCapabilityActiveWorkspaceRoot } from './task-ownership.js';
import { BrowserDebugStreamService } from './browser-debug-stream.js';
import { isProtectedBrowserUrl } from './browser-debug-observation.js';

export interface BrowserCdpTab {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

export interface BrowserCdpProtocol {
  status(signal?: AbortSignal): Promise<{
    readonly ready: boolean;
    readonly port: number;
    readonly browserInstalled?: boolean;
    readonly readinessReason?: 'browser_ready' | 'browser_not_installed' | 'browser_not_running' | 'probe_failed';
  }>;
  listTabs(signal?: AbortSignal): Promise<readonly BrowserCdpTab[]>;
  newTab(url: string, signal?: AbortSignal): Promise<BrowserCdpTab>;
  closeTab(tabId: string, signal?: AbortSignal): Promise<unknown>;
  request(tabId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  openEventChannel?(tabId: string, onEvent: (method: string, params: unknown) => void, onDisconnected: (closureConfirmed: boolean) => void, signal?: AbortSignal): Promise<BrowserCdpEventChannel>;
}

export interface BrowserCdpEventChannel {
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserCdpBackendOptions {
  readonly protocol?: BrowserCdpProtocol;
  readonly launcher?: (url: string | undefined, signal?: AbortSignal) => Promise<Result<unknown>>;
}

type BrowserAction = 'launch' | 'status' | 'list_tabs' | 'new_tab' | 'activate_tab' | 'set_files' | 'close_tab' | 'navigate' | 'evaluate' | 'query' | 'click' | 'type' | 'wait' | 'screenshot';

interface BrowserRequest {
  readonly action?: BrowserAction;
  readonly parameters: Record<string, unknown>;
  readonly steps?: readonly { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[];
  readonly tabId?: string;
  readonly activeWorkspaceRoot?: string;
  readonly allowProtectedTabAction: boolean;
  readonly timeoutSeconds: number;
  readonly dryRun: boolean;
  readonly userConfirmed: boolean;
  /** Internal, invocation-local evidence; never accepted from caller input. */
  readonly onMutationDispatch?: () => void;
}

type StructuredQueryField = 'text' | 'value' | 'tag' | 'disabled' | 'checked' | 'visible' | 'attributes' | 'options';

interface StructuredQueryExpectation {
  readonly count: number;
  readonly text?: string;
  readonly value?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly visible?: boolean;
  readonly notContains?: string;
}

interface StructuredQueryItem {
  readonly key: string;
  readonly selector: string;
  readonly fields: readonly StructuredQueryField[];
  readonly attributes: readonly string[];
  readonly expect: StructuredQueryExpectation;
}

interface StructuredQueryRequest {
  readonly page: { readonly origin: string; readonly pathname: string; readonly title: string; readonly search?: string };
  readonly queries: readonly StructuredQueryItem[];
}

const BROWSER_ACTIONS: readonly BrowserAction[] = ['launch', 'status', 'list_tabs', 'new_tab', 'activate_tab', 'set_files', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot'];
const TARGET_SCOPED_ACTIONS = new Set<BrowserAction>(['activate_tab', 'set_files', 'close_tab', 'navigate', 'evaluate', 'query', 'click', 'type', 'wait', 'screenshot']);
const PROTECTED_TAB_MUTATIONS = new Set<BrowserAction>(['set_files', 'close_tab', 'navigate', 'evaluate', 'click', 'type']);
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_STRUCTURED_QUERY_ITEMS = 100;
const MAX_STRUCTURED_QUERY_OUTPUT_CHARS = 65_536;
const STRUCTURED_QUERY_FIELDS = new Set<StructuredQueryField>(['text', 'value', 'tag', 'disabled', 'checked', 'visible', 'attributes', 'options']);
const SAFE_STRUCTURED_QUERY_ATTRIBUTES = /^(?:id|name|role|type|placeholder|autocomplete|aria-[a-z-]+|data-[a-z0-9-]+)$/;

export class BrowserCdpBackend implements CapabilityBackend {
  private readonly protocol: BrowserCdpProtocol;
  private readonly launcher: ((url: string | undefined, signal?: AbortSignal) => Promise<Result<unknown>>) | undefined;
  private startInFlight: Promise<Result<unknown>> | null = null;
  private readonly debugStreams: BrowserDebugStreamService;

  public constructor(options: BrowserCdpBackendOptions = {}) {
    this.protocol = options.protocol ?? new NodeBrowserCdpProtocol();
    this.launcher = options.launcher;
    this.debugStreams = new BrowserDebugStreamService(this.protocol, async (tabId, input, signal) => {
      let tabs: readonly BrowserCdpTab[];
      try { tabs = await this.protocol.listTabs(signal); } catch (error) {
        if (error instanceof BrowserCdpUnavailableError) return err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is unavailable', true));
        throw error;
      }
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return err(appError('FILE_NOT_FOUND', 'The selected browser observation tab was not found', true));
      if (isProtectedAgentTab(tab) && !(isRecord(input) && input.allow_protected_tab_action === true && input.userConfirmed === true)) return err(appError('PERMISSION_DENIED', 'Protected ChatGPT tab observations require an explicit override and confirmation'));
      return ok(undefined);
    });
  }

  public async ensureStarted(url?: string, signal?: AbortSignal, onMutationDispatch?: () => void): Promise<Result<unknown>> {
    const current = await this.protocol.status(signal);
    if (current.ready) return ok({ ready: true, port: current.port, launched: false });
    if (this.launcher === undefined) return err(appError('INTERNAL_ERROR', 'Browser launcher is not configured', true));
    let launch = this.startInFlight;
    if (launch === null) {
      onMutationDispatch?.();
      launch = this.launcher(url);
      this.startInFlight = launch;
      void launch.then(
        () => { if (this.startInFlight === launch) this.startInFlight = null; },
        () => { if (this.startInFlight === launch) this.startInFlight = null; },
      );
    }
    return waitForBrowserStart(launch, signal);
  }

  /**
   * Reads the managed browser's tabs only when it is already running.
   * Like the read-only list_tabs action, it never calls the launcher and is
   * safe for approval presentation before user consent.
   */
  public async listTabsIfRunning(signal?: AbortSignal): Promise<Result<{ readonly ready: boolean; readonly tabs: readonly BrowserCdpTab[] }>> {
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    try {
      const status = await this.protocol.status(signal);
      const statusAborted = cancellationResult(signal);
      if (statusAborted !== null) return statusAborted;
      if (!status.ready) return ok({ ready: false, tabs: [] });
      const tabs = await this.protocol.listTabs(signal);
      return cancellationResult(signal) ?? ok({ ready: true, tabs });
    } catch {
      return cancellationResult(signal) ?? err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is unavailable', true));
    }
  }

  public async execute(input: unknown, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    if (isRecord(input) && input.action === 'debug_stream') {
      try { return await this.debugStreams.execute(input, signal); } catch { return cancellationResult(signal) ?? err(appError('INTERNAL_ERROR', 'Browser observation operation failed', true)); }
    }
    const aborted = cancellationResult(signal);
    if (aborted !== null) {
      const parsed = parseBrowserRequest(input);
      return parsed.ok ? singleBrowserOutcome(aborted, parsed.value, false) : aborted;
    }
    const parsed = parseBrowserRequest(input);
    if (!parsed.ok) return parsed;
    let mutationDispatched = false;
    const request: BrowserRequest = {...parsed.value, onMutationDispatch: () => { mutationDispatched = true; }};
    try {
      const result = request.steps !== undefined
        ? await this.executeSteps(request, signal, authorization)
        : request.action === undefined
          ? err(appError('INVALID_INPUT', 'DOM action is required'))
          : await this.executeAction(request, request.action, request.parameters, signal, authorization);
      return request.steps !== undefined ? result : singleBrowserOutcome(cancellationResult(signal) ?? result, request, mutationDispatched);
    } catch {
      const result = cancellationResult(signal) ?? err(appError('INTERNAL_ERROR', 'Browser CDP operation failed', true));
      return request.steps !== undefined ? result : singleBrowserOutcome(result, request, mutationDispatched);
    }
  }

  public close(): Promise<void> { return this.debugStreams.close(); }

  private async executeSteps(request: BrowserRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<unknown>> {
    const values: unknown[] = [];
    let mutationStarted = false;
    for (const step of request.steps ?? []) {
      const aborted = cancellationResult(signal);
      if (aborted !== null && !aborted.ok) return browserBatchFailure(aborted.error, values.length, step.action, mutationStarted);
      mutationStarted ||= !isReadOnlyBrowserAction(step.action, step.parameters);
      let result: Result<unknown>;
      try { result = await this.executeAction(request, step.action, step.parameters, signal, authorization); }
      catch { const cancelled = cancellationResult(signal);return browserBatchFailure(cancelled !== null && !cancelled.ok ? cancelled.error : appError('INTERNAL_ERROR', 'Browser batch transport failed; inspect partial state'), values.length, step.action, mutationStarted); }
      if (!result.ok) return browserBatchFailure(result.error, values.length, step.action, mutationStarted);
      // Legacy single-action DOM responses expose failures inside value.
      // A batch must stop before dispatching another mutation after such a failure.
      const targetFailed = (step.action === 'type' || step.action === 'click' || step.action === 'query') && isRecord(result.value) && result.value.ok === false;
      const waitTimedOut = step.action === 'wait' && isRecord(result.value) && result.value.ready === false && result.value.timed_out === true;
      if (targetFailed || waitTimedOut) {
        const reason = isRecord(result.value) && typeof result.value.error === 'string' ? result.value.error : waitTimedOut ? 'Wait timed out' : 'DOM target action failed';
        return browserBatchFailure(appError('INVALID_INPUT', `Browser batch step ${values.length + 1} (${step.action}) failed after ${values.length} completed step(s): ${reason}. Earlier steps may have changed the page; inspect before retrying.`), values.length, step.action, mutationStarted);
      }
      if (!request.dryRun && (step.action === 'type' || step.action === 'click' || step.action === 'query') && (!isRecord(result.value) || result.value.ok !== true)) {
        return browserBatchFailure(appError('INTERNAL_ERROR', `Browser batch step ${values.length + 1} (${step.action}) returned an invalid target response after ${values.length} completed step(s). Inspect before retrying.`), values.length, step.action, mutationStarted);
      }
      values.push(result.value);
      const abortedAfterStep = cancellationResult(signal);
      if (abortedAfterStep !== null && !abortedAfterStep.ok) return browserBatchFailure(abortedAfterStep.error, values.length, step.action, mutationStarted);
    }
    return ok({ steps: values });
  }

  private async executeAction(
    request: BrowserRequest,
    action: BrowserAction,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
    authorization?: InvocationAuthorization,
  ): Promise<Result<unknown>> {
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    if (request.dryRun) return ok({ dry_run: true, action, parameters, ...(request.tabId === undefined ? {} : { tab_id: request.tabId }) });
    if (!isReadOnlyBrowserAction(action, parameters) && !isApplicationAuthorized(authorization, request.userConfirmed)) {
      return err(appError('PERMISSION_REQUIRED', 'Browser actions that can change local or remote state require explicit user confirmation'));
    }
    if (action !== 'status' && action !== 'launch' && action !== 'list_tabs' && action !== 'query' && action !== 'wait' && action !== 'screenshot') {
      const started = await this.ensureStarted(undefined, signal, request.onMutationDispatch);
      if (!started.ok) return started;
    }
    switch (action) {
      case 'status': return ok(await this.protocol.status(signal));
      case 'launch': return this.ensureStarted(readString(parameters, 'url'), signal, request.onMutationDispatch);
      case 'list_tabs': return this.listTabsWithoutLaunching(signal);
      case 'new_tab':
        request.onMutationDispatch?.();
        return ok(await this.protocol.newTab(readString(parameters, 'url') ?? 'about:blank', signal));
      case 'activate_tab': return this.withTab(request, action, async (tab) => {
        request.onMutationDispatch?.();
        await this.protocol.request(tab.id, 'Page.bringToFront', {}, signal);
        return ok({ activated: true, tab_id: tab.id });
      }, signal);
      case 'set_files': return this.withTab(request, action, async (tab) => this.setFilesProtocol(tab.id, parameters, request.activeWorkspaceRoot, authorization, signal, request.onMutationDispatch), signal);
      case 'close_tab': return this.withTab(request, action, async (tab) => { request.onMutationDispatch?.(); return ok(await this.protocol.closeTab(tab.id, signal)); }, signal);
      case 'navigate': return this.withTab(request, action, async (tab) => this.navigateProtocol(tab.id, readString(parameters, 'url') ?? '', signal, request.onMutationDispatch), signal);
      case 'evaluate': {
        const expression = readString(parameters, 'expression');
        return expression === undefined
          ? err(appError('INVALID_INPUT', 'JavaScript expression is required'))
          : this.withTab(request, action, async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, signal, request.onMutationDispatch), signal);
      }
      case 'query': return this.queryProtocol(request, parameters, signal);
      case 'click': return this.withTab(request, action, async (tab) => {
        const mouseEventSequence = parameters.mouse_event_sequence === true;
        const mouseDownOnly = parameters.mouse_event === 'mousedown';
        if ((parameters.mouse_event_sequence !== undefined && typeof parameters.mouse_event_sequence !== 'boolean') || (parameters.mouse_event !== undefined && !mouseDownOnly) || (mouseEventSequence && mouseDownOnly)) return err(appError('INVALID_INPUT', 'Invalid or conflicting mouse event mode'));
        const expectedText = readString(parameters, 'expected_text');
        if ((mouseEventSequence || mouseDownOnly) && (expectedText === undefined || expectedText.trim().length === 0 || expectedText.length > 2048)) {
          return err(appError('INVALID_INPUT', 'mouse_event_sequence requires a non-empty bounded parameters.expected_text'));
        }
        return this.evaluateProtocol(tab.id, 'Runtime.evaluate', {
          expression: clickScript(readString(parameters, 'selector') ?? '', mouseEventSequence, expectedText, mouseDownOnly),
          returnByValue: true,
          awaitPromise: true,
        }, signal, request.onMutationDispatch);
      }, signal);
      case 'type': return this.withTab(request, action, async (tab) => this.typeProtocol(tab.id, parameters, signal, request.onMutationDispatch), signal);
      case 'wait': return this.waitFor(request, parameters, signal);
      case 'screenshot': return this.withExistingTab(request, action, async (tab) => {
        const result = await this.protocol.request(tab.id, 'Page.captureScreenshot', { format: 'png' }, signal);
        const data = readScreenshotData(result);
        return data === undefined ? err(appError('INTERNAL_ERROR', 'Browser screenshot response was invalid', true)) : ok({ format: 'png', data_base64: data });
      }, signal);
    }
  }

  private async queryProtocol(request: BrowserRequest, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    const structured = parseStructuredQueryRequest(parameters);
    if (!structured.ok) return structured;
    return this.withExistingTab(request, 'query', async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', {
      expression: structured.value === undefined
        ? queryScript(readString(parameters, 'selector') ?? '')
        : structuredQueryScript(structured.value),
      returnByValue: true,
      awaitPromise: true,
    }, signal), signal);
  }

  private async listTabsWithoutLaunching(signal?: AbortSignal): Promise<Result<unknown>> {
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    try {
      const status = await this.protocol.status(signal);
      if (!status.ready) return err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is not running; list_tabs does not launch it', true));
      const afterStatus = cancellationResult(signal);
      if (afterStatus !== null) return afterStatus;
      const tabs = await this.protocol.listTabs(signal);
      return cancellationResult(signal) ?? ok({ tabs });
    } catch {
      return cancellationResult(signal) ?? err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is unavailable', true));
    }
  }

  private async setFilesProtocol(
    tabId: string,
    parameters: Record<string, unknown>,
    activeWorkspaceRoot: string | undefined,
    authorization: InvocationAuthorization | undefined,
    signal?: AbortSignal,
    onMutationDispatch?: () => void,
  ): Promise<Result<unknown>> {
    const selector = readString(parameters, 'selector')?.trim();
    const files = readStringArray(parameters, 'files');
    if (selector === undefined || selector.length === 0) return err(appError('INVALID_INPUT', 'File upload requires parameters.selector'));
    if (files === undefined || files.length === 0) return err(appError('INVALID_INPUT', 'File upload requires a non-empty parameters.files array'));

    const fullBypass = isFullBypassAuthorization(authorization);
    const root = activeWorkspaceRoot === undefined ? null : await canonicalDirectory(activeWorkspaceRoot);
    if (!fullBypass && root === null) return err(appError('PATH_OUTSIDE_WORKSPACE', 'Browser file upload requires an available Active Project root'));

    const canonicalFiles: string[] = [];
    for (const file of files) {
      const canonical = await canonicalExistingFile(file);
      if (canonical === null) return err(appError('INVALID_INPUT', 'Browser file upload target is unavailable'));
      if (!fullBypass && root !== null && !isWithinPath(root, canonical)) {
        return err(appError('PATH_OUTSIDE_WORKSPACE', 'Browser file upload target is outside the Active Project'));
      }
      canonicalFiles.push(canonical);
    }

    try {
      const documentResponse = await this.protocol.request(tabId, 'DOM.getDocument', {}, signal);
      const rootNodeId = readProtocolNodeId(documentResponse, 'root');
      if (rootNodeId === undefined) return err(appError('INTERNAL_ERROR', 'Browser DOM document response was invalid', true));
      const queryResponse = await this.protocol.request(tabId, 'DOM.querySelector', { nodeId: rootNodeId, selector }, signal);
      const nodeId = readProtocolNumber(queryResponse, 'nodeId');
      if (nodeId === undefined || nodeId <= 0) return err(appError('INVALID_INPUT', 'Browser file input selector did not match an element'));
      onMutationDispatch?.();
      await this.protocol.request(tabId, 'DOM.setFileInputFiles', { files: canonicalFiles, nodeId }, signal);
      return ok({ files_set: true, tab_id: tabId, file_count: canonicalFiles.length });
    } catch {
      return err(appError('INTERNAL_ERROR', 'Browser CDP file upload failed', true));
    }
  }

  private async waitFor(request: BrowserRequest, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Result<unknown>> {
    if (!hasOnlyKeys(parameters, ['selector', 'expression', 'poll_interval_seconds'])) return err(appError('INVALID_INPUT', 'Wait contains an unknown parameter'));
    const pollInterval = parameters.poll_interval_seconds ?? 0.1;
    if (typeof pollInterval !== 'number' || !Number.isFinite(pollInterval) || pollInterval < 0.01 || pollInterval > 1) return err(appError('INVALID_INPUT', 'Wait poll interval must be between 0.01 and 1 second'));
    const selector = readString(parameters, 'selector');
    const expression = readString(parameters, 'expression');
    if ((selector === undefined) === (expression === undefined)) return err(appError('INVALID_INPUT', 'Wait requires exactly one of selector or expression'));
    const deadline = Date.now() + Math.min(request.timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000;
    while (Date.now() <= deadline) {
      const aborted = cancellationResult(signal);
      if (aborted !== null) return aborted;
      const result = await this.withExistingTab(request, selector === undefined ? 'evaluate' : 'wait', async (tab) => this.evaluateProtocol(tab.id, 'Runtime.evaluate', {
        expression: selector === undefined ? expression! : `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
        returnByValue: true,
        awaitPromise: true,
      }, signal, selector === undefined ? request.onMutationDispatch : undefined), signal);
      if (!result.ok) return result;
      if (result.value === true) return ok({ ready: true });
      await delay(pollInterval * 1000, signal);
    }
    return ok({ ready: false, timed_out: true });
  }

  private async withTab(
    request: BrowserRequest,
    action: BrowserAction,
    callback: (tab: BrowserCdpTab) => Promise<Result<unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    if (request.tabId === undefined) {
      return err(appError('INVALID_INPUT', `${action} requires tab_id; call list_tabs or new_tab first`));
    }
    const tabs = await this.protocol.listTabs(signal);
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    const tab = tabs.find((candidate) => candidate.id === request.tabId);
    if (tab === undefined) return err(appError('INVALID_INPUT', 'The requested managed Chrome tab was not found'));
    const protectedDecision = authorizeProtectedTabAction(request, action, tab);
    if (!protectedDecision.ok) return protectedDecision;
    return callback(tab);
  }

  private async withExistingTab(
    request: BrowserRequest,
    action: BrowserAction,
    callback: (tab: BrowserCdpTab) => Promise<Result<unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<unknown>> {
    try {
      const status = await this.protocol.status(signal);
      const afterStatus = cancellationResult(signal);
      if (afterStatus !== null) return afterStatus;
      if (!status.ready) return err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is not running; query does not launch it', true));
    } catch {
      return cancellationResult(signal) ?? err(appError('PROCESS_NOT_FOUND', 'The managed local browser CDP endpoint is unavailable', true));
    }
    const aborted = cancellationResult(signal);
    if (aborted !== null) return aborted;
    return this.withTab(request, action, callback, signal);
  }

  private async navigateProtocol(tabId: string, url: string, signal?: AbortSignal, onMutationDispatch?: () => void): Promise<Result<unknown>> {
    try {
      onMutationDispatch?.();
      return readNavigationResult(await this.protocol.request(tabId, 'Page.navigate', { url }, signal));
    } catch {
      return err(appError('INTERNAL_ERROR', 'Browser CDP navigation request failed', true));
    }
  }

  private async evaluateProtocol(tabId: string, method: string, params: Record<string, unknown>, signal?: AbortSignal, onMutationDispatch?: () => void): Promise<Result<unknown>> {
    onMutationDispatch?.();
    let response: unknown;
    try {
      response = await this.protocol.request(tabId, method, params, signal);
    } catch {
      // A rejected request is not proof of a transport fault or of no effect.
      return browserEvaluationFailure('REQUEST_FAILED', 'Browser CDP request failed', true);
    }
    const failureMessage = 'Browser CDP evaluation failed; the page may have changed. Inspect before retrying.';
    if (!isRecord(response)) return browserEvaluationFailure('MALFORMED_RESPONSE', failureMessage);
    if (isRecord(response.error)) return browserEvaluationFailure('PROTOCOL_ERROR', failureMessage);
    if (!isRecord(response.result)) return browserEvaluationFailure('MALFORMED_RESPONSE', failureMessage);
    if ('exceptionDetails' in response.result) return browserEvaluationFailure('SCRIPT_EXCEPTION', failureMessage);
    return ok(readCdpValue(response));
  }

  private async typeProtocol(tabId: string, parameters: Record<string, unknown>, signal?: AbortSignal, onMutationDispatch?: () => void): Promise<Result<unknown>> {
    const selector = readString(parameters, 'selector');
    const text = readString(parameters, 'text') ?? '';
    const clear = parameters.clear === true;

    const inspectScript = `(() => {
      const el = ${selector !== undefined && selector.length > 0 ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
      if (!el || (el === document.body && ${selector === undefined || selector.length === 0})) return { ok: false, error: 'Element not found' };
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      if (typeof el.focus === 'function') {
        el.focus();
      }
      const isInputOrTextarea = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const isContentEditable = !!(
        el.isContentEditable
        || el.getAttribute('contenteditable') === 'true'
        || el.getAttribute('contenteditable') === ''
        || el.classList.contains('ProseMirror')
        || el.getAttribute('role') === 'textbox'
      );
      if (isContentEditable || !isInputOrTextarea) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          if (${clear}) {
            range.selectNodeContents(el);
          } else {
            range.selectNodeContents(el);
            range.collapse(false);
          }
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return { ok: true, isContentEditable: true, tag: el.tagName, text: el.innerText ?? el.textContent ?? '' };
      }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) {
        setter.call(el, ${JSON.stringify(text)});
      } else {
        el.value = ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, isContentEditable: false, value: el.value, tag: el.tagName };
    })()`;

    const inspectResult = await this.evaluateProtocol(tabId, 'Runtime.evaluate', {
      expression: inspectScript,
      returnByValue: true,
      awaitPromise: true,
    }, signal, onMutationDispatch);

    if (!inspectResult.ok) return inspectResult;
    const inspectValue = inspectResult.value;
    if (isRecord(inspectValue) && inspectValue.ok === false) {
      return ok({ ok: false, error: inspectValue.error ?? 'Element not found', ...(selector === undefined ? {} : { selector }) });
    }
    if (!isRecord(inspectValue) || inspectValue.ok !== true || typeof inspectValue.isContentEditable !== 'boolean'
      || (inspectValue.isContentEditable ? typeof inspectValue.text !== 'string' : typeof inspectValue.value !== 'string')) {
      return err(appError('INTERNAL_ERROR', 'Browser CDP typing target returned an invalid response. Inspect before retrying.'));
    }

    if (isRecord(inspectValue) && inspectValue.isContentEditable === true) {
      try {
        await this.protocol.request(tabId, 'Input.insertText', { text }, signal);
      } catch {
        return err(appError('INTERNAL_ERROR', 'Browser CDP Input.insertText failed', true));
      }

      const verifyScript = `(() => {
        const el = ${selector !== undefined && selector.length > 0 ? `document.querySelector(${JSON.stringify(selector)})` : 'document.activeElement'};
        if (!el) return { ok: false, error: 'Element not found after typing' };
        return { ok: true, text: el.innerText ?? el.textContent ?? '' };
      })()`;
      const verifyResult = await this.evaluateProtocol(tabId, 'Runtime.evaluate', {
        expression: verifyScript,
        returnByValue: true,
        awaitPromise: true,
      }, signal);
      if (!verifyResult.ok) return verifyResult;
      const verifyValue = verifyResult.value;
      if (!isRecord(verifyValue) || verifyValue.ok === false || typeof verifyValue.text !== 'string') {
        return err(appError('INTERNAL_ERROR', 'Browser CDP text insertion could not be verified', true));
      }

      const beforeText = typeof inspectValue.text === 'string' ? inspectValue.text : '';
      const verifiedText = verifyValue.text;
      const mutationObserved = text.length === 0
        ? (!clear || verifiedText.length === 0)
        : verifiedText !== beforeText || (clear && verifiedText === text);
      if (!mutationObserved) {
        return err(appError('INTERNAL_ERROR', 'Browser CDP text insertion did not update the target', true));
      }

      return ok({
        ok: true,
        typed: true,
        isContentEditable: true,
        tag: inspectValue.tag,
        text: verifiedText,
        value: verifiedText,
      });
    }

    const value = isRecord(inspectValue) && 'value' in inspectValue ? inspectValue.value : text;
    return ok({
      ok: true,
      typed: true,
      isContentEditable: false,
      value,
      text: typeof value === 'string' ? value : text,
    });
  }
}

type BrowserFailureKind = 'SCRIPT_EXCEPTION' | 'PROTOCOL_ERROR' | 'MALFORMED_RESPONSE' | 'REQUEST_FAILED';

function browserEvaluationFailure(kind: BrowserFailureKind, message: string, recoverable = false): Result<never> {
  // Only a fixed category crosses this boundary; never copy protocol messages,
  // script exceptions, expressions or page data into the diagnostic.
  return err({...appError('INTERNAL_ERROR', message, recoverable), details: {browserFailureKind: kind}});
}

function singleBrowserOutcome(result: Result<unknown>, request: BrowserRequest, mutationDispatched: boolean): Result<unknown> {
  if (result.ok || request.steps !== undefined || request.action === undefined || request.dryRun || isReadOnlyBrowserAction(request.action, request.parameters)) return result;
  return err({...result.error, details: {...result.error.details, browserSingle: 1, failedAction: request.action,
    effectState: mutationDispatched ? 'UNKNOWN' : 'NO_MUTATION_DISPATCHED',
    inspectionRequired: mutationDispatched ? 1 : 0, automaticReplayAllowed: 0}});
}

function browserBatchFailure(error: AppError, completedSteps: number, failedAction: BrowserAction, mutationStarted: boolean): Result<never> {
  return err({ ...error, details: { ...error.details, browserBatch: 1, completedSteps, failedAction, effectState: mutationStarted ? 'UNKNOWN' : 'NO_MUTATION_DISPATCHED', inspectionRequired: 1, automaticReplayAllowed: 0 } });
}

function parseBrowserRequest(value: unknown): Result<BrowserRequest> {
  if (!isRecord(value)) return err(appError('INVALID_INPUT', 'DOM input must be an object'));
  const actionValue = value.action;
  const action = actionValue === undefined ? undefined : isBrowserAction(actionValue) ? actionValue : null;
  if (action === null) return err(appError('INVALID_INPUT', 'DOM action is invalid'));

  const parametersValue = value.parameters;
  const rawParameters = parametersValue === undefined ? {} : parametersValue;
  if (!isRecord(rawParameters)) return err(appError('INVALID_INPUT', 'DOM parameters must be an object'));

  const topLevelTabId = parseOptionalTabId(value.tab_id);
  if (!topLevelTabId.ok) return topLevelTabId;
  const nestedTabId = parseOptionalTabId(rawParameters.tab_id);
  if (!nestedTabId.ok) return nestedTabId;
  if (topLevelTabId.value !== undefined && nestedTabId.value !== undefined && topLevelTabId.value !== nestedTabId.value) {
    return err(appError('INVALID_INPUT', 'Conflicting top-level and parameters.tab_id values'));
  }
  const tabId = topLevelTabId.value ?? nestedTabId.value;
  const parameters = nestedTabId.value === undefined ? rawParameters : omitKey(rawParameters, 'tab_id');
  const activeWorkspaceRoot = readCapabilityActiveWorkspaceRoot(value);

  const allowProtectedTabAction = value.allow_protected_tab_action === undefined ? false : value.allow_protected_tab_action;
  if (typeof allowProtectedTabAction !== 'boolean') return err(appError('INVALID_INPUT', 'Protected-tab override flag is invalid'));
  const timeoutSeconds = value.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : value.timeout_seconds;
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0.1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) return err(appError('INVALID_INPUT', 'DOM timeout is invalid'));
  const dryRun = value.dry_run === undefined ? false : value.dry_run;
  if (typeof dryRun !== 'boolean') return err(appError('INVALID_INPUT', 'Dry-run flag is invalid'));

  const stepsValue = value.steps;
  if (stepsValue !== undefined && (!Array.isArray(stepsValue) || stepsValue.length < 1 || stepsValue.length > 100)) return err(appError('INVALID_INPUT', 'DOM steps must contain 1 to 100 items'));
  if ((action === undefined) === (stepsValue === undefined)) return err(appError('INVALID_INPUT', 'Provide exactly one of DOM action or steps'));

  const normalizedSteps: { readonly action: BrowserAction; readonly parameters: Record<string, unknown> }[] = [];
  if (stepsValue !== undefined) {
    if (tabId === undefined) return err(appError('INVALID_INPUT', 'DOM steps require top-level tab_id; call list_tabs or new_tab first'));
    if (nestedTabId.value !== undefined) return err(appError('INVALID_INPUT', 'DOM steps require top-level tab_id, not parameters.tab_id'));
    for (const step of stepsValue) {
      if (!isRecord(step) || !isBrowserAction(step.action)) return err(appError('INVALID_INPUT', 'DOM step is invalid'));
      const stepParameters = step.parameters === undefined ? {} : step.parameters;
      if (!isRecord(stepParameters)) return err(appError('INVALID_INPUT', 'DOM step parameters are invalid'));
      if ('tab_id' in stepParameters) return err(appError('INVALID_INPUT', 'Use the top-level tab_id for the whole DOM steps batch'));
      normalizedSteps.push({ action: step.action, parameters: stepParameters });
    }
  }

  const actions = normalizedSteps.length > 0 ? normalizedSteps.map((step) => step.action) : action === undefined ? [] : [action];
  if (actions.some((candidate) => TARGET_SCOPED_ACTIONS.has(candidate)) && tabId === undefined) {
    return err(appError('INVALID_INPUT', 'Target-scoped DOM actions require tab_id; call list_tabs or new_tab first'));
  }

  return ok({
    ...(action === undefined ? {} : { action }),
    parameters,
    ...(stepsValue === undefined ? {} : { steps: normalizedSteps }),
    ...(tabId === undefined ? {} : { tabId }),
    ...(activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot }),
    allowProtectedTabAction,
    timeoutSeconds,
    dryRun,
    userConfirmed: value.userConfirmed === true,
  });
}

function parseOptionalTabId(value: unknown): Result<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) return err(appError('INVALID_INPUT', 'Tab ID is invalid'));
  return ok(value.trim());
}

function omitKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function authorizeProtectedTabAction(request: BrowserRequest, action: BrowserAction, tab: BrowserCdpTab): Result<void> {
  if (!PROTECTED_TAB_MUTATIONS.has(action) || !isProtectedAgentTab(tab)) return ok(undefined);
  if (request.allowProtectedTabAction && request.userConfirmed) return ok(undefined);
  return err(appError(
    'PERMISSION_DENIED',
    'Refusing to mutate a protected ChatGPT tab without allow_protected_tab_action=true and explicit user confirmation',
  ));
}

function isProtectedAgentTab(tab: BrowserCdpTab): boolean {
  return isProtectedBrowserUrl(tab.url);
}

function isReadOnlyBrowserAction(action: BrowserAction, parameters: Record<string, unknown>): boolean {
  if (action === 'wait') return typeof parameters.selector === 'string' && parameters.selector.trim().length > 0 && hasOnlyKeys(parameters, ['selector', 'poll_interval_seconds']) && (parameters.poll_interval_seconds === undefined || (typeof parameters.poll_interval_seconds === 'number' && Number.isFinite(parameters.poll_interval_seconds) && parameters.poll_interval_seconds >= 0.01 && parameters.poll_interval_seconds <= 1));
  return action === 'status' || action === 'list_tabs' || action === 'query' || action === 'screenshot';
}

function isBrowserAction(value: unknown): value is BrowserAction {
  return typeof value === 'string' && BROWSER_ACTIONS.some((action) => action === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === 'string' ? result : undefined;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const result = value[key];
  if (!Array.isArray(result) || result.length < 1 || result.length > 32) return undefined;
  const files = result.map((entry) => typeof entry === 'string' ? entry.trim() : '');
  return files.every((entry) => entry.length > 0 && entry.length <= 4096) ? files : undefined;
}

function parseStructuredQueryRequest(parameters: Record<string, unknown>): Result<StructuredQueryRequest | undefined> {
  if (!('queries' in parameters)) return ok(undefined);
  if (!hasOnlyKeys(parameters, ['page', 'queries'])) return err(appError('INVALID_INPUT', 'Structured query has an unknown parameter'));
  const page = parameters.page;
  if (!isRecord(page)) return err(appError('INVALID_INPUT', 'Structured query requires parameters.page with exact origin, pathname, and title'));
  if (!hasOnlyKeys(page, ['origin', 'pathname', 'title', 'search'])) return err(appError('INVALID_INPUT', 'Structured query page identity has an unknown field'));
  const origin = readString(page, 'origin');
  const pathname = readString(page, 'pathname');
  const title = readString(page, 'title');
  const search = page.search;
  if (search !== undefined && (typeof search !== 'string' || search.length > 2048 || (search !== '' && !search.startsWith('?')))) return err(appError('INVALID_INPUT', 'Structured query search identity is invalid'));
  if (!isExactPageField(origin, 2048) || !isExactPageField(pathname, 2048) || !isExactPageField(title, 2048)) {
    return err(appError('INVALID_INPUT', 'Structured query page identity is invalid'));
  }
  const rawQueries = parameters.queries;
  if (!Array.isArray(rawQueries) || rawQueries.length < 1 || rawQueries.length > MAX_STRUCTURED_QUERY_ITEMS) {
    return err(appError('INVALID_INPUT', `Structured query requires 1 to ${MAX_STRUCTURED_QUERY_ITEMS} query items`));
  }
  const seenKeys = new Set<string>();
  const queries: StructuredQueryItem[] = [];
  for (const rawQuery of rawQueries) {
    if (!isRecord(rawQuery)) return err(appError('INVALID_INPUT', 'Structured query item is invalid'));
    if (!hasOnlyKeys(rawQuery, ['key', 'selector', 'fields', 'attributes', 'expect'])) return err(appError('INVALID_INPUT', 'Structured query item has an unknown field'));
    const key = readString(rawQuery, 'key');
    const selector = readString(rawQuery, 'selector');
    if (!isExactPageField(key, 96) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || !isExactPageField(selector, 2048) || seenKeys.has(key)) {
      return err(appError('INVALID_INPUT', 'Structured query key or selector is invalid'));
    }
    seenKeys.add(key);
    const parsedFields = parseStructuredQueryFields(rawQuery.fields);
    if (!parsedFields.ok) return parsedFields;
    const parsedAttributes = parseStructuredQueryAttributes(rawQuery.attributes, parsedFields.value);
    if (!parsedAttributes.ok) return parsedAttributes;
    const parsedExpectation = parseStructuredQueryExpectation(rawQuery.expect);
    if (!parsedExpectation.ok) return parsedExpectation;
    for (const field of ['text', 'value', 'checked', 'disabled', 'visible'] as const) {
      if (parsedExpectation.value[field] !== undefined && !parsedFields.value.includes(field)) return err(appError('INVALID_INPUT', 'Structured query expectation requires its requested field: ' + field));
    }
    if (parsedExpectation.value.notContains !== undefined && (parsedExpectation.value.count === 0 || !parsedFields.value.some((field) => field === 'text' || field === 'value'))) {
      return err(appError('INVALID_INPUT', 'notContains requires nonzero count and an explicit text or value source'));
    }
    if (parsedExpectation.value.count !== 1 && hasScalarExpectation(parsedExpectation.value)) {
      return err(appError('INVALID_INPUT', 'Structured query scalar expectations require expect.count = 1'));
    }
    queries.push({ key, selector, fields: parsedFields.value, attributes: parsedAttributes.value, expect: parsedExpectation.value });
  }
  return ok({ page: { origin, pathname, title, ...(typeof search === 'string' ? { search } : {}) }, queries });
}

function parseStructuredQueryFields(value: unknown): Result<readonly StructuredQueryField[]> {
  if (value === undefined) return ok(['text', 'tag', 'disabled', 'visible']);
  if (!Array.isArray(value) || value.length < 1 || value.length > STRUCTURED_QUERY_FIELDS.size) {
    return err(appError('INVALID_INPUT', 'Structured query fields must be a bounded non-empty array'));
  }
  const fields = value.filter((field): field is StructuredQueryField => typeof field === 'string' && STRUCTURED_QUERY_FIELDS.has(field as StructuredQueryField));
  if (fields.length !== value.length || new Set(fields).size !== fields.length) return err(appError('INVALID_INPUT', 'Structured query fields contain an invalid or duplicate field'));
  return ok(fields);
}

function parseStructuredQueryAttributes(value: unknown, fields: readonly StructuredQueryField[]): Result<readonly string[]> {
  if (value === undefined) return ok([]);
  if (!fields.includes('attributes') || !Array.isArray(value) || value.length < 1 || value.length > 8) {
    return err(appError('INVALID_INPUT', 'Structured query attributes require the attributes field and 1 to 8 safe names'));
  }
  const attributes = value.map((entry) => typeof entry === 'string' ? entry : '');
  if (attributes.some((attribute) => !SAFE_STRUCTURED_QUERY_ATTRIBUTES.test(attribute) || /(?:pass|secret|token|api[-_]?key|auth|cookie|session|credential|jwt)/i.test(attribute)) || new Set(attributes).size !== attributes.length) {
    return err(appError('INVALID_INPUT', 'Structured query contains an unsafe or duplicate attribute name'));
  }
  return ok(attributes);
}

function parseStructuredQueryExpectation(value: unknown): Result<StructuredQueryExpectation> {
  if (!isRecord(value) || typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 0 || value.count > 100) {
    return err(appError('INVALID_INPUT', 'Structured query expect.count must be an integer from 0 to 100'));
  }
  if (!hasOnlyKeys(value, ['count', 'text', 'value', 'checked', 'disabled', 'visible', 'notContains'])) return err(appError('INVALID_INPUT', 'Structured query expectation has an unknown field'));
  const result: StructuredQueryExpectation = { count: value.count };
  for (const key of ['text', 'value', 'notContains'] as const) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== 'string' || candidate.length > 4096 || (key === 'notContains' && candidate.length === 0))) return err(appError('INVALID_INPUT', `Structured query expect.${key} is invalid`));
    if (typeof candidate === 'string') Object.assign(result, { [key]: candidate });
  }
  for (const key of ['checked', 'disabled', 'visible'] as const) {
    const candidate = value[key];
    if (candidate !== undefined && typeof candidate !== 'boolean') return err(appError('INVALID_INPUT', `Structured query expect.${key} is invalid`));
    if (typeof candidate === 'boolean') Object.assign(result, { [key]: candidate });
  }
  return ok(result);
}

function hasScalarExpectation(expectation: StructuredQueryExpectation): boolean {
  return expectation.text !== undefined || expectation.value !== undefined || expectation.checked !== undefined
    || expectation.disabled !== undefined || expectation.visible !== undefined;
}

function isExactPageField(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function readProtocolNumber(response: unknown, key: string): number | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  const value = response.result[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readProtocolNodeId(response: unknown, key: string): number | undefined {
  if (!isRecord(response) || !isRecord(response.result) || !isRecord(response.result[key])) return undefined;
  const nodeId = response.result[key].nodeId;
  return typeof nodeId === 'number' && Number.isInteger(nodeId) ? nodeId : undefined;
}

async function canonicalDirectory(value: string): Promise<string | null> {
  try {
    const resolved = await realpath(path.resolve(value));
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function canonicalExistingFile(value: string): Promise<string | null> {
  if (value.includes('\0')) return null;
  try {
    const resolved = await realpath(path.resolve(value));
    return (await stat(resolved)).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
}

function readNavigationResult(response: unknown): Result<unknown> {
  if (!isRecord(response)) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (isRecord(response.error)) return err(appError('INTERNAL_ERROR', 'Browser CDP navigation request failed', true));
  if (!isRecord(response.result)) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));

  const frameId = response.result.frameId;
  const loaderId = response.result.loaderId;
  const errorText = response.result.errorText;
  const isDownload = response.result.isDownload;
  if (typeof frameId !== 'string' || frameId.length === 0) return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (loaderId !== undefined && typeof loaderId !== 'string') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (errorText !== undefined && typeof errorText !== 'string') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (isDownload !== undefined && typeof isDownload !== 'boolean') return err(appError('INTERNAL_ERROR', 'Browser navigation response was invalid', true));
  if (typeof errorText === 'string' && errorText.length > 0) return err(appError('INTERNAL_ERROR', 'Browser navigation failed', true));

  return ok({
    navigation_requested: true,
    navigation_complete: false,
    frame_id: frameId,
    ...(loaderId === undefined ? {} : { loader_id: loaderId }),
    ...(isDownload === undefined ? {} : { is_download: isDownload }),
  });
}

function readCdpValue(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const outerResult = response.result;
  if (!isRecord(outerResult)) return undefined;
  const remoteResult = outerResult.result;
  if (!isRecord(remoteResult)) return undefined;
  if ('exceptionDetails' in remoteResult) return undefined;
  return 'value' in remoteResult ? remoteResult.value : undefined;
}

function readScreenshotData(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  return typeof response.result.data === 'string' ? response.result.data : undefined;
}

function queryScript(selector: string): string {
  return `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return {ok:false}; const r=el.getBoundingClientRect(); return {ok:true,text:el.innerText||el.value||'',tag:el.tagName,disabled:!!el.disabled,frame:{x:r.x,y:r.y,width:r.width,height:r.height}}; })()`;
}

function structuredQueryScript(request: StructuredQueryRequest): string {
  const payload = JSON.stringify(request);
  return `(() => {
    /* structured query: generated read-only bounded snapshot */
    const request=${payload};
    const visible=(el)=>{ const style=getComputedStyle(el); const rect=el.getBoundingClientRect(); return style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)!==0 && rect.width>0 && rect.height>0; };
    const sensitive=(el)=>{ const type=String(el.getAttribute('type')||'').toLowerCase(); const identity=[el.getAttribute('name'),el.id,el.getAttribute('autocomplete')].join(' ').toLowerCase(); return type==='password'||type==='file'||type==='hidden'||/(?:pass|secret|token|api[-_]?key|auth|cookie|session|credential|jwt)/.test(identity); };
    const page=request.page;
    if(location.origin!==page.origin||location.pathname!==page.pathname||document.title!==page.title||(page.search!==undefined&&location.search!==page.search)) return {ok:false,error:'Page identity changed'};
    const results=[];
    let sourceCharacters=0;
    const bounded=(value,limit=${MAX_STRUCTURED_QUERY_OUTPUT_CHARS})=>{const text=String(value ?? '');sourceCharacters+=text.length;if(text.length>limit||sourceCharacters>${MAX_STRUCTURED_QUERY_OUTPUT_CHARS})throw new Error('Structured query source overflow');return text;};
    for(const spec of request.queries){
      let nodes;
      try { const matches=document.querySelectorAll(spec.selector);if(matches.length>100)return {ok:false,error:'Structured query node overflow for '+spec.key};nodes=Array.from(matches); } catch { return {ok:false,error:'Invalid selector for '+spec.key}; }
      if(nodes.length!==spec.expect.count) return {ok:false,error:'Expected count '+spec.expect.count+' but found '+nodes.length+' for '+spec.key,queries:results};
      const snapshots=[];
      try { for(const el of nodes){
        const isSensitive=sensitive(el);
        if(isSensitive&&(spec.expect.text!==undefined||spec.expect.value!==undefined||spec.expect.notContains!==undefined||spec.fields.includes('options')))return {ok:false,error:'Sensitive content cannot satisfy an expectation for '+spec.key};
        if(spec.fields.includes('value')&&!('value' in el))return {ok:false,error:'Requested value source is unavailable for '+spec.key};
        if(spec.fields.includes('checked')&&!('checked' in el))return {ok:false,error:'Requested checked source is unavailable for '+spec.key};
        if(spec.fields.includes('options')&&!(el instanceof HTMLSelectElement))return {ok:false,error:'Requested options source is unavailable for '+spec.key};
        const rawText=spec.fields.includes('text')?(isSensitive?'[REDACTED]':bounded(el.innerText||el.textContent||'')):undefined;
        const rawValue=spec.fields.includes('value')&&'value' in el?(isSensitive?'[REDACTED]':bounded(el.value)):undefined;
        const snapshot={};
        if(spec.fields.includes('text')) snapshot.text=rawText;
        if(spec.fields.includes('value')) snapshot.value=rawValue??null;
        if(spec.fields.includes('tag')) snapshot.tag=el.tagName;
        const disabled=!!el.disabled||el.getAttribute('aria-disabled')==='true';
        if(spec.fields.includes('disabled')) snapshot.disabled=disabled;
        if(spec.fields.includes('checked')) snapshot.checked=!!el.checked;
        if(spec.fields.includes('visible')) snapshot.visible=visible(el);
        if(spec.fields.includes('attributes')){ snapshot.attributes={};for(const name of spec.attributes)snapshot.attributes[name]=isSensitive?'[REDACTED]':bounded(el.getAttribute(name)||'',256); }
        if(spec.fields.includes('options')){snapshot.options=[];if(el instanceof HTMLSelectElement){if(el.options.length>50)return {ok:false,error:'Structured query options overflow for '+spec.key};for(const option of el.options)snapshot.options.push({text:bounded(option.text,256),value:bounded(option.value,256),selected:option.selected,disabled:option.disabled});}}
        snapshots.push({snapshot,rawText,rawValue,checked:!!el.checked,disabled,visible:visible(el)});
      }}catch{return {ok:false,error:'Structured query source overflow for '+spec.key};}
      const expected=spec.expect;
      for(const item of snapshots){if((expected.text!==undefined&&item.rawText!==expected.text)||(expected.value!==undefined&&item.rawValue!==expected.value)||(expected.checked!==undefined&&item.checked!==expected.checked)||(expected.disabled!==undefined&&item.disabled!==expected.disabled)||(expected.visible!==undefined&&item.visible!==expected.visible)||(expected.notContains!==undefined&&[item.rawText,item.rawValue].some(value=>typeof value==='string'&&value.includes(expected.notContains))))return {ok:false,error:'Expectation failed for '+spec.key,queries:results};}
      results.push({key:spec.key,count:nodes.length,nodes:snapshots.map((item)=>item.snapshot)});
      if(JSON.stringify(results).length>${MAX_STRUCTURED_QUERY_OUTPUT_CHARS}) return {ok:false,error:'Structured query output exceeded bounded limit'};
    }
    return {ok:true,queries:results};
  })()`;
}

function clickScript(selector: string, mouseEventSequence: boolean, expectedText: string | undefined, mouseDownOnly: boolean): string {
  return `(() => {
    const selector=${JSON.stringify(selector)};
    const expectedText=${JSON.stringify(expectedText ?? '')};
    const normalized=(value)=>String(value ?? '').replace(/\\s+/g,' ').trim();
    const isVisible=(el)=>{ const style=getComputedStyle(el); const rect=el.getBoundingClientRect(); return el.isConnected && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)!==0 && rect.width>0 && rect.height>0; };
    if(${mouseEventSequence || mouseDownOnly}){
      let matches;try{matches=document.querySelectorAll(selector);}catch{return {ok:false,error:'Invalid selector'};}
      if(matches.length!==1) return {ok:false,error:'Expected exactly one visible enabled target'};
      const el=matches[0];
      if(!isVisible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')return {ok:false,error:'Expected exactly one visible enabled target'};
      if(normalized(el.innerText||el.textContent||'')!==normalized(expectedText)) return {ok:false,error:'Expected text did not match target'};
      let handlerFailed=false;const onError=()=>{handlerFailed=true;};window.addEventListener('error',onError);
      try{el.scrollIntoView({block:'center',inline:'center'});if(typeof el.focus==='function')el.focus();if(handlerFailed||!isVisible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')return {ok:false,error:'Mouse target changed while focusing; inspect partial state'};const events=${mouseDownOnly}?['mousedown']:['mousedown','mouseup','click'];for(let i=0;i<events.length;i++){const type=events[i];el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window,button:0,buttons:type==='mousedown'?1:0}));if(handlerFailed)return {ok:false,error:'Mouse event handler failed; inspect partial state'};if(i<events.length-1&&(!isVisible(el)||el.disabled||el.getAttribute('aria-disabled')==='true'))return {ok:false,error:'Mouse event target changed; inspect partial state'};}}
      catch{return {ok:false,error:'Mouse event dispatch failed; inspect partial state'};}finally{window.removeEventListener('error',onError);}
      return {ok:true,event_sequence:${mouseDownOnly}?'mousedown':'mousedown/up/click',text:normalized(el.innerText||el.textContent||'')};
    }
    const el=document.querySelector(selector); if(!el) return {ok:false}; el.scrollIntoView({block:'center',inline:'center'}); el.click(); return {ok:true};
  })()`;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForBrowserStart(start: Promise<Result<unknown>>, signal?: AbortSignal): Promise<Result<unknown>> {
  if (signal === undefined) return start;
  const cancelled = cancellationResult(signal);
  if (cancelled !== null) return Promise.resolve(cancelled);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      resolve(err(appError('PROCESS_TIMEOUT', 'DOM operation was cancelled before the next side effect', true)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void start.then(
      (result) => { cleanup(); resolve(result); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function cancellationResult(signal: AbortSignal | undefined): Result<never> | null {
  return signal?.aborted === true
    ? err(appError('PROCESS_TIMEOUT', 'DOM operation was cancelled before the next side effect', true))
    : null;
}
