from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
import r20_maintenance_sim as r20


@pytest.fixture
def fx():
    path = r20.make_fixture()
    try:
        yield path
    finally:
        shutil.rmtree(path,ignore_errors=True)


def snap(p: Path):
    return {"markers":r20._marker_map(p),"rows":r20._call_rows(p)}


def foreign_snapshot(p: Path):
    return {k:v for k,v in r20._marker_map(p).items() if k not in {n for n,_,_ in r20.CANDIDATES}}


def readall(p: Path):
    return r20.read_json(p)


def test_fixture_synthetic_only(fx):
    assert (fx/r20.SENTINEL).read_text() == r20.SCHEMA+'\n'
    assert r20._marker_map(fx).__len__()==20
    assert len(r20._call_rows(fx))==4


def test_initial_denied_capacity(fx):
    snap=r20.admission_snapshot(fx)
    assert snap["status"]=="DENIED_CAPACITY" and snap["count"]==20
    assert snap["liveApproved"] is False


def test_staging_normal_success(fx):
    before=foreign_snapshot(fx)
    assert r20.prepare(fx)["backups"]==22
    assert r20.verify_scratch_restore(fx)["status"]=="SCRATCH_RESTORE_PASS_SYNTHETIC"
    assert r20.admission_snapshot(fx)["status"]=="DENIED_MAINTENANCE_EPOCH"
    receipt=r20.retire(fx)
    assert receipt["historicalOutcome"]=="UNKNOWN"
    assert receipt["forgedNativeReceipt"] is False
    assert len(r20._marker_map(fx))==15
    assert len(r20._call_rows(fx))==3
    assert before==foreign_snapshot(fx)
    assert r20.admission_snapshot(fx)["status"]=="DENIED_MAINTENANCE_EPOCH"
    assert r20.release_epoch(fx)["status"]=="FINISHED_SYNTHETIC"
    x=r20.admission_snapshot(fx)
    assert x["status"]=="SYNTHETIC_CAPACITY_AVAILABLE" and x["globalWriterBarrierVerified"] is False


def test_retirement_quarantine_retained_after_completion(fx):
    r20.prepare(fx);r20.retire(fx);r20.release_epoch(fx)
    for name,_,_ in r20.CANDIDATES:
        assert (fx/'quarantine'/name).is_file()
        assert not (fx/'global'/name).exists()


def test_rollback_from_prepared(fx):
    before=snap(fx)
    r20.prepare(fx)
    assert r20.rollback(fx)["status"]=="ROLLED_BACK_SYNTHETIC"
    assert before==snap(fx)
    assert not (fx/'r20-epoch-block.json').exists()


@pytest.mark.parametrize("failpoint",["after_quarantine_1","after_quarantine_2","after_quarantine_3","after_quarantine_4","after_quarantine_5","after_all_quarantined_journal","after_writer_commit","after_writer_journal","after_receipt","after_verified"])
def test_crash_and_rollback_all_apply_points(fx,failpoint):
    before=snap(fx)
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):
        r20.retire(fx,failpoint)
    assert r20.admission_snapshot(fx)["status"]=="DENIED_MAINTENANCE_EPOCH"
    assert r20.rollback(fx)["status"]=="ROLLED_BACK_SYNTHETIC"
    assert snap(fx)==before
    assert r20.rollback(fx)["status"]=="ROLLED_BACK_SYNTHETIC"


@pytest.mark.parametrize("failpoint",["after_journal_prepare","after_epoch_flag"])
def test_prepare_journal_crash_and_recovery(fx,failpoint):
    before=snap(fx)
    with pytest.raises(r20.SyntheticCrash):r20.prepare(fx,failpoint)
    assert r20.admission_snapshot(fx)["status"]=="DENIED_MAINTENANCE_EPOCH"
    assert r20.verify_scratch_restore(fx)["markers"]==20
    assert r20.rollback(fx)["status"]=="ROLLED_BACK_SYNTHETIC"
    assert snap(fx)==before


@pytest.mark.parametrize("failpoint",["after_marker_backup","after_sqlite_backup"])
def test_prepare_before_durable_journal_requires_no_live_recovery(fx,failpoint):
    before=snap(fx)
    with pytest.raises(r20.SyntheticCrash):r20.prepare(fx,failpoint)
    assert snap(fx)==before
    assert r20.admission_snapshot(fx)["status"]=="DENIED_CAPACITY"
    assert not (fx/'r20-intent.json').exists()


