// MIT License — Copyright (c) 2026 Adisorn (lnwjud project).
// PANYA staged source-only candidate; see ../../LICENSE.
// Not built/tested, not installed, and not authorized for Live invocation.
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

internal sealed class LaunchSpec
{
    public required string JobId { get; init; }
    public required string RequestDigest { get; init; }
    public required string Executable { get; init; }
    public required string[] Arguments { get; init; }
    public required string Cwd { get; init; }
    public required int TimeoutMs { get; init; }
    public bool WindowsVerbatimArguments { get; init; }
}

internal static class Program
{
    private const int UnverifiedExitCode = 125;
    private const int MaxSpecBytes = 131072;
    private static readonly Regex DigestRegex = new("^[0-9a-fA-F]{64}$", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static int Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows() || args.Length != 2 || args[0] != "--job-dir")
                throw new InvalidOperationException("INVALID_LAUNCH_ARGUMENTS");

            var suppliedDirectory = args[1];
            if (!Path.IsPathFullyQualified(suppliedDirectory))
                throw new InvalidOperationException("JOB_DIRECTORY_NOT_ABSOLUTE");

            var jobDir = Path.GetFullPath(suppliedDirectory);
            if (!Directory.Exists(jobDir) || HasReparseAttribute(jobDir))
                throw new InvalidOperationException("JOB_DIRECTORY_UNTRUSTED");

            var specPath = Path.Combine(jobDir, "containment.json");
            var cancelPath = Path.Combine(jobDir, "containment.cancel");
            var receiptPath = Path.Combine(jobDir, "containment.receipt.json");
            var tempPath = Path.Combine(jobDir, "containment.receipt.tmp");

            if (!File.Exists(specPath) || HasReparseAttribute(specPath) ||
                File.Exists(receiptPath) || File.Exists(tempPath))
                throw new InvalidOperationException("JOB_STAGE_NOT_CREATE_ONLY");

            var fileInfo = new FileInfo(specPath);
            if (fileInfo.Length <= 0 || fileInfo.Length > MaxSpecBytes)
                throw new InvalidOperationException("JOB_SPEC_SIZE_REJECTED");

            byte[] rawSpec = File.ReadAllBytes(specPath);
            if (rawSpec.Length <= 0 || rawSpec.Length > MaxSpecBytes)
                throw new InvalidOperationException("JOB_SPEC_SIZE_REJECTED");

            var spec = JsonSerializer.Deserialize<LaunchSpec>(rawSpec, JsonOptions)
                       ?? throw new InvalidOperationException("JOB_SPEC_INVALID");

            if (!Guid.TryParseExact(spec.JobId, "D", out _) ||
                !string.Equals(new DirectoryInfo(jobDir).Name, spec.JobId, StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(spec.RequestDigest) ||
                !DigestRegex.IsMatch(spec.RequestDigest) ||
                string.IsNullOrWhiteSpace(spec.Executable) ||
                string.IsNullOrWhiteSpace(spec.Cwd) ||
                !Path.IsPathFullyQualified(spec.Executable) ||
                !Path.IsPathFullyQualified(spec.Cwd) ||
                !File.Exists(spec.Executable) ||
                !Directory.Exists(spec.Cwd) ||
                spec.TimeoutMs < 1 || spec.TimeoutMs > 604_800 * 1000 ||
                spec.Arguments is null || spec.Arguments.Length > 128)
                throw new InvalidOperationException("JOB_SPEC_REJECTED");

            foreach (var argument in spec.Arguments)
                if (argument is null || argument.Length > 32768 || argument.Contains('\0'))
                    throw new InvalidOperationException("JOB_ARGUMENT_REJECTED");

            var specSha256 = Convert.ToHexString(SHA256.HashData(rawSpec)).ToLowerInvariant();
            var stopwatch = Stopwatch.StartNew();

            // ContainedProcess is copied from pinned upstream MIT source:
            // CreateProcess(CREATE_SUSPENDED) -> AssignProcessToJobObject
            // -> ResumeThread. Any failure kills the suspended child.
            // Kill-on-last-Job-handle-close remains active.
            using var job = ContainedProcess.Start(
                spec.Executable, spec.Arguments, spec.Cwd, spec.WindowsVerbatimArguments);

            var outcome = "completed";
            var exitCode = 1;

            while (true)
            {
                if (File.Exists(cancelPath))
                {
                    outcome = "cancelled";
                    job.Cancel();
                    break;
                }
                if (stopwatch.ElapsedMilliseconds >= spec.TimeoutMs)
                {
                    outcome = "timed_out";
                    job.Cancel();
                    break;
                }
                try
                {
                    // The upstream helper waits for the entire native Job:
                    // child + descendants, not only the direct process PID.
                    exitCode = job.WaitForExit(100);
                    break;
                }
                catch (TimeoutException)
                {
                    // Continue bounded observation of Job liveness.
                }
            }

            if (job.ActiveProcesses != 0)
                throw new InvalidOperationException("JOB_TERMINATION_UNVERIFIED");

            // The v1 fields remain compatible with the upstream consumers.
            // Added identity fields are required by the strengthened candidate
            // reader. Exit 0 by itself is NEVER a native zero-active receipt.
            var receipt = new
            {
                kind = "windows_job_v1",
                outcome,
                exitCode,
                activeProcesses = 0,
                jobId = spec.JobId,
                requestDigest = spec.RequestDigest.ToLowerInvariant(),
                specSha256
            };
            byte[] data = JsonSerializer.SerializeToUtf8Bytes(receipt, JsonOptions);

            // Never overwrite an old terminal receipt. Failure/interruptions
            // before atomic publication leave the result UNKNOWN.
            using (var file = new FileStream(
                tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 4096, options: FileOptions.WriteThrough))
            {
                file.Write(data);
                file.Flush(flushToDisk: true);
            }
            File.Move(tempPath, receiptPath); // destination MUST be absent

            // Local readback is necessary but does not by itself prove crash
            // durability, nor a valid Host authorization or an E2E outcome.
            var readback = File.ReadAllBytes(receiptPath);
            if (!readback.AsSpan().SequenceEqual(data))
                throw new InvalidOperationException("RECEIPT_READBACK_MISMATCH");

            return exitCode;
        }
        catch
        {
            // Do not log credentials, absolute paths, or command arguments.
            // No valid receipt => Host must retain termination_unverified.
            Console.Error.WriteLine("NATIVE_CONTAINMENT_UNVERIFIED");
            return UnverifiedExitCode;
        }
    }

    private static bool HasReparseAttribute(string fullPath) =>
        (File.GetAttributes(fullPath) & FileAttributes.ReparsePoint) != 0;
}
