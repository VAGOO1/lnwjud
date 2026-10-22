param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$ExpectedRuntimePath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')][string]$InvocationId
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$stage='runtime_preflight'
$owned=$null
try {
  if ($env:COMPUTERNAME -ne 'VAGOO') { throw 'WRONG_TEST_MACHINE' }
  if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'HOST_POWERSHELL_CORE_REQUIRED' }
  if (-not [string]::Equals([Environment]::ProcessPath,$ExpectedRuntimePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'RUNTIME_IDENTITY_MISMATCH' }
  if ($null -ne $env:PSExecutionPolicyPreference -or $null -ne $env:__PSLockdownPolicy) { throw 'POLICY_OVERRIDE_NOT_ALLOWED' }
  $policyBefore=@(Get-ExecutionPolicy -List | ForEach-Object { [ordered]@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy} })
  if ([string](Get-ExecutionPolicy) -ne 'RemoteSigned') { throw 'EXISTING_HOST_POLICY_MISMATCH' }
  if ($NodePath -ne 'C:\Program Files\nodejs\node.exe') { throw 'OWNED_FIXTURE_NODE_REQUIRED' }
  $stage='module_import'
  Import-Module (Join-Path $PSScriptRoot 'windows-owned-process-reader.psm1') -Force
  $inert=Join-Path $PSScriptRoot 'native-inert-worker.mjs'
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=$NodePath; $start.ArgumentList.Add($inert); $start.UseShellExecute=$false
  $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true; $start.CreateNoWindow=$true
  $owned=[Diagnostics.Process]::new()
  $owned.StartInfo=$start
  $stage='owned_process_start'
  if (-not $owned.Start()) { throw 'INERT_PROCESS_NOT_STARTED' }
  $ready=$owned.StandardOutput.ReadLineAsync()
  if (-not $ready.Wait(5000) -or $ready.Result -ne 'READY') { throw 'INERT_PROCESS_HANDSHAKE_FAILED' }
  $stage='owned_handle_bind'
  $session=New-OwnedProcessReadSession -Process $owned -TaskId 'mock-native-owned' -InvocationId $InvocationId
  $stage='running_read'
  $running=Read-OwnedProcessEvidence -Session $session
  if ($running.state -ne 'RUNNING_OBSERVED') { throw ('RUNNING_READ_UNVERIFIED: '+$running.reason) }
  $owned.StandardInput.WriteLine('finish'); $owned.StandardInput.Flush()
  if (-not $owned.WaitForExit(5000)) { throw 'INERT_PROCESS_DID_NOT_SELF_EXIT' }
  $stage='exit_read'
  $exited=Read-OwnedProcessEvidence -Session $session
  if ($exited.state -ne 'EXIT_BOUND_TO_RETAINED_HANDLE' -or $exited.exitCode -ne 23) { throw 'EXIT_READ_UNVERIFIED' }
  $stage='policy_readback'
  $policyAfter=@(Get-ExecutionPolicy -List | ForEach-Object { [ordered]@{scope=[string]$_.Scope;policy=[string]$_.ExecutionPolicy} })
  if (($policyBefore|ConvertTo-Json -Compress) -cne ($policyAfter|ConvertTo-Json -Compress)) { throw 'EXECUTION_POLICY_CHANGED' }
  [ordered]@{status='NATIVE_OWNED_FIXTURE_PASS';scope='LOCAL_OWNED_INERT_TEST';machine=$env:COMPUTERNAME;runtime=[Environment]::ProcessPath;runtimeVersion=[string]$PSVersionTable.PSVersion;running=$running;exited=$exited;policyBefore=$policyBefore;policyAfter=$policyAfter;policyUnchanged=$true;taskWideCompletion='UNKNOWN';recoveryAuthorization='NONE';oldTaskCommands=0;registryWrites=0} | ConvertTo-Json -Depth 8 -Compress
} catch {
  $failure=[ordered]@{status='NATIVE_OWNED_FIXTURE_FAILED';stage=$stage;errorId=$_.FullyQualifiedErrorId;exceptionType=$_.Exception.GetType().FullName;message=$_.Exception.Message;innerException=$null;recoveryAuthorization='NONE'}
  if ($null -ne $_.Exception.InnerException) { $failure.innerException=[ordered]@{type=$_.Exception.InnerException.GetType().FullName;message=$_.Exception.InnerException.Message} }
  [Console]::Error.WriteLine(($failure|ConvertTo-Json -Depth 5 -Compress))
  exit 1
} finally {
  if ($null -ne $owned) {
    # Only close the owned fixture's input; its EOF handler exits itself. Never Kill/Stop/Terminate.
    try { $owned.StandardInput.Close() } catch { }
    try { [void]$owned.WaitForExit(5000) } catch { }
    $owned.Dispose()
  }
}