def test_crash_release_finishes_idempotently(fx):
    r20.prepare(fx);r20.retire(fx)
    with pytest.raises(r20.SyntheticCrash):r20.release_epoch(fx,"after_finished_journal")
    assert r20.admission_snapshot(fx)["status"]=="DENIED_MAINTENANCE_EPOCH"
    assert r20.release_epoch(fx)["status"]=="FINISHED_SYNTHETIC"
    assert r20.release_epoch(fx)["status"]=="FINISHED_SYNTHETIC"


@pytest.mark.parametrize("failpoint",["after_restore_writer","after_restore_marker_1","after_restore_marker_2","after_restore_marker_3","after_restore_marker_4","after_restore_marker_5","after_rollback_journal"])
def test_crash_during_rollback_can_resume(fx,failpoint):
    before=snap(fx)
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,"after_writer_commit")
    with pytest.raises(r20.SyntheticCrash):r20.rollback(fx,failpoint)
    if failpoint=="after_rollback_journal":
        # Intent is marked rolled back; release of epoch is a distinct final step.
        assert (fx/'r20-epoch-block.json').exists()
        assert snap(fx)==before
    else:
        assert r20.rollback(fx)["status"]=="ROLLED_BACK_SYNTHETIC"
        assert snap(fx)==before


def test_no_raw_host_path_cli():
    cp=subprocess.run([sys.executable,str(ROOT/'r20_maintenance_sim.py'),'--root',r'C:\SYNTHETIC_NOT_REAL_HOST\dummy'],capture_output=True,text=True)
    assert cp.returncode!=0
    assert 'NO_REAL_HOST_ACTIONS' in cp.stderr


def test_synthetic_demo_cleans_itself():
    cp=subprocess.run([sys.executable,str(ROOT/'r20_maintenance_sim.py'),'--synthetic-demo'],capture_output=True,text=True)
    assert cp.returncode==0
    j=json.loads(cp.stdout)
    assert j['before']['count']==20 and j['after']['count']==15
    assert j['liveApproved'] is False and j['canReleaseAnyHostMarker'] is False
    assert j['after']['globalWriterBarrierVerified'] is False


@pytest.mark.parametrize("bad",["/",str(Path.home()),"/tmp",r'C:\SYNTHETIC_NOT_REAL_HOST\dummy',str(Path(__file__).resolve().parent)])
def test_refuse_untrusted_roots(bad):
    with pytest.raises((r20.FailClosed,OSError)):
        r20.admission_snapshot(Path(bad))


def test_sentinel_tamper_denies(fx):
    (fx/r20.SENTINEL).write_text('not synthetic\n')
    with pytest.raises(r20.FailClosed,match='SENTINEL'):
        r20.prepare(fx)


def test_attempt_to_use_relative_root_denies():
    with pytest.raises(r20.FailClosed):r20.admission_snapshot(Path('.'))


def test_duplicate_prepare_denied(fx):
    r20.prepare(fx)
    with pytest.raises(r20.FailClosed,match='UNRESOLVED'):
        r20.prepare(fx)


def test_apply_without_prepare_denied(fx):
    with pytest.raises(r20.FailClosed,match='PREPARE_REQUIRED'):r20.retire(fx)


def test_release_without_prepare_denied(fx):
    with pytest.raises(r20.FailClosed,match="UNTRUSTED_JSON_SOURCE"):r20.release_epoch(fx)


def test_release_before_verified_denied(fx):
    r20.prepare(fx)
    with pytest.raises(r20.FailClosed,match='VERIFICATION_REQUIRED'):
        r20.release_epoch(fx)


def test_attacker_tampers_foreign_marker_before_prepare(fx):
    n=next(n for n in r20._marker_map(fx) if n not in [x[0] for x in r20.CANDIDATES])
    (fx/'global'/n).write_text('{"unexpected":true}')
    # Baseline fixture alone has no trusted original external HASH; the
    # snapshot captures the modified fixture. Mutation after PREPARE is guarded.
    r20.prepare(fx)
    with pytest.raises(r20.FailClosed):
        (fx/'global'/n).write_text('tampered after intent')
        r20.retire(fx)


def test_foreign_marker_after_prepare_fails_before_move(fx):
    r20.prepare(fx)
    n=next(n for n in r20._marker_map(fx) if n not in [x[0] for x in r20.CANDIDATES])
    (fx/'global'/n).write_text('malicious change')
    with pytest.raises(r20.FailClosed,match='FOREIGN'):
        r20.retire(fx)
    assert all((fx/'global'/x[0]).is_file() for x in r20.CANDIDATES)


