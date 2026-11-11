import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { UiLocale } from '@lnwjud/ipc-contracts';
import { PageHeading, StatusMessage, EmptyState } from '../ui/UiPrimitives.js';
import { formatDateTime } from '../../date-time.js';
import { buildTownSnapshot } from './town-adapter.js';
import { deriveBuildingFacts } from './town-buildings.js';
import { deriveTown, type TownActiveClient, type TownBoardCard, type TownStatus, type TownStatusResult } from './town-state.js';
import { reasonLabel, statusLabel, townCopy, type TownCopy } from './town-copy.js';
import {
  TOWN_GOAL_CHECKPOINT_MAX_AGE_MS,
  TOWN_SNAPSHOT_MAX_AGE_MS,
  useTownData,
} from './useTownData.js';

interface TownPageProps {
  readonly locale: UiLocale;
  readonly workspaceId: string | null;
}

/**
 * Read-only view. It performs no action, renders only what the normalizer
 * returns, and never animates a character that the normalizer did not mark
 * WORKING.
 */
export function TownPage({ locale, workspaceId }: TownPageProps): ReactElement {
  const copy = townCopy(locale);
  const { input, now } = useTownData(workspaceId);

  const model = useMemo(() => {
    if (workspaceId === null || input === null) return null;
    const snapshot = buildTownSnapshot(input);
    const town = deriveTown(snapshot, {
      expectedScopeId: workspaceId,
      expectedEnvironment: 'LIVE-READONLY',
      now,
      snapshotMaxAgeMs: TOWN_SNAPSHOT_MAX_AGE_MS,
      goalCheckpointMaxAgeMs: TOWN_GOAL_CHECKPOINT_MAX_AGE_MS,
    });
    return { town, facts: deriveBuildingFacts(input, town.board), observedAt: input.observedAt };
  }, [workspaceId, input, now]);

  return (
    <section className="town-page" aria-label={copy.title}>
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={<span className="pill-badge town-live-badge">{copy.liveReadOnly}</span>}
      />
      {workspaceId === null ? <EmptyState>{copy.noWorkspace}</EmptyState> : null}
      {workspaceId !== null && model === null ? <p role="status" className="ui-loading-status">{copy.loading}</p> : null}
      {model === null ? null : (
        <>
          {model.town.board.trust === 'unknown' ? (
            <StatusMessage tone="warning" role="alert">{copy.staleBanner}</StatusMessage>
          ) : null}
          <p className="hint">
            {copy.lastRead}: {model.observedAt === null ? copy.never : formatDateTime(model.observedAt, '—', locale)}
            {' · '}{copy.placeholderArt}
          </p>
          <div className="town-map" role="group" aria-label={copy.title}>
            <Building className="town-gate" title={copy.gate} art="gate">
              <p>{gateText(copy, model.facts.gate.mcpRunning)}</p>
            </Building>
            <Building className="town-hall" title={copy.hall} art="hall">
              <p>{model.facts.hall === null
                ? copy.unknownFact
                : copy.hallFacts(model.facts.hall.working, model.facts.hall.done, model.facts.hall.stuck, model.facts.hall.unverified)}</p>
            </Building>
            <Building className="town-compass" title={copy.compass} art="house" status={model.town.agent.status}>
              <Character name="PN-01" result={model.town.agent} locale={locale} resting={copy.resting} previously={copy.previously} />
              <ActiveClients clients={model.town.activeClients} copy={copy} />
            </Building>
            <Building className="town-review" title={copy.review} art="review">
              <p>{model.facts.review === null
                ? copy.unknownFact
                : copy.reviewFacts(
                  model.facts.review.checksPassed, model.facts.review.checksTotal,
                  model.facts.review.filesVerified, model.facts.review.filesTotal,
                  model.facts.review.checksFailed + model.facts.review.filesFailed)}</p>
            </Building>
            <Building className="town-archive" title={copy.archive} art="archive">
              <p>{model.facts.archive === null ? copy.unknownFact : copy.archiveFacts(model.facts.archive.checkpointedGoals)}</p>
              {model.facts.archive?.latestCheckpointAt
                ? <small>{formatDateTime(model.facts.archive.latestCheckpointAt, '—', locale)}</small> : null}
            </Building>
          </div>

          <h2 className="town-board-title">{copy.board}</h2>
          <div className="town-board">
            <Column title={copy.colWorking} cards={model.town.board.working} locale={locale} empty={copy.empty} byAi={copy.byAi} unknownAi={copy.aiUnknown} />
            <Column title={copy.colDone} cards={model.town.board.done} locale={locale} empty={copy.empty} />
            <Column title={copy.colStuck} cards={model.town.board.stuck} locale={locale} empty={copy.empty} />
            <section className="town-column town-column-owner" aria-label={copy.colOwner}>
              <h3>{copy.colOwner}</h3>
              {model.town.board.awaitingOwner.supported
                ? <Cards cards={model.town.board.awaitingOwner.cards} locale={locale} empty={copy.empty} />
                : <p className="hint">{copy.ownerUnsupported}</p>}
            </section>
            <Column title={copy.colUnverified} hint={copy.unverifiedHint} cards={model.town.board.unverified} locale={locale} empty={copy.empty} />
          </div>
        </>
      )}
    </section>
  );
}

