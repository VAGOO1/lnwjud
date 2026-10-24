import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { previewR13SyntheticManifest, simulateR13QuarantineAudit } from './manifest-preflight.mts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const oldBoot = 'boot-abc', newBoot = 'boot-def';
const T = 'task-alpha', W = 'workspace-a', HOST = 'synthetic-host-a';
const marker = {
  version: 1, taskId: T, requestDigest: '9'.repeat(64), mutationKind: 'opaque_contained_process',
  ownerClientId: 'client-a', ownerWorkspaceId: W,
  nativeReceiptPath: 'X:/synthetic/native/job/receipt.json',
  reservedAt: '2026-10-23T06:00:00.000Z', launcherStartedAt: '2026-10-23T06:01:00.000Z',
  launcherPid: 4444,
  // These two fields are not persisted in actual Host 5.8.7 markers.
  originHostId: HOST, originBootId: oldBoot, osProcessCreationMs: 1792735260000,
};
const boot = { source: 'synthetic_windows_native_fixture', hostId: HOST, previousBootId: oldBoot,
  currentBootId: newBoot, rebootAtMs: 1792750000000 };
function encoded(source: Record<string, unknown> = marker) {
  const rawMarkerJson = JSON.stringify(source);
  const id = typeof source.taskId === 'string' ? source.taskId : '__invalid__';
  return { taskId: id, markerFile: `${sha(id)}.json`,
    rawMarkerJson, expectedSha256: sha(rawMarkerJson) };
}
const reviewItem = (entry = encoded()) => ({ taskId: entry.taskId,
  ownerWorkspaceId: W, sourceFingerprintSha256: entry.expectedSha256 });
function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, mode: 'STAGING_SYNTHETIC_ONLY', hostId: HOST,
    targetWorkspaceId: W, inventoryComplete: true, expectedCount: 1,
    markers: [encoded()], boot,
    probes: [{ pid: 4444, currentBootId: newBoot, state: 'absent' }],
    review: { scope: 'staging_only', approved: true, items: [reviewItem()] }, ...overrides };
}
const analyze = (x = sample()) => previewR13SyntheticManifest(JSON.stringify(x));
const result = (x = sample()) => analyze(x).items[0];