def test_candidate_drift_after_prepare_fails_before_move(fx):
    r20.prepare(fx)
    n=r20.CANDIDATES[0][0]
    (fx/'global'/n).write_text('bad candidate')
    with pytest.raises(r20.FailClosed,match='GLOBAL_MARKER_COUNT_DRIFT|CANDIDATE'):
        r20.retire(fx)


def test_foreign_writer_row_drift_rolls_back_denied(fx):
    r20.prepare(fx)
    with __import__('contextlib').closing(__import__('sqlite3').connect(r20._db(fx,'writer'))) as db:
        db.execute('UPDATE workspace_writer_calls SET pid=pid+1 WHERE call_id=?',(r20.FOREIGN[0],))
        db.commit()
    with pytest.raises(r20.FailClosed,match='FOREIGN_WRITER'):
        r20.retire(fx)


def test_foreign_writer_row_drift_blocks_rollback(fx):
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_quarantine_1')
    with __import__('contextlib').closing(__import__('sqlite3').connect(r20._db(fx,'writer'))) as db:
        db.execute('UPDATE workspace_writer_calls SET pid=pid+1 WHERE call_id=?',(r20.FOREIGN[0],))
        db.commit()
    with pytest.raises(r20.FailClosed,match='FOREIGN_WRITER_ROW'):
        r20.rollback(fx)


def test_candidate_missing_after_prepare_denies(fx):
    r20.prepare(fx)
    (fx/'global'/r20.CANDIDATES[0][0]).unlink()
    with pytest.raises(r20.FailClosed,match='GLOBAL_MARKER_COUNT_DRIFT|CANDIDATE'):
        r20.retire(fx)


def test_added_marker_after_prepare_denies(fx):
    r20.prepare(fx)
    n=hashlib.sha256(b'attacker-added-marker').hexdigest()+'.json'
    (fx/'global'/n).write_text('{}')
    with pytest.raises(r20.FailClosed,match='GLOBAL_MARKER_COUNT_DRIFT'):
        r20.retire(fx)


def test_quarantine_corruption_blocks_rollback(fx):
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_quarantine_1')
    (fx/'quarantine'/r20.CANDIDATES[0][0]).write_text('{}')
    with pytest.raises(r20.FailClosed,match='QUARANTINED_CANDIDATE_HASH_DRIFT'):
        r20.rollback(fx)


def test_sqlite_backup_corruption_detected(fx):
    r20.prepare(fx)
    (fx/'backup'/'writer.sqlite').write_bytes(b'corrupted')
    with pytest.raises(r20.FailClosed,match='SCRATCH_SQLITE_INPUT_SHA'):
        r20.verify_scratch_restore(fx)


def test_marker_backup_corruption_detected(fx):
    r20.prepare(fx)
    (fx/'backup'/r20.CANDIDATES[1][0]).write_text('corrupted')
    with pytest.raises(r20.FailClosed,match='SCRATCH_MARKER_HASH'):
        r20.verify_scratch_restore(fx)


def test_refuses_additional_main_db_mutation(fx):
    r20.prepare(fx)
    with __import__('contextlib').closing(__import__('sqlite3').connect(r20._db(fx,'main'))) as db:
        db.execute("INSERT INTO audit_events VALUES ('new','actor','DONE','x')")
        db.commit()
    with pytest.raises(r20.FailClosed,match='MAIN_AUDIT_LOGICAL_DRIFT'):
        r20.retire(fx)


def test_rollback_same_writer_call_not_duplicated(fx):
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_quarantine_5')
    out=r20.rollback(fx)
    assert out['status']=='ROLLED_BACK_SYNTHETIC'
    assert len([row for row in r20._call_rows(fx) if row[1]==r20.CALL])==1


def test_lock_conflict_cross_process(fx):
    code = 'import sys; sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;\ntry:\n with m.lock(Path(sys.argv[2])):print("FAIL")\nexcept m.FailClosed as e:print(str(e))'
    with r20.lock(fx):
        cp=subprocess.run([sys.executable,'-c',code,str(ROOT),str(fx)],capture_output=True,text=True,timeout=10)
    assert cp.returncode==0
    assert 'LOCK_BUSY' in cp.stdout


def test_lock_allows_second_process_after_release(fx):
    code='import sys; sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;\nwith m.lock(Path(sys.argv[2])): print("OK")'
    cp=subprocess.run([sys.executable,'-c',code,str(ROOT),str(fx)],capture_output=True,text=True,timeout=10)
    assert cp.returncode==0 and 'OK' in cp.stdout


