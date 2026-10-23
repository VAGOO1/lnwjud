import { useCallback, useRef, useState, type ReactElement } from 'react';
import { workspaceScopeMatches, type DashboardSnapshot, type UiLocale, type WorkLogEntry, type WorkspaceSummary } from '@lnwjud/ipc-contracts';
import { createTranslator } from '../../i18n/index.js';
import { WorkLogPanel, type LogScopeSelection, type WorkLogFilter } from '../worklog/WorkLogPanel.js';

interface WorkLogPageProps {
  readonly locale: UiLocale;
  readonly dashboard: DashboardSnapshot;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly onClearWorkLog: (scope: LogScopeSelection) => Promise<void>;
  readonly onExportWorkLog: (rowIds: readonly string[]) => Promise<void>;
  readonly onLoadSessionHistory: (scope: LogScopeSelection) => Promise<readonly WorkLogEntry[]>;
}

export function WorkLogPage(props: WorkLogPageProps): ReactElement {
  const t = createTranslator(props.locale);
  const [filter, setFilter] = useState<WorkLogFilter>('all');
  const [historicalEntries, setHistoricalEntries] = useState<readonly WorkLogEntry[]>([]);
  const sessionLoadGeneration = useRef(0);
  const resolveTargetDetail = useCallback(async (detailRef: string) => (await window.lnwjud.resolveActivityTargetDetail({ detailRef })).detail, []);
  const searchTargetDetails = useCallback(async (
    query: string,
    candidates: readonly { readonly id: string; readonly detailRef: string | null }[],
  ) => (await window.lnwjud.searchActivityTargetDetails({ query, candidates })).matchingIds, []);
  const entries = [...new Map([...props.dashboard.workLog, ...historicalEntries].map((entry) => [entry.id, entry])).values()];
  const loadSession = async (scope: LogScopeSelection): Promise<void> => {
    const generation = ++sessionLoadGeneration.current;
    if (scope.sessionId === null) {
      setHistoricalEntries([]);
      return;
    }
    const entries = await props.onLoadSessionHistory(scope);
    if (generation === sessionLoadGeneration.current) setHistoricalEntries(entries);
  };
  const clearWorkLog = async (scope: LogScopeSelection): Promise<void> => {
    await props.onClearWorkLog(scope);
    setHistoricalEntries((entries) => retainedHistoricalEntriesAfterClear(entries, scope, props.workspaces));
  };
  return (
    <div className="page-content viewport-list-page worklog-page">
      <p className="page-subtitle">{t('workLog.subtitle')}</p>
      <WorkLogPanel
        locale={props.locale}
        title={t('workLog.title')}
        emptyLabel={t('workLog.empty')}
        filterAllLabel={t('workLog.filterAll')}
        filterWarningLabel={t('workLog.filterWarning')}
        filterErrorLabel={t('workLog.filterError')}
        clearSessionLabel={t('scope.clearSession')}
        clearWorkspaceLabel={t('scope.clearWorkspace')}
        clearAllLabel={t('scope.clearAll')}
        filter={filter}
        onFilterChange={setFilter}
        onClear={clearWorkLog}
        exportLabel={t('live.export')}
        onExport={props.onExportWorkLog}
        onResolveTargetDetail={resolveTargetDetail}
        onSearchTargetDetails={searchTargetDetails}
        entries={entries}
        inFlight={props.dashboard.inFlight}
        sessions={props.dashboard.workLogSessions ?? []}
        onSessionChange={loadSession}
        workspaces={props.workspaces}
        defaultWorkspaceId={props.dashboard.selectedWorkspace?.id ?? null}
        workspaceLabel={t('scope.workspace')}
        sessionLabel={t('scope.session')}
        scopeAllLabel={t('scope.all')}
        searchPlaceholder={t('workLog.searchPlaceholder')}
        copyLabel={t('mcp.copy')}
        copiedLabel={t('mcp.copied')}
        showMoreLabel={t('logDetail.showMore')}
        showLessLabel={t('logDetail.showLess')}
        detailHeadingLabel={t('logDetail.heading')}
        detailLoadingLabel={t('logDetail.loading')}
        detailErrorLabel={t('logDetail.error')}
        detailEmptyLabel={t('logDetail.empty')}
        legacyIncompleteLabel={t('logDetail.legacyIncomplete')}
      />
    </div>
  );
}

export function retainedHistoricalEntriesAfterClear(
  entries: readonly WorkLogEntry[],
  scope: LogScopeSelection,
  workspaces: readonly WorkspaceSummary[] = [],
): readonly WorkLogEntry[] {
  if (scope.sessionId !== null) return entries.filter((entry) => entry.sessionId !== scope.sessionId);
  const workspaceId = scope.workspaceId;
  if (workspaceId !== null) return entries.filter((entry) => !workspaceScopeMatches(workspaces, entry.workspaceId, workspaceId));
  return [];
}