// The harness is pure JSON-string inspection, not an authenticated OS reader.
test('01 fully consistent synthetic fixture can be reviewed but cannot release live resources', () => {
  const out = analyze();
  assert.equal(out.status, 'SYNTHETIC_REVIEW_READY');
  assert.equal(out.readyForReview, 1);
  assert.equal(out.actualBootAttested, false);
  assert.equal(out.canMutateHost, false);
  assert.equal(out.canReleaseReservation, false);
  assert.equal(out.items[0].nativeZeroDescendantsVerified, false);
  assert.equal(out.items[0].nativeTaskOutcome, 'UNKNOWN_UNVERIFIED');
});
test('02 actual-version marker without boot identity must HOLD and never backfill it', () => {
  const raw = { ...marker, originBootId: undefined, osProcessCreationMs: undefined };
  const entry = encoded(raw);
  const out = analyze(sample({ markers: [entry], review: { scope: 'staging_only', approved: true,
    items: [reviewItem(entry)] } }));
  assert.equal(out.readyForReview, 0);
  assert.equal(out.items[0].reason, 'ORIGINAL_WINDOWS_IDENTITY_NOT_PERSISTED');
});
test('03 legacy marker is not inferred from age or reboot time', () => {
  const raw = { ...marker, legacy: true };
  const entry = encoded(raw);
  assert.equal(result(sample({ markers: [entry] })).reason, 'LEGACY_OR_UNRECOGNIZED_KIND');
});
test('04 marker of another workspace is HOLD even with matching sha256', () => {
  const raw = { ...marker, ownerWorkspaceId: 'workspace-other' };
  const entry = encoded(raw);
  assert.equal(result(sample({ markers: [entry] })).reason, 'OTHER_OR_UNKNOWN_WORKSPACE_OWNER');
});
test('05 missing ownerClientId is HOLD', () => {
  const entry = encoded({ ...marker, ownerClientId: undefined });
  assert.equal(result(sample({ markers: [entry] })).reason, 'OWNER_CLIENT_UNKNOWN');
});
test('06 requestDigest null or absent is HOLD', () => {
  for (const raw of [{...marker, requestDigest:null}, {...marker,requestDigest:undefined}]) {
    assert.equal(result(sample({ markers: [encoded(raw as unknown as typeof marker)] })).reason, 'REQUEST_DIGEST_UNKNOWN');
  }
});
test('07 contained record without nativeReceiptPath remains HOLD', () => {
  const e=encoded({ ...marker, nativeReceiptPath: undefined } as unknown as typeof marker);
  assert.equal(result(sample({markers:[e]})).reason,'CONTAINED_RECEIPT_REFERENCE_UNKNOWN');
});
test('08 raw marker tampering or filename mismatch holds', () => {
  const e=encoded();
  assert.equal(result(sample({markers:[{...e,rawMarkerJson:e.rawMarkerJson+' '}]})).reason,'MARKER_HASH_OR_FILENAME_MISMATCH');
  assert.equal(result(sample({markers:[{...e,markerFile:'wrong.json'}]})).reason,'MARKER_HASH_OR_FILENAME_MISMATCH');
});
test('09 noncanonical marker JSON including duplicate keys never gets accepted', () => {
  const raw='{"version":1,"taskId":"task-alpha","taskId":"task-alpha"}';
  const e={taskId:T,markerFile:sha(T)+'.json',rawMarkerJson:raw,expectedSha256:sha(raw)};
  assert.equal(result(sample({markers:[e]})).reason,'MARKER_NOT_CANONICAL_OR_DUPLICATE_KEYS');
});
test('10 incomplete or mismatched global inventory is HOLD for entire manifest', () => {
  for (const diff of [{inventoryComplete:false},{expectedCount:2},{markers:[]},{expectedCount:0}]) {
    const out=analyze(sample(diff));
    assert.equal(out.status,'HOLD');
    assert.equal(out.readyForReview,0);
    assert.equal(out.error,'MISSING_GLOBAL_INVENTORY_OR_HEADER');
  }
});
test('11 PID reuse verified only synthetically if new process is later than reboot', () => {
  const good=analyze(sample({ probes:[{pid:4444,currentBootId:newBoot,state:'reused_pid',osCreationMs:1792750000001}]}));
  const bad=analyze(sample({ probes:[{pid:4444,currentBootId:newBoot,state:'reused_pid',osCreationMs:1792749999999}]}));
  assert.equal(good.readyForReview,1);
  assert.equal(bad.items[0].reason,'PID_REUSE_PROCESS_TIME_UNPROVEN');
});
test('12 live or unknown current process is HOLD', () => {
  for(const state of ['same_process','unknown','live','legacy']){
    assert.equal(result(sample({probes:[{pid:4444,currentBootId:newBoot,state}]})).reason,'CURRENT_PROCESS_UNKNOWN_OR_LIVE');
  }
});
test('13 wrong fingerprint in owner review is HOLD', () => {
  const out=analyze(sample({review:{scope:'staging_only',approved:true,items:[{taskId:T,ownerWorkspaceId:W,sourceFingerprintSha256:'f'.repeat(64)}]}}));
  assert.equal(out.items[0].reason,'EXACT_REVIEW_FINGERPRINT_MISMATCH');
});
test('14 absent or duplicated owner review is HOLD', () => {
  assert.equal(result(sample({review:{scope:'staging_only',approved:false,items:[reviewItem()]}})).reason,'EXACT_SYNTHETIC_OWNER_REVIEW_MISSING');
  assert.equal(result(sample({review:{scope:'staging_only',approved:true,items:[reviewItem(),reviewItem()]}})).reason,'EXACT_SYNTHETIC_OWNER_REVIEW_MISSING');
});
test('15 duplicate marker task IDs are HOLD per record', () => {
  const out=analyze(sample({expectedCount:2,markers:[encoded(),encoded()],review:{scope:'staging_only',approved:true,items:[reviewItem()]}}));
  assert.equal(out.held,2);
  assert.equal(out.items[0].reason,'DUPLICATE_OR_INVALID_ID');
});
test('16 process observation duplicate or unrelated boot is HOLD', () => {
  assert.equal(result(sample({probes:[]})).reason,'CURRENT_PROCESS_PROBE_NOT_UNIQUE');
  const p={pid:4444,currentBootId:newBoot,state:'absent'};
  assert.equal(result(sample({probes:[p,p]})).reason,'CURRENT_PROCESS_PROBE_NOT_UNIQUE');
  assert.equal(result(sample({probes:[{...p,currentBootId:'other-boot'}]})).reason,'CURRENT_PROCESS_PROBE_NOT_UNIQUE');
});
test('17 malicious malformed envelope is HOLD and never throws',()=>{
  for(const raw of ['{not-json','null','{}','[]', JSON.stringify(sample({boot:null})), JSON.stringify(sample({review:null}))]){
    const out=previewR13SyntheticManifest(raw);
    assert.equal(out.status,'HOLD');assert.equal(out.canReleaseReservation,false);
  }
});
test('18 marker kind unrecognized is HOLD',()=>{
  const e=encoded({...marker,mutationKind:'unexpected'});
  assert.equal(result(sample({markers:[e]})).reason,'LEGACY_OR_UNRECOGNIZED_KIND');
});
test('19 rejected original process age and reboot mismatch',()=>{
  const old=encoded({...marker,osProcessCreationMs:1792750000001});
  assert.equal(result(sample({markers:[old]})).reason,'BOOT_IDENTITY_CLAIM_NOT_CONSISTENT');
  const e=encoded({...marker,originBootId:'different'});
  assert.equal(result(sample({markers:[e]})).reason,'BOOT_IDENTITY_CLAIM_NOT_CONSISTENT');
});
test('20 a missing true source digest cannot silently pass',()=>{
  const e=encoded();assert.equal(result(sample({markers:[{...e,expectedSha256:undefined}]})).reason,'SOURCE_BYTES_OR_HASH_MISSING');
});
test('21 a wrong version inside the source is HOLD',()=>{
  const e=encoded({...marker,version:2});
  assert.equal(result(sample({markers:[e]})).reason,'MARKER_RECORD_ID_MISMATCH');
});
test('22 a rejected item cannot enter quarantine simulation',()=>{
  const a=result(sample({markers:[encoded({...marker,legacy:true})]}));
  const out=simulateR13QuarantineAudit(a,'[]');
  assert.equal(out.phase,'HOLD'); assert.equal(out.mayReleaseReservation,false);
});
const phases=['LOCKED_PREVIEW','ORIGINAL_COPY_INSPECTED','OWNER_SCOPE_REVIEWED','QUARANTINE_SIMULATED'];
const auditEvents=(item=result())=>JSON.stringify(phases.map((phase,i)=>({eventId:'e'+i,phase,expectedRevision:i,taskId:item.taskId,fingerprintSha256:item.sourceFingerprintSha256})));
test('23 exact four-phase simulated journal has a stable audit digest but never writes live',()=>{
  const x=simulateR13QuarantineAudit(result(),auditEvents());
  assert.equal(x.phase,'SIMULATED_QUARANTINE_REVIEW_COMPLETE');
  assert.equal(x.revision,4);assert.equal(x.canWriteLive,false);assert.equal(x.mayReleaseReservation,false);
  assert.equal(x.auditDigestSha256.length,64);
});
test('24 reordering and stale CAS step are HOLD not repeated success',()=>{
  const item=result();
  const e=JSON.parse(auditEvents(item));
  e[2].expectedRevision=1;
  assert.equal(simulateR13QuarantineAudit(item,JSON.stringify(e)).phase,'HOLD');
  const e2=JSON.parse(auditEvents(item));e2[1].phase=e2[0].phase;
  assert.equal(simulateR13QuarantineAudit(item,JSON.stringify(e2)).phase,'HOLD');
});
test('25 duplicate journal event ID and wrong fingerprint are HOLD',()=>{
  const a=result(),e=JSON.parse(auditEvents(a));e[1].eventId=e[0].eventId;
  assert.equal(simulateR13QuarantineAudit(a,JSON.stringify(e)).phase,'HOLD');
  const e2=JSON.parse(auditEvents(a));e2[2].fingerprintSha256='0'.repeat(64);
  assert.equal(simulateR13QuarantineAudit(a,JSON.stringify(e2)).phase,'HOLD');
});
test('26 incomplete audit input simulates failure and keeps Host admission closed',()=>{
  const a=result();
  for(const raw of ['not-json','[]',JSON.stringify(JSON.parse(auditEvents(a)).slice(0,2))]){
    const q=simulateR13QuarantineAudit(a,raw);
    assert.equal(q.phase,'HOLD');assert.equal(q.canWriteLive,false);
  }
});
test('27 legacy source must not be interpreted as missing receipt for opaque entries',()=>{
  const e=encoded({...marker,mutationKind:'opaque',nativeReceiptPath:undefined,originBootId:undefined});
  assert.equal(result(sample({markers:[e]})).reason,'ORIGINAL_WINDOWS_IDENTITY_NOT_PERSISTED');
});
test('28 out-of-scope marker and in-scope marker are distinguished, never released in a batch',()=>{
  const cross=encoded({...marker,taskId:'task-other',ownerWorkspaceId:'another-workspace',launcherPid:4445});
  const out=analyze(sample({expectedCount:2,markers:[encoded(),cross],review:{scope:'staging_only',approved:true,items:[reviewItem()]},probes:[{pid:4444,currentBootId:newBoot,state:'absent'},{pid:4445,currentBootId:newBoot,state:'absent'}]}));
  assert.equal(out.readyForReview,1);assert.equal(out.held,1);assert.equal(out.canReleaseReservation,false);assert.equal(out.status,'HOLD');
});