def test_mutation_while_locked_is_denied_from_other_process(fx):
    code='import sys; sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;\ntry:\n print(m.admission_snapshot(Path(sys.argv[2])))\nexcept m.FailClosed as e: print(str(e))'
    with r20.lock(fx):
        cp=subprocess.run([sys.executable,'-c',code,str(ROOT),str(fx)],capture_output=True,text=True,timeout=10)
    assert cp.returncode==0 and 'LOCK_BUSY' in cp.stdout


def test_synthetic_journal_cannot_give_live_authority(fx):
    r20.prepare(fx);j=readall(fx/'r20-intent.json')
    assert j['syntheticOnly'] is True
    assert 'liveApproved' not in j
    assert j['historicalOutcomes']=='UNKNOWN'


def test_no_fabricated_native_completion_receipt(fx):
    r20.prepare(fx);r20.retire(fx)
    assert not list(fx.rglob('containment.receipt.json'))
    j=readall(fx/'synthetic-retirement.json')
    assert j['forgedNativeReceipt'] is False


def test_backup_manifest_keeps_all20_hashes(fx):
    r20.prepare(fx)
    b=readall(fx/'backup'/'manifest.json')
    assert len(b['markerSHA256'])==20
    assert set(b['databaseSHA256'])=={'writer','main'}
    assert len(b['writerRows'])==4


def test_live_hardcoded_path_refused_by_guard():
    with pytest.raises(r20.FailClosed):
        r20._check_root(Path(r'C:\SYNTHETIC_NOT_REAL_HOST\dummy'))


@pytest.mark.parametrize('fault', ['after_quarantine_1','after_quarantine_3','after_quarantine_5','after_writer_commit','after_verified'])
def test_real_process_death_mid_retirement_fail_closed_and_restorable(fx,fault):
    """Forcibly exit an independent child interpreter without cleanup handlers."""
    before=snap(fx)
    r20.prepare(fx)
    script=(
        'import os,sys;sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;'
        'm._fault=lambda want,name: os._exit(62) if want==name else None;'
        'm.retire(Path(sys.argv[2]),sys.argv[3])'
    )
    proc=subprocess.run([sys.executable,'-c',script,str(ROOT),str(fx),fault],capture_output=True,text=True,timeout=20)
    assert proc.returncode==62
    assert r20.admission_snapshot(fx)['status']=='DENIED_MAINTENANCE_EPOCH'
    assert r20.rollback(fx)['status']=='ROLLED_BACK_SYNTHETIC'
    assert snap(fx)==before


def test_real_process_death_mid_rollback_is_recoverable(fx):
    before=snap(fx)
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_writer_commit')
    script=(
        'import os,sys;sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;'
        'm._fault=lambda want,name: os._exit(62) if want==name else None;'
        'm.rollback(Path(sys.argv[2]),sys.argv[3])'
    )
    proc=subprocess.run([sys.executable,'-c',script,str(ROOT),str(fx),'after_restore_marker_3'],capture_output=True,text=True,timeout=20)
    assert proc.returncode==62
    assert r20.admission_snapshot(fx)['status']=='DENIED_MAINTENANCE_EPOCH'
    assert r20.rollback(fx)['status']=='ROLLED_BACK_SYNTHETIC'
    assert snap(fx)==before


def test_crashed_after_rollback_journal_releases_fence_when_reconciled(fx):
    before=snap(fx)
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_quarantine_1')
    with pytest.raises(r20.SyntheticCrash):r20.rollback(fx,'after_rollback_journal')
    assert r20.admission_snapshot(fx)['status']=='DENIED_MAINTENANCE_EPOCH'
    assert r20.rollback(fx)['status']=='ROLLED_BACK_SYNTHETIC'
    assert snap(fx)==before
    assert not (fx/'r20-epoch-block.json').exists()


def test_retirement_receipt_revoked_on_rollback(fx):
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_verified')
    assert readall(fx/'synthetic-retirement.json')['status']=='SIMULATED_ADMINISTRATIVE_RETIREMENT'
    r20.rollback(fx)
    assert readall(fx/'synthetic-retirement.json')['status']=='SYNTHETIC_RETIREMENT_ROLLED_BACK'


def test_rollback_not_permitted_after_epoch_release(fx):
    r20.prepare(fx);r20.retire(fx);r20.release_epoch(fx)
    with pytest.raises(r20.FailClosed,match='NO_ROLLBACK_AFTER_RELEASE'):
        r20.rollback(fx)