function gateText(copy: TownCopy, running: boolean | null): string {
  if (running === null) return copy.unknownFact;
  return running ? copy.mcpRunning : copy.mcpStopped;
}

function Building(props: {
  readonly className: string;
  readonly title: string;
  readonly art: 'gate' | 'hall' | 'house' | 'review' | 'archive';
  readonly status?: TownStatus;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <article className={`town-building ${props.className}`} data-status={props.status ?? 'NONE'}>
      <PlaceholderArt kind={props.art} />
      <h3>{props.title}</h3>
      <div className="town-building-body">{props.children}</div>
    </article>
  );
}

function Character(props: {
  readonly name: string;
  readonly result: TownStatusResult;
  readonly locale: UiLocale;
  readonly resting: string;
  readonly previously: string;
}): ReactElement {
  const { result } = props;
  const working = result.status === 'WORKING';
  return (
    <div className={`town-character town-status-${result.status}`} data-working={working ? 'true' : 'false'}>
      <span className="town-avatar" aria-hidden="true">{result.status === 'UNKNOWN' ? '?' : working ? '⚡' : '·'}</span>
      <div>
        <strong>{props.name}</strong>{' '}
        <span className="town-status-chip">{statusLabel(props.locale, result.status)}</span>
        {result.badges.map((badge) => <span key={badge} className="town-badge">{badge}</span>)}
        <small>{reasonLabel(props.locale, result.reason)}</small>
        {result.previouslyReported === null ? null
          : <small>{props.previously}: {statusLabel(props.locale, result.previouslyReported)}</small>}
        {result.status === 'IDLE' ? <small>{props.resting}</small> : null}
      </div>
    </div>
  );
}

function ActiveClients({ clients, copy }: { readonly clients: readonly TownActiveClient[]; readonly copy: TownCopy }): ReactElement | null {
  if (clients.length === 0) return null;
  return (
    <div className="town-ai-list">
      <strong>{copy.activeAi}</strong>
      <ul>
        {clients.map((client) => (
          <li key={client.name ?? '__unknown__'} data-known={client.name === null ? 'false' : 'true'}>
            {client.name ?? copy.aiUnknown} · {copy.aiCalls(client.calls)}
          </li>
        ))}
      </ul>
      <small>{copy.aiVisibilityNote}</small>
    </div>
  );
}

function Column(props: {
  readonly title: string; readonly hint?: string;
  readonly cards: readonly TownBoardCard[]; readonly locale: UiLocale; readonly empty: string;
  readonly byAi?: string; readonly unknownAi?: string;
}): ReactElement {
  return (
    <section className="town-column" aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.hint === undefined ? null : <p className="hint">{props.hint}</p>}
      <Cards cards={props.cards} locale={props.locale} empty={props.empty} byAi={props.byAi} unknownAi={props.unknownAi} />
    </section>
  );
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function cardDetail(detail: string | null, locale: UiLocale): string | null {
  return detail !== null && ISO_TIME.test(detail) ? formatDateTime(detail, '—', locale) : detail;
}

function Cards(props: {
  readonly cards: readonly TownBoardCard[]; readonly locale: UiLocale; readonly empty: string;
  readonly byAi?: string | undefined; readonly unknownAi?: string | undefined;
}): ReactElement {
  if (props.cards.length === 0) return <p className="hint">{props.empty}</p>;
  return (
    <ul className="town-cards">
      {props.cards.map((card) => (
        <li key={card.id} className={`town-card town-status-${card.status}`}>
          <strong>{card.title}</strong>
          <span className="town-status-chip">{statusLabel(props.locale, card.status)}</span>
          {card.clientName === undefined || props.byAi === undefined ? null
            : <small className="town-card-ai">{props.byAi}: {card.clientName ?? props.unknownAi}</small>}
          {card.detail === null ? null : <small>{cardDetail(card.detail, props.locale)}</small>}
          <small>{reasonLabel(props.locale, card.reason)}</small>
        </li>
      ))}
    </ul>
  );
}

/** Simple geometric stand-ins; the real anime art is still under owner review. */
function PlaceholderArt({ kind }: { readonly kind: 'gate' | 'hall' | 'house' | 'review' | 'archive' }): ReactElement {
  return (
    <svg className="town-art" viewBox="0 0 120 70" role="img" aria-hidden="true" focusable="false">
      {kind === 'gate' ? <><rect x="15" y="20" width="20" height="45" /><rect x="85" y="20" width="20" height="45" /><path d="M10 22h100v10H10z" /></> : null}
      {kind === 'hall' ? <><rect x="15" y="25" width="90" height="40" /><path d="M10 27 60 6l50 21z" /><rect x="52" y="42" width="16" height="23" /></> : null}
      {kind === 'house' ? <><rect x="30" y="30" width="60" height="35" /><path d="M24 32 60 10l36 22z" /><rect x="54" y="44" width="12" height="21" /></> : null}
      {kind === 'review' ? <><rect x="20" y="22" width="80" height="43" /><circle cx="60" cy="40" r="12" /></> : null}
      {kind === 'archive' ? <><rect x="15" y="20" width="90" height="45" /><path d="M25 30h70M25 42h70M25 54h70" /></> : null}
    </svg>
  );
}
