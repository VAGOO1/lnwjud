# PANYA R15 — Windows Native Current-Process Evidence (staging only)

**STATUS: STAGING SOURCE — NOT INSTALLED; DOES NOT REPAIR OR RELEASE HOST.**

After R14 identified missing historical Windows process/boot/Job origin, this isolated console tool uses kernel32 OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION and GetProcessTimes on the same handle to collect the current kernel creation FILETIME for one numeric PID. GetTickCount64 is only a coarse uptime hint, NOT a unique authenticated boot ID. CloseHandle closes only its own query handle. No stop, process start, task administration, job-control, filesystem reads, SQLite writes or reservation release are supported.

--self-test reads the Windows GitHub CI runner's own process and safely tests invalid/nonexisting PID. --pid <positive-integer> makes one read-only current query, never proves whether any historical lnwjud task is still alive, ended, or belongs to the caller. Inaccessible PID is UNPROVEN, not terminated. No PANYA-HOME live data or credentials are included.

All output has canMutateHost=false, canReleaseReservation=false, nativeReceiptVerified=false, taskOutcome UNKNOWN, jobOrigin UNKNOWN, originalBinding UNKNOWN and bootIdentity UNATTESTED. The Node contract tests reject fabricated attestation claims, reused PID shortcuts, missing original bindings and malformed JSON.

Validation: dotnet run --project tests/panya-r15/Panya.R15.NativeProbe.csproj -c Release -- --self-test (Windows runner); node --test tests/panya-r15/evidence-contract.test.mts (Node 24). The workflow has only contents:read, no deployment, no 5090 bridge.

Historical 5.8.7 markers never captured a verified original boot ID, kernel process creation identity or native Job origin. No later read can manufacture the historical binding. Work on installed Host, Writer Lease or any of 20 reservations needs a separate scope, provenance validation, owner approval and independently verified rollback.

Source retains MIT license; only synthetic fixtures and CI runner's own process are used.