def test_journal_tamper_attempt_at_allowlist_denied(fx):
    r20.prepare(fx)
    p=fx/'r20-intent.json'; j=readall(p)
    j['candidates'][0]=next(name for name in r20._marker_map(fx) if name not in j['candidates'])
    p.write_text(json.dumps(j))
    with pytest.raises(r20.FailClosed,match='JOURNAL_IMMUTABLE_MANIFEST_MISMATCH'):
        r20.retire(fx)


def test_manifest_tamper_attempt_denied(fx):
    r20.prepare(fx)
    p=fx/'backup'/'manifest.json'; j=readall(p)
    j['candidates'][0]='../../host.sqlite'
    p.write_text(json.dumps(j))
    with pytest.raises(r20.FailClosed,match='JOURNAL_IMMUTABLE_MANIFEST_MISMATCH'):
        r20.retire(fx)


def test_symlinked_marker_rejected_by_immutable_hash(fx):
    name=r20.CANDIDATES[0][0]
    marker=fx/'global'/name
    content=marker.read_bytes();marker.unlink()
    external=fx/'backup'/'fake-source.json'
    external.write_bytes(content)
    try:marker.symlink_to(external)
    except (OSError,NotImplementedError):pytest.skip('symlink unavailable')
    with pytest.raises(r20.FailClosed,match='SYMLINK_OR_MISSING_SOURCE_REFUSED'):
        r20.prepare(fx)


def test_symlinked_journal_rejected(fx):
    r20.prepare(fx)
    original=fx/'r20-intent.json';copy_path=fx/'backup'/'journal-copy.json'
    copy_path.write_bytes(original.read_bytes());original.unlink()
    try:original.symlink_to(copy_path)
    except (OSError,NotImplementedError):pytest.skip('symlink unavailable')
    with pytest.raises(r20.FailClosed,match='UNTRUSTED_JSON_SOURCE'):
        r20.retire(fx)


def test_preboot_original_task_outcome_always_unknown(fx):
    for name,owner,task in r20.CANDIDATES:
        obj=readall(fx/'global'/name)
        assert obj['historicalOutcome']=='UNKNOWN'
    r20.prepare(fx);r20.retire(fx);r20.release_epoch(fx)
    receipt=readall(fx/'synthetic-retirement.json')
    assert receipt['historicalOutcome']=='UNKNOWN'
    assert not (fx/'containment.receipt.json').exists()


def test_original_marker_backups_independent_of_current_simulated_state(fx):
    original=snap(fx)
    r20.prepare(fx);r20.retire(fx);r20.release_epoch(fx)
    snapshot=readall(fx/'backup'/'manifest.json')
    assert snapshot['markerSHA256']==original['markers']
    assert snapshot['writerRows']==[list(x) for x in original['rows']]
    assert r20.verify_scratch_restore(fx)['sqlite']==2


def test_remaining_capacity_cannot_claim_global_writer_probe_clear(fx):
    r20.prepare(fx);r20.retire(fx);r20.release_epoch(fx)
    r=r20.admission_snapshot(fx)
    assert r['count']==15 and r['globalWriterBarrierVerified'] is False


def test_journal_and_flag_opid_mismatch_denied(fx):
    r20.prepare(fx)
    flag=fx/'r20-epoch-block.json';j=readall(flag);j['opID']='wrong'
    flag.write_text(json.dumps(j))
    with pytest.raises(r20.FailClosed,match='EPOCH_IDENTITY_MISMATCH'):
        r20.retire(fx)


def test_main_audit_writer_drift_blocks_rollback(fx):
    r20.prepare(fx)
    with pytest.raises(r20.SyntheticCrash):r20.retire(fx,'after_quarantine_1')
    with __import__('contextlib').closing(__import__('sqlite3').connect(r20._db(fx,'main'))) as db:
        db.execute("INSERT INTO audit_events VALUES ('bad','other','mutated','x')")
        db.commit()
    with pytest.raises(r20.FailClosed,match='MAIN_AUDIT_LOGICAL_DRIFT'):
        r20.rollback(fx)


def test_fence_denies_new_writers_with_two_processes(fx):
    r20.prepare(fx)
    script='import sys;sys.path.insert(0,sys.argv[1]);import r20_maintenance_sim as m;from pathlib import Path;print(m.admission_snapshot(Path(sys.argv[2]))["status"])'
    one=subprocess.Popen([sys.executable,'-c',script,str(ROOT),str(fx)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    two=subprocess.Popen([sys.executable,'-c',script,str(ROOT),str(fx)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    for proc in (one,two):
        o,err=proc.communicate(timeout=10)
        assert proc.returncode==0,err
        assert 'DENIED_MAINTENANCE_EPOCH' in o