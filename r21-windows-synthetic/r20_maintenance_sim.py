#!/usr/bin/env python3
"""PANYA R20: crash-recoverable, cross-process SYNTHETIC maintenance lab.

This code is intentionally incapable of operating on a real lnwjud profile:
all roots must be purpose-created temporary fixtures; neither live Windows
Host paths nor arbitrary file paths are accepted by the command-line entry.
No native receipt is ever created and no real Host authorization is inferred.
"""
from __future__ import annotations

from contextlib import contextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid

SCHEMA = "panya-r20-synthetic-maintenance-v1"
SENTINEL = ".panya-r20-synthetic-sentinel"
PREFIX = "panya-r20-fixture-"
DEV = "1fbe248a-5c01-54a7-b73c-22745091088a"
AI = "3dccb12a-d1cc-53bb-b4ab-9e70e62527ee"
GUARD = "d43ebd13-7961-5236-a5ef-3ab7f008811f"
CALL = "347b56e4-3bcb-5879-b963-dbbd6b1ad300"
CANDIDATES = (
    ("4d6f8db184a7e658b5e6aacd08a183f0d188c62c095c507a8b28120a00ed2a0a.json", DEV, "managed-writer-70c97e4c-bb53-5565-bec0-182b95dabb06"),
    ("3f6ca62fa0187437db9ff96d22810802f4ae08aec5c978364a9054bb77cea7bd.json", DEV, "managed-writer-40ce15bb-a565-5b26-b80b-33738e709427"),
    ("b1aa98bde2b8269a83d0410623c5f18fcfb22637381727977df9bc7401121c91.json", AI, "d95e90e4-1891-56e5-b4e4-651709dd5bd2"),
    ("c0f9b2fb27b43891e6e593e797b9f26292748ae476ef45cd687e261c0b262500.json", AI, "e8ee9f14-3761-503a-9f29-dbfd06111d89"),
    ("171fd2ca053bcb2eaf7e30fcff5782dd41c2ab8d2934ca51c192ee14c2838413.json", AI, "2f24b67c-575d-5970-a403-60fe688733d4"),
)
FOREIGN = (
    "ddbb087a-5e4f-54d3-a811-089f982f6dbd",
    "e74017fc-5954-557a-892e-00a8e2f617e0",
    "27256fa6-2113-5ccb-a42a-57adf5bf4e93",
)
MARK_RE = re.compile(r"^[0-9a-f]{64}\.json$")


class FailClosed(RuntimeError):
    pass


