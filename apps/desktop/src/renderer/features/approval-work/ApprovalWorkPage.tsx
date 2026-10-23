import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DesktopApprovalWorkSummary, UiLocale } from '@lnwjud/ipc-contracts';
import { ActionButton, Surface } from '../ui/UiPrimitives.js';

export interface ApprovalWorkPageApi {
  listApprovalWorks(): Promise<{ readonly workspaceId: string | null; readonly works: readonly DesktopApprovalWorkSummary[] }>;
  prepareApprovalWork(request: { readonly primaryWorkId: string; readonly userConfirmed: true }): Promise<{ readonly reviewToken: string; readonly expiresAt: number; readonly work: DesktopApprovalWorkSummary }>;
  startApprovalWork(request: { readonly reviewToken: string; readonly userConfirmed: true }): Promise<{ readonly hostWorkId: string }>;
  deactivateApprovalWork(request: { readonly primaryWorkId: string; readonly userConfirmed: true }): Promise<{ readonly deactivated: true }>;
}

interface Copy { title: string; intro: string; noWorkspace: string; empty: string; refresh: string; prepare: string; confirm: string; deactivate: string; busy: string; selected: string; tokenExpires: string; remaining: string; blocked: string; unknown: string; failure: string; }
const copy: Record<UiLocale, Copy> = {
  th: { title: 'งานอนุมัติของ Desktop', intro: 'เลือกงานหลักเดิมจากทะเบียนของ host แล้วเตรียม token ก่อนยืนยันเริ่มงาน', noWorkspace: 'ยังไม่ได้เลือก workspace', empty: 'ยังไม่มีงานอนุมัติในทะเบียนของ host', refresh: 'รีเฟรช', prepare: 'เตรียมงาน', confirm: 'ยืนยันเริ่มงาน', deactivate: 'เลิกเลือกงาน', busy: 'กำลังดำเนินการ…', selected: 'กำลังเลือก', tokenExpires: 'หมดอายุ token', remaining: 'กล่องที่เหลือ', blocked: 'ถูกบล็อก', unknown: 'มีหลักฐานไม่ทราบผล', failure: 'ดำเนินการไม่สำเร็จ' },
  en: { title: 'Desktop approval work', intro: 'Select an existing host-registered primary work, prepare its token, then explicitly confirm it.', noWorkspace: 'No workspace is selected', empty: 'No approval work is registered for this host', refresh: 'Refresh', prepare: 'Prepare work', confirm: 'Confirm start', deactivate: 'Deactivate work', busy: 'Working…', selected: 'Selected', tokenExpires: 'Token expires', remaining: 'windows remaining', blocked: 'blocked', unknown: 'in-doubt evidence', failure: 'Operation failed' },
};

export function ApprovalWorkPage(props: { readonly locale: UiLocale; readonly selectedWorkspaceId: string | null; readonly api?: ApprovalWorkPageApi }): ReactElement {
  const api = props.api ?? (window.lnwjud as unknown as ApprovalWorkPageApi);
  const [works, setWorks] = useState<readonly DesktopApprovalWorkSummary[]>([]);
  const [registryWorkspace, setRegistryWorkspace] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesktopApprovalWorkSummary | null>(null);
  const [review, setReview] = useState<{ readonly reviewToken: string; readonly expiresAt: number; readonly work: DesktopApprovalWorkSummary } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const listSequence = useRef(0);
  const t = copy[props.locale];
  useEffect(() => {
    if (review === null) return;
    const timer = setTimeout(() => setReview((current) => current?.reviewToken === review.reviewToken ? null : current), Math.max(0, review.expiresAt - Date.now()));
    return (): void => clearTimeout(timer);
  }, [review]);
  useEffect(() => {
    const current = ++generation.current;
    const sequence = ++listSequence.current;
    setWorks([]); setRegistryWorkspace(null); setSelected(null); setReview(null); setMessage(null); busyRef.current = false; setBusy(false);
    if (props.selectedWorkspaceId === null) return;
    void api.listApprovalWorks().then((result) => {
      if (current !== generation.current || sequence !== listSequence.current || result.workspaceId !== props.selectedWorkspaceId) return;
      setRegistryWorkspace(result.workspaceId); setWorks(result.works.filter((work) => work.workspaceId === props.selectedWorkspaceId));
    }).catch((error: unknown) => { if (current === generation.current && sequence === listSequence.current) { setRegistryWorkspace(null); setWorks([]); setMessage(error instanceof Error ? error.message : String(error)); } });
    return (): void => { generation.current += 1; };
  }, [api, props.selectedWorkspaceId]);
  async function prepare(work: DesktopApprovalWorkSummary): Promise<void> {
    if (busyRef.current || work.workspaceId !== props.selectedWorkspaceId) return; busyRef.current = true; setBusy(true); setMessage(null); setSelected(work); setReview(null);
    const current = generation.current;
    try {
      const prepared = await api.prepareApprovalWork({ primaryWorkId: work.primaryWorkId, userConfirmed: true });
      if (current === generation.current && prepared.work.primaryWorkId === work.primaryWorkId && prepared.work.hostWorkId === work.hostWorkId && prepared.work.workspaceId === work.workspaceId && prepared.expiresAt > Date.now()) {
        setReview(prepared); setSelected(prepared.work);
        setWorks((items) => items.map((item) => item.primaryWorkId === work.primaryWorkId ? prepared.work : item));
      }
    }
    catch (error: unknown) { if (current === generation.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) { busyRef.current = false; setBusy(false); } }
  }
  async function start(): Promise<void> {
    if (!review || busyRef.current || review.expiresAt <= Date.now()) { if (review?.expiresAt && review.expiresAt <= Date.now()) setReview(null); return; }
    const token = review.reviewToken; const current = generation.current; setReview(null); busyRef.current = true; setBusy(true); setMessage(null);
    try { await api.startApprovalWork({ reviewToken: token, userConfirmed: true }); if (current === generation.current) await reload(); }
    catch (error: unknown) { if (current === generation.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) { busyRef.current = false; setBusy(false); } }
  }
  async function deactivate(work: DesktopApprovalWorkSummary): Promise<void> {
    if (busyRef.current || work.workspaceId !== props.selectedWorkspaceId) return; busyRef.current = true; setBusy(true); setMessage(null);
    const current = generation.current;
    try { await api.deactivateApprovalWork({ primaryWorkId: work.primaryWorkId, userConfirmed: true }); if (current === generation.current) await reload(); }
    catch (error: unknown) { if (current === generation.current) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) { busyRef.current = false; setBusy(false); } }
  }
  async function reload(): Promise<void> {
    const current = generation.current; setReview(null); setSelected(null); setWorks([]); setRegistryWorkspace(null);
    const sequence = ++listSequence.current;
    try {
      const result = await api.listApprovalWorks();
      if (current !== generation.current || sequence !== listSequence.current || result.workspaceId !== props.selectedWorkspaceId) return;
      setRegistryWorkspace(result.workspaceId); setWorks(result.works.filter((work) => work.workspaceId === props.selectedWorkspaceId));
    } catch (error: unknown) { if (current === generation.current && sequence === listSequence.current) { setRegistryWorkspace(null); setWorks([]); setMessage(error instanceof Error ? error.message : String(error)); } }
  }
  return <div className="page-content approval-work-page">
    <h1>{t.title}</h1><p>{t.intro}</p>
    {props.selectedWorkspaceId === null ? <p role="status">{t.noWorkspace}</p> : null}
    {props.selectedWorkspaceId !== null && registryWorkspace !== props.selectedWorkspaceId ? <p role="status">{t.busy}</p> : null}
    {props.selectedWorkspaceId !== null && registryWorkspace === props.selectedWorkspaceId && works.length === 0 ? <p role="status">{t.empty}</p> : null}
    <div className="approval-work-actions"><ActionButton type="button" onClick={() => { void reload(); }} disabled={busy || props.selectedWorkspaceId === null}>{t.refresh}</ActionButton></div>
    {works.map((work) => <Surface as="section" key={work.primaryWorkId} className="approval-work-card">
      <h2>{work.primaryWorkId}</h2><p>{work.pageUrl}</p>
      <p>{(work.continuationRevision ?? 0) > 0 ? `+${work.continuationRevision} · ` : ''}{work.selected ? t.selected : ''} · {work.remaining} {t.remaining} · {work.blocked} {t.blocked} · {work.inDoubt} {t.unknown}</p>
      <ActionButton type="button" onClick={() => { void prepare(work); }} disabled={busy || work.selected || work.inDoubt !== 0 || work.remaining === 0}>{t.prepare}</ActionButton>
      {work.selected ? <ActionButton type="button" onClick={() => { void deactivate(work); }} disabled={busy}>{t.deactivate}</ActionButton> : null}
      {selected?.primaryWorkId === work.primaryWorkId && review ? <div className="approval-work-review"><p>{review.work.primaryWorkId} · {review.work.tabId} · {review.work.pageUrl}</p>{review.work.targets?.map((target, index) => <p key={index}>{target.tabId} · {target.pageUrl}</p>)}<p>{review.work.shown} / {review.work.limit} · {review.work.remaining} {t.remaining}</p><p>{t.tokenExpires}: {new Date(review.expiresAt).toLocaleString()}</p><ActionButton type="button" onClick={() => { void start(); }} disabled={busy || review.expiresAt <= Date.now() || review.work.remaining === 0 || review.work.inDoubt !== 0}>{t.confirm}</ActionButton></div> : null}
    </Surface>)}
    {busy ? <p role="status" aria-live="polite">{t.busy}</p> : null}{message ? <p role="alert">{t.failure}: {message}</p> : null}
  </div>;
}