test('29 origin Host identity must be recorded and match snapshot host', () => {
  const wrong = encoded({ ...marker, originHostId: 'different-host' });
  assert.equal(result(sample({ markers: [wrong] })).reason, 'BOOT_IDENTITY_CLAIM_NOT_CONSISTENT');
  const missing = encoded({ ...marker, originHostId: undefined });
  assert.equal(result(sample({ markers: [missing] })).reason, 'ORIGINAL_WINDOWS_IDENTITY_NOT_PERSISTED');
});
test('30 claimed boot source must match snapshot Host identity', () => {
  const crossHost = { ...boot, hostId: 'other-host' };
  assert.equal(result(sample({ boot: crossHost })).reason, 'BOOT_IDENTITY_CLAIM_NOT_CONSISTENT');
});

test('31 duplicate top-level JSON keys never override earlier conflicting host identity', () => {
  const raw = JSON.stringify(sample()).replace('"hostId":"synthetic-host-a"', '"hostId":"other-host","hostId":"synthetic-host-a"');
  const out = previewR13SyntheticManifest(raw);
  assert.equal(out.status, 'HOLD');
  assert.equal(out.error, 'MANIFEST_NONCANONICAL_OR_DUPLICATE_KEYS');
  assert.equal(out.canReleaseReservation, false);
});
test('32 duplicate nested reviewer identity is rejected even if last value is correct', () => {
  const raw = JSON.stringify(sample()).replace('"taskId":"task-alpha","ownerWorkspaceId"', '"taskId":"wrong","taskId":"task-alpha","ownerWorkspaceId"');
  const out = previewR13SyntheticManifest(raw);
  assert.equal(out.status, 'HOLD');
  assert.equal(out.error, 'MANIFEST_NONCANONICAL_OR_DUPLICATE_KEYS');
});
test('33 duplicate keys in a simulated audit cannot produce a success status', () => {
  const item=result();
  const raw=auditEvents(item).replace('"taskId":"task-alpha"','"taskId":"wrong","taskId":"task-alpha"');
  const out=simulateR13QuarantineAudit(item,raw);
  assert.equal(out.phase,'HOLD');
  assert.equal(out.error,'AUDIT_NONCANONICAL_OR_DUPLICATE_KEYS');
  assert.equal(out.mayReleaseReservation,false);
});
test('34 unusually nested JSON fails closed rather than throwing outside catch', () => {
  const deep = '{"x":'.repeat(9000)+'0'+'}'.repeat(9000);
  const original=JSON.stringify(sample());
  const payload=original.slice(0,-1)+',"unusedDeep":'+deep+'}';
  const out=previewR13SyntheticManifest(payload);
  assert.equal(out.status,'HOLD');
  assert.equal(out.canMutateHost,false);
});
