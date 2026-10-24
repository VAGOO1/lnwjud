// SPDX-License-Identifier: MIT
// PANYA R15 — Windows native read-only CURRENT observation only.
// STAGING ONLY. No Host connection, task administration, release, or writes.
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        if (args.Length != 2 || args[0] != "--pid" ||
            !int.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out int pid))
        {
            Console.Error.WriteLine("Usage: native-probe --self-test | --pid <positive-integer>");
            return 2;
        }
        // Only the user-specified numeric PID is queried once. No files, logs,
        // reservations, services, job-control APIs or child processes are touched.
        Console.WriteLine(JsonSerializer.Serialize(Probe(pid), JsonOptions));
        return 0;
    }

    private static ProbeEvidence Probe(int pid)
    {
        string observedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture); // UTC DateTime emits canonical Z, not escaped +00:00
        if (pid <= 0) return Evidence(pid, observedAt, "INVALID_PID_UNPROVEN");
        if (!OperatingSystem.IsWindows()) return Evidence(pid, observedAt, "UNSUPPORTED_OS_UNPROVEN");

        ulong uptime = GetTickCount64(); // Uptime hint only, NOT a unique boot ID.
        IntPtr handle = OpenProcess(0x1000U /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (handle == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            return Evidence(pid, observedAt, "NOT_OPENED_UNPROVEN", uptime, win32Error: error);
        }
        try
        {
            if (!GetProcessTimes(handle, out FileTime creation, out _, out _, out _))
            {
                int error = Marshal.GetLastWin32Error();
                return Evidence(pid, observedAt, "GET_TIMES_FAILED_UNPROVEN", uptime, win32Error: error);
            }
            ulong ticks = ((ulong)creation.High << 32) | creation.Low;
            if (ticks == 0 || ticks > long.MaxValue)
                return Evidence(pid, observedAt, "INVALID_FILETIME_UNPROVEN", uptime);
            try
            {
                string creationUtc = DateTime.FromFileTimeUtc((long)ticks).ToString("O", CultureInfo.InvariantCulture);
                return Evidence(pid, observedAt, "PROCESS_OBJECT_OBSERVED_AT_QUERY", uptime,
                    ticks.ToString(CultureInfo.InvariantCulture), creationUtc);
            }
            catch (ArgumentOutOfRangeException)
            {
                return Evidence(pid, observedAt, "INVALID_FILETIME_UNPROVEN", uptime);
            }
        }
        finally
        {
            // Closes ONLY the query handle owned by this probe; never stops a process.
            _ = CloseHandle(handle);
        }
    }

    private static ProbeEvidence Evidence(int pid, string observedAt, string observation,
        ulong? uptime = null, string? filetime = null, string? creationUtc = null, int? win32Error = null) =>
        new(
            "R15_WINDOWS_STAGING_CURRENT_OBSERVATION_ONLY", "WIN32_OPENPROCESS_GETPROCESSTIMES",
            pid, observation, observedAt, filetime, creationUtc, win32Error, uptime,
            "UNATTESTED_NO_UNIQUE_BOOT_ID", "UNKNOWN_NO_EXACT_JOB_HANDLE", "UNKNOWN_NO_ORIGINAL_BINDING",
            "UNKNOWN_NO_TERMINAL_RECEIPT", false, false, false);

    private static int SelfTest()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("R15_SELF_TEST_REQUIRES_WINDOWS");
            return 1;
        }
        ProbeEvidence self = Probe(Environment.ProcessId);
        ProbeEvidence bad = Probe(0);
        ProbeEvidence absent = Probe(int.MaxValue);
        bool valid = self.Observation == "PROCESS_OBJECT_OBSERVED_AT_QUERY" &&
            ulong.TryParse(self.KernelCreationFiletimeUtcTicks, out ulong ticks) && ticks > 0 &&
            self.BootIdentity == "UNATTESTED_NO_UNIQUE_BOOT_ID" &&
            self.JobOrigin == "UNKNOWN_NO_EXACT_JOB_HANDLE" &&
            self.OriginalBinding == "UNKNOWN_NO_ORIGINAL_BINDING" &&
            self.TaskOutcome == "UNKNOWN_NO_TERMINAL_RECEIPT" &&
            !self.CanMutateHost && !self.CanReleaseReservation && !self.NativeReceiptVerified &&
            bad.Observation == "INVALID_PID_UNPROVEN" &&
            absent.Observation == "NOT_OPENED_UNPROVEN" &&
            absent.Win32Error is not null &&
            !absent.CanReleaseReservation;
        Console.WriteLine(valid ? "R15_WINDOWS_NATIVE_SELF_TEST_PASS" : "R15_WINDOWS_NATIVE_SELF_TEST_FAIL");
        return valid ? 0 : 1;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low; public uint High; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation,
        out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")]
    private static extern ulong GetTickCount64();
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}

internal sealed record ProbeEvidence(
    string Mode, string Provenance, int TargetPid, string Observation, string ObservedAtUtc,
    string? KernelCreationFiletimeUtcTicks, string? KernelCreationUtc, int? Win32Error,
    ulong? SystemUptimeMilliseconds, string BootIdentity, string JobOrigin, string OriginalBinding,
    string TaskOutcome, bool NativeReceiptVerified, bool CanMutateHost, bool CanReleaseReservation);