class SyntheticCrash(RuntimeError):
    pass


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def bytes_hash(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise FailClosed("SYMLINK_OR_MISSING_SOURCE_REFUSED")
    return sha(path.read_bytes())


def _sync_dir(path: Path) -> None:
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_atomic(path: Path, content: bytes) -> None:
    if path.exists() and path.is_symlink():
        raise FailClosed("SYMLINK_DESTINATION_REFUSED")
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with open(temp, "xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        _sync_dir(path.parent)
    finally:
        if temp.exists():
            temp.unlink()


def jbytes(x: dict) -> bytes:
    return (json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf8")


def read_json(p: Path) -> dict:
    if p.is_symlink() or not p.is_file():
        raise FailClosed("UNTRUSTED_JSON_SOURCE")
    x = json.loads(p.read_text(encoding="utf8"))
    if not isinstance(x, dict):
        raise FailClosed("JSON_EXPECTED_OBJECT")
    return x


def _check_root(root: Path) -> Path:
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise FailClosed("SYNTHETIC_FIXTURE_REQUIRED")
    temp = Path(tempfile.gettempdir()).resolve(strict=True)
    full = root.resolve(strict=True)
    if full.parent != temp or not full.name.startswith(PREFIX):
        raise FailClosed("LIVE_OR_EXTERNAL_PATH_REFUSED")
    if not (full / SENTINEL).is_file() or (full / SENTINEL).is_symlink():
        raise FailClosed("SYNTHETIC_SENTINEL_MISSING")
    if (full / SENTINEL).read_text(encoding="ascii") != SCHEMA + "\n":
        raise FailClosed("SYNTHETIC_SENTINEL_MISMATCH")
    for name in ("global", "backup", "quarantine", "db"):
        p = full / name
        if not p.is_dir() or p.is_symlink():
            raise FailClosed("UNTRUSTED_FIXTURE_DIRECTORY")
    return full


@contextmanager
def lock(root: Path):
    """OS cross-process lock for opt-in synthetic producers/maintainers only.

    The real installed Host does NOT honor this lock: it is a candidate protocol,
    not evidence that PANYA-HOME producers have been frozen.
    """
    root = _check_root(root)
    p = root / ".r20-simulation-lock"
    with open(p, "a+b") as stream:
        stream.seek(0)
        stream.write(b"0")
        stream.flush()
        if os.name == "nt":
            import msvcrt
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as e:
                raise FailClosed("LOCK_BUSY") from e
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as e:
                raise FailClosed("LOCK_BUSY") from e
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _db(root: Path, which: str) -> Path:
    return root / "db" / (which + ".sqlite")


def _call_rows(root: Path) -> list[tuple]:
    with closing(sqlite3.connect(_db(root, "writer"))) as db:
        return db.execute("SELECT workspace_id,call_id,generation,pid FROM workspace_writer_calls ORDER BY workspace_id,call_id").fetchall()


def _marker_paths(root: Path) -> list[Path]:
    return sorted(root.joinpath("global").glob("*.json"))


def _marker_map(root: Path) -> dict[str, str]:
    return {p.name: bytes_hash(p) for p in _marker_paths(root)}


def _main_rows(root: Path) -> list[tuple]:
    with closing(sqlite3.connect(_db(root, "main"))) as db:
        return db.execute("SELECT id,action,result_code,details FROM audit_events ORDER BY id").fetchall()


def _check_db(root: Path, which: str) -> None:
    with closing(sqlite3.connect(_db(root, which))) as db:
        if db.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
            raise FailClosed("SQLITE_QUICK_CHECK_FAILED")


def make_fixture() -> Path:
    root = Path(tempfile.mkdtemp(prefix=PREFIX)).resolve()
    (root / SENTINEL).write_text(SCHEMA + "\n", encoding="ascii")
    for name in ("global", "backup", "quarantine", "db"):
        (root / name).mkdir()
    with closing(sqlite3.connect(_db(root, "writer"))) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE workspace_writer_calls(call_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,generation INTEGER NOT NULL,pid INTEGER NOT NULL)")
        db.execute("CREATE TABLE workspace_writer_leases(workspace_id TEXT PRIMARY KEY,lease_id TEXT)")
        db.execute("INSERT INTO workspace_writer_calls VALUES (?,?,?,?)", (CALL, DEV, 0, 50000))
        for c in FOREIGN:
            db.execute("INSERT INTO workspace_writer_calls VALUES (?,?,?,?)", (c, GUARD, 0, 82424))
        db.commit()
    with closing(sqlite3.connect(_db(root, "main"))) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE audit_events(id TEXT PRIMARY KEY,action TEXT,result_code TEXT,details TEXT)")
        db.execute("INSERT INTO audit_events VALUES (?,?,?,?)", ("simulation-stop", "mcp_tool:process_stop", "STARTED", CALL))
        db.commit()
    for i, (name, owner, task) in enumerate(CANDIDATES):
        obj = {"schema": SCHEMA, "source": "SYNTHETIC_FIXTURE_NOT_HOST", "taskId": task,
               "ownerWorkspaceId": owner, "marker": name, "historicalOutcome": "UNKNOWN",
               "reservedAt": f"2026-10-{20 if i >= 2 else 23:02d}T05:00:00Z"}
        (root / "global" / name).write_bytes(jbytes(obj))
    for i in range(15):
        name = hashlib.sha256(f"panya-r20-synthetic-protected-{i}".encode()).hexdigest() + ".json"
        owner = GUARD if i < 4 else None if i == 4 else "other-synthetic-workspace"
        obj = {"schema": SCHEMA, "source": "SYNTHETIC_FIXTURE_NOT_HOST", "taskId": "foreign-"+str(i),
               "ownerWorkspaceId": owner,"historicalOutcome":"UNKNOWN", "marker": name}
        (root / "global" / name).write_bytes(jbytes(obj))
    _check_root(root)
    return root


def _preflight(root: Path) -> tuple[dict[str,str], list[tuple], tuple[str,...]]:
    markers = _marker_map(root)
    if len(markers) != 20 or any(not MARK_RE.fullmatch(k) for k in markers):
        raise FailClosed("GLOBAL_20_MARKER_INVENTORY_DRIFT")
    candidates = tuple(n for n, _, _ in CANDIDATES)
    if not set(candidates).issubset(markers):
        raise FailClosed("FIVE_CANDIDATES_MISSING")
    for name, owner, task in CANDIDATES:
        m = read_json(root / "global" / name)
        if m.get("source") != "SYNTHETIC_FIXTURE_NOT_HOST" or m.get("ownerWorkspaceId") != owner or m.get("taskId") != task or m.get("historicalOutcome") != "UNKNOWN":
            raise FailClosed("CANDIDATE_IDENTITY_OR_OWNER_DRIFT")
    rows = _call_rows(root)
    want = sorted([(DEV, CALL, 0, 50000)] + [(GUARD, c, 0, 82424) for c in FOREIGN])
    if rows != want:
        raise FailClosed("WRITER_ROW_PREIMAGE_DRIFT")
    for dbname in ("writer", "main"):
        _check_db(root, dbname)
    return markers, rows, candidates


def _journal(root: Path) -> Path:
    return root / "r20-intent.json"


def _flag(root: Path) -> Path:
    return root / "r20-epoch-block.json"


def _status(root: Path) -> dict:
    j=read_json(_journal(root))
    # The immutable capture contract binds the journal to the exact allowlist.
    # An altered phase still requires a separate fence and readback checks.
    manifest=read_json(root / "backup" / "manifest.json")
    fields=("schema","markerSHA256","databaseSHA256","writerRows","mainAuditRows","candidates","historicalOutcomes","foreignCallIDs","syntheticOnly")
    if any(j.get(field)!=manifest.get(field) for field in fields):
        raise FailClosed("JOURNAL_IMMUTABLE_MANIFEST_MISMATCH")
    if tuple(j.get("candidates",[]))!=tuple(x[0] for x in CANDIDATES):
        raise FailClosed("JOURNAL_ALLOWLIST_TAMPER")
    if len(j.get("markerSHA256",{}))!=20 or not all(MARK_RE.fullmatch(k) for k in j["markerSHA256"]):
        raise FailClosed("JOURNAL_MARKER_SET_INVALID")
    if j.get("phase") not in {"PREPARED","FIVE_QUARANTINED","WRITER_COMMITTED","VERIFIED","FINISHED","ROLLED_BACK"}:
        raise FailClosed("JOURNAL_PHASE_INVALID")
    return j


def _update(root: Path, j: dict, phase: str) -> None:
    j = dict(j)
    j["phase"] = phase
    j["history"] = j.get("history", []) + [phase]
    write_atomic(_journal(root), jbytes(j))


def _fault(wanted: str | None, name: str) -> None:
    if wanted == name:
        raise SyntheticCrash(name)


def prepare(root: Path, failpoint: str | None = None) -> dict:
    root = _check_root(root)
    with lock(root):
        if _journal(root).exists() or _flag(root).exists():
            raise FailClosed("UNRESOLVED_MAINTENANCE_EPOCH")
        markers, rows, candidates = _preflight(root)
        for name in markers:
            dst = root / "backup" / name
            with open(dst, "xb") as f:
                content = (root / "global" / name).read_bytes()
                if sha(content) != markers[name]: raise FailClosed("PREIMAGE_CHANGED_DURING_BACKUP")
                f.write(content); f.flush(); os.fsync(f.fileno())
            if bytes_hash(dst) != markers[name]: raise FailClosed("BACKUP_READBACK_HASH_MISMATCH")
        _fault(failpoint, "after_marker_backup")
        backup_hashes = {}
        for which in ("writer", "main"):
            target = root / "backup" / (which + ".sqlite")
            with closing(sqlite3.connect(_db(root, which))) as src, closing(sqlite3.connect(target)) as dst:
                src.backup(dst)
            with closing(sqlite3.connect(target)) as db:
                if db.execute("PRAGMA quick_check(1)").fetchone()[0] != "ok":
                    raise FailClosed("BACKUP_SQLITE_INTEGRITY_FAIL")
            backup_hashes[which] = bytes_hash(target)
        _fault(failpoint, "after_sqlite_backup")
        immutable = {"schema": SCHEMA, "markerSHA256": markers, "databaseSHA256": backup_hashes,
                     "writerRows": rows, "mainAuditRows":_main_rows(root), "candidates": candidates, "historicalOutcomes": "UNKNOWN",
                     "foreignCallIDs": sorted(FOREIGN), "syntheticOnly": True}
        write_atomic(root / "backup" / "manifest.json", jbytes(immutable))
        if not all(bytes_hash(root / "backup" / name) == digest for name,digest in markers.items()):
            raise FailClosed("BACKUP_HASH_AFTER_MANIFEST_DRIFT")
        j = dict(immutable)
        j.update({"opID":str(uuid.uuid4()),"phase":"PREPARED","history":["PREPARED"]})
        write_atomic(_journal(root), jbytes(j))
        _fault(failpoint, "after_journal_prepare")
        write_atomic(_flag(root), jbytes({"schema": SCHEMA,"opID":j["opID"],"state":"ENGAGED"}))
        _fault(failpoint, "after_epoch_flag")
        return {"status":"PREPARED_SYNTHETIC", "opID":j["opID"],"backups":len(markers)+2,"liveApproved":False}


def _verify_protected(root: Path, journal: dict, *, expected_count: int) -> None:
    candidate_set = set(journal["candidates"])
    protected = {n:d for n,d in journal["markerSHA256"].items() if n not in candidate_set}
    for name,digest in protected.items():
        src = root / "global" / name
        if not src.is_file() or bytes_hash(src) != digest:
            raise FailClosed("FOREIGN_MARKER_MODIFIED_OR_REMOVED")
    if _main_rows(root)!=[tuple(x) for x in journal["mainAuditRows"]]:
        raise FailClosed("MAIN_AUDIT_LOGICAL_DRIFT")
    existing = _marker_map(root)
    if len(existing) != expected_count:
        raise FailClosed("GLOBAL_MARKER_COUNT_DRIFT")
    want = [(GUARD, c, 0, 82424) for c in FOREIGN]
    calls = _call_rows(root)
    if not set(want).issubset(set(calls)) or len([c for c in calls if c[0] == GUARD]) != len(want):
        raise FailClosed("FOREIGN_WRITER_CALLS_CHANGED")


def retire(root: Path, failpoint: str | None = None) -> dict:
    root = _check_root(root)
    with lock(root):
        if not _journal(root).is_file() or not _flag(root).is_file():
            raise FailClosed("MAINTENANCE_PREPARE_REQUIRED")
        j = _status(root)
        if j["phase"] != "PREPARED":
            raise FailClosed("RECOVERY_REQUIRED_BEFORE_RETRY")
        if read_json(_flag(root)).get("opID") != j["opID"]:
            raise FailClosed("EPOCH_IDENTITY_MISMATCH")
        _verify_protected(root,j,expected_count=20)
        for i,name in enumerate(j["candidates"],1):
            source = root / "global" / name
            quarantine = root / "quarantine" / name
            if not source.is_file() or quarantine.exists() or bytes_hash(source) != j["markerSHA256"][name]:
                raise FailClosed("CANDIDATE_PREIMAGE_DRIFT")
            os.replace(source,quarantine)
            _sync_dir(source.parent); _sync_dir(quarantine.parent)
            _fault(failpoint,f"after_quarantine_{i}")
        _update(root,j,"FIVE_QUARANTINED")
        _fault(failpoint,"after_all_quarantined_journal")
        with closing(sqlite3.connect(_db(root,"writer"))) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                x=db.execute("DELETE FROM workspace_writer_calls WHERE call_id=? AND workspace_id=? AND generation=? AND pid=?",(CALL,DEV,0,50000))
                if x.rowcount!=1:raise FailClosed("WRITER_CALL_CAS_COUNT_NOT_ONE")
                db.commit()
            except BaseException:
                db.rollback()
                raise
        _fault(failpoint,"after_writer_commit")
        _update(root,j,"WRITER_COMMITTED")
        _fault(failpoint,"after_writer_journal")
        jj=_status(root)
        _verify_protected(root,jj,expected_count=15)
        for name in jj["candidates"]:
            p=root / "quarantine" / name
            if not p.is_file() or bytes_hash(p)!=jj["markerSHA256"][name]:
                raise FailClosed("QUARANTINE_HASH_MISMATCH")
        rows=_call_rows(root)
        if len(rows)!=3 or any(r[1]==CALL for r in rows):
            raise FailClosed("WRITER_POSTCONDITION_FAILED")
        for which in ("writer","main"):
            _check_db(root,which)
        receipt={"schema":SCHEMA,"opID":jj["opID"],"status":"SIMULATED_ADMINISTRATIVE_RETIREMENT",
                 "historicalOutcome":"UNKNOWN","liveApproved":False,"forgedNativeReceipt":False,
                 "beforeMarkers":20,"afterMarkers":15,"writerCallsBefore":4,"writerCallsAfter":3}
        write_atomic(root / "synthetic-retirement.json",jbytes(receipt))
        _fault(failpoint,"after_receipt")
        _update(root,jj,"VERIFIED")
        _fault(failpoint,"after_verified")
        return receipt


def release_epoch(root: Path, failpoint: str | None = None) -> dict:
    root=_check_root(root)
    with lock(root):
        j=_status(root)
        if j["phase"] not in ("VERIFIED","FINISHED"):
            raise FailClosed("VERIFICATION_REQUIRED_BEFORE_RELEASE")
        if not _flag(root).is_file():
            if j["phase"]=="FINISHED":return {"status":"FINISHED_SYNTHETIC","liveApproved":False}
            raise FailClosed("FENCE_FLAG_MISSING_DURING_RELEASE")
        if read_json(_flag(root)).get("opID")!=j["opID"]:
            raise FailClosed("FENCE_OWNER_MISMATCH")
        _verify_protected(root,j,expected_count=15)
        if j["phase"]!="FINISHED":_update(root,j,"FINISHED")
        _fault(failpoint,"after_finished_journal")
        _flag(root).unlink();_sync_dir(root)
        return {"status":"FINISHED_SYNTHETIC","liveApproved":False}


def rollback(root: Path, failpoint: str | None = None) -> dict:
    root=_check_root(root)
    with lock(root):
        if not _journal(root).is_file():raise FailClosed("JOURNAL_NOT_FOUND")
        j=_status(root)
        if j["phase"]=="ROLLED_BACK":
            if _marker_map(root)!=j["markerSHA256"] or sorted(_call_rows(root))!=sorted(tuple(x) for x in j["writerRows"]):
                raise FailClosed("ROLLED_BACK_PREIMAGE_DRIFT")
            if _main_rows(root)!=[tuple(x) for x in j["mainAuditRows"]]:
                raise FailClosed("MAIN_AUDIT_LOGICAL_DRIFT")
            if _flag(root).exists():
                if read_json(_flag(root)).get("opID")!=j["opID"]:raise FailClosed("FENCE_OWNER_MISMATCH")
                _flag(root).unlink();_sync_dir(root)
            return {"status":"ROLLED_BACK_SYNTHETIC","liveApproved":False}
        if j["phase"]=="FINISHED":
            raise FailClosed("NO_ROLLBACK_AFTER_RELEASE_WITHOUT_NEW_FREEZE")
        current=_marker_map(root)
        expected=set(j["markerSHA256"])
        if set(current)-expected:raise FailClosed("NEW_MARKER_WHILE_FENCED")
        if _main_rows(root)!=[tuple(x) for x in j["mainAuditRows"]]:
            raise FailClosed("MAIN_AUDIT_LOGICAL_DRIFT")
        # Every protected marker and foreign writer row must retain its original content.
        protected={n:v for n,v in j["markerSHA256"].items() if n not in j["candidates"]}
        for n,v in protected.items():
            if current.get(n)!=v:raise FailClosed("FOREIGN_MARKER_DRIFT_ROLLBACK_REFUSED")
        rows=_call_rows(root)
        if not set([(GUARD,c,0,82424) for c in FOREIGN]).issubset(rows):
            raise FailClosed("FOREIGN_WRITER_ROW_DRIFT_ROLLBACK_REFUSED")
        if any(r[1]==CALL and r!=(DEV,CALL,0,50000) for r in rows):
            raise FailClosed("DEV_CALL_IDENTITY_DRIFT")
        # Per-row reinsertion never overwrites a foreign writer DB snapshot.
        if (DEV,CALL,0,50000) not in rows:
            with closing(sqlite3.connect(_db(root,"writer"))) as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    db.execute("INSERT INTO workspace_writer_calls VALUES (?,?,?,?)",(CALL,DEV,0,50000))
                    db.commit()
                except BaseException:
                    db.rollback();raise
        _fault(failpoint,"after_restore_writer")
        for i,name in enumerate(j["candidates"],1):
            active=root / "global" / name
            quarantined=root / "quarantine" / name
            if active.is_file() and not quarantined.exists():
                if bytes_hash(active)!=j["markerSHA256"][name]:raise FailClosed("ACTIVE_CANDIDATE_HASH_DRIFT")
            elif quarantined.is_file() and not active.exists():
                if bytes_hash(quarantined)!=j["markerSHA256"][name]:raise FailClosed("QUARANTINED_CANDIDATE_HASH_DRIFT")
                os.replace(quarantined,active)
                _sync_dir(quarantined.parent);_sync_dir(active.parent)
            else:
                raise FailClosed("CANDIDATE_RECOVERY_AMBIGUOUS")
            _fault(failpoint,f"after_restore_marker_{i}")
        if _marker_map(root)!=j["markerSHA256"] or sorted(_call_rows(root))!=sorted(tuple(x) for x in j["writerRows"]):
            raise FailClosed("BACKUP_POST_RESTORE_MISMATCH")
        for which in ("writer","main"):_check_db(root,which)
        # A rollback supersedes any simulated retirement receipt. Do not leave
        # an apparently-successful archival record without a revocation note.
        if (root / "synthetic-retirement.json").exists():
            write_atomic(root / "synthetic-retirement.json",jbytes({"schema":SCHEMA,"opID":j["opID"],
                "status":"SYNTHETIC_RETIREMENT_ROLLED_BACK","historicalOutcome":"UNKNOWN", "liveApproved":False}))
        _update(root,j,"ROLLED_BACK")
        _fault(failpoint,"after_rollback_journal")
        if _flag(root).exists():
            _flag(root).unlink();_sync_dir(root)
        return {"status":"ROLLED_BACK_SYNTHETIC","liveApproved":False}


def admission_snapshot(root: Path) -> dict:
    root=_check_root(root)
    with lock(root):
        p=_journal(root)
        status=_status(root)["phase"] if p.exists() else None
        flag=_flag(root).exists()
        if flag or status not in (None,"ROLLED_BACK","FINISHED"):
            return {"status":"DENIED_MAINTENANCE_EPOCH", "liveApproved":False,"count":len(_marker_paths(root))}
        count=len(_marker_paths(root))
        return {"status":"SYNTHETIC_CAPACITY_AVAILABLE" if count<16 else "DENIED_CAPACITY",
                "count":count, "globalWriterBarrierVerified":False,"liveApproved":False}


def verify_scratch_restore(root: Path) -> dict:
    root=_check_root(root)
    manifest=read_json(root / "backup" / "manifest.json")
    if manifest.get("schema")!=SCHEMA or not manifest.get("syntheticOnly"):
        raise FailClosed("BACKUP_MANIFEST_INVALID")
    for filename,h in manifest["markerSHA256"].items():
        if not MARK_RE.fullmatch(filename) or bytes_hash(root / "backup" / filename)!=h:
            raise FailClosed("SCRATCH_MARKER_HASH_MISMATCH")
    import tempfile as _temp
    with _temp.TemporaryDirectory(prefix="panya-r20-scratch-") as tmp:
        for which in ("writer","main"):
            source=root/"backup"/(which+".sqlite")
            if bytes_hash(source)!=manifest["databaseSHA256"][which]:
                raise FailClosed("SCRATCH_SQLITE_INPUT_SHA_MISMATCH")
            copy=Path(tmp)/(which+".sqlite")
            with closing(sqlite3.connect(f"file:{source.as_posix()}?mode=ro",uri=True)) as src, closing(sqlite3.connect(copy)) as dst:
                src.backup(dst)
            with closing(sqlite3.connect(copy)) as db:
                if db.execute("PRAGMA quick_check(1)").fetchone()[0]!="ok":
                    raise FailClosed("SCRATCH_SQLITE_QUICK_CHECK_FAIL")
                if which=="writer":
                    restored=db.execute("SELECT workspace_id,call_id,generation,pid FROM workspace_writer_calls ORDER BY workspace_id,call_id").fetchall()
                    if restored!=[tuple(x) for x in manifest["writerRows"]]:
                        raise FailClosed("SCRATCH_WRITER_ROWS_DIFFER")
    return {"status":"SCRATCH_RESTORE_PASS_SYNTHETIC","sqlite":2,"markers":20,"liveApproved":False}


def demo() -> dict:
    root=make_fixture()
    try:
        before=admission_snapshot(root)
        prepared=prepare(root)
        scratch=verify_scratch_restore(root)
        denied=admission_snapshot(root)
        applied=retire(root)
        after=release_epoch(root)
        capacity=admission_snapshot(root)
        return {"schema":SCHEMA,"root":"ISOLATED_OS_TEMP_ONLY_NOT_PANYA_HOME",
                "before":before,"prepared":prepared,"scratch":scratch,"fencedAttempt":denied,
                "simulated":applied,"finished":after,"after":capacity,"historicalOutcome":"UNKNOWN",
                "liveApproved":False,"canReleaseAnyHostMarker":False,"canClearAnyHostWriterCall":False}
    finally:
        shutil.rmtree(root)


if __name__ == "__main__":
    if sys.argv[1:] != ["--synthetic-demo"]:
        print("R20_ONLY_ACCEPTS_SYNTHETIC_DEMO; NO_REAL_HOST_ACTIONS",file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(demo(),sort_keys=True,indent=2))