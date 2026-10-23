Set-StrictMode -Version Latest

function New-OwnedProcessReadSession {
  param([Diagnostics.Process]$Process, [string]$TaskId, [string]$InvocationId)
  if ($env:COMPUTERNAME -ne 'VAGOO' -or $TaskId -notmatch '^mock-[a-z0-9-]{1,70}$') { throw 'OWNED_LOCAL_FIXTURE_REQUIRED' }
  if ($Process.StartInfo.UseShellExecute -or -not $Process.StartInfo.RedirectStandardInput) { throw 'OWNED_INERT_PROCESS_REQUIRED' }
  # The harness supplies a Process that it started. No attach-by-PID or alternate probe is attempted.
  $handle = $Process.Handle.ToInt64()
  $creation = $Process.StartTime.ToUniversalTime()
  $image = $Process.MainModule.FileName
  $creator = [Diagnostics.Process]::GetCurrentProcess()
  return [pscustomobject]@{
    Process=$Process; Handle=$handle; TaskId=$TaskId; InvocationId=$InvocationId
    Nonce=[guid]::NewGuid().ToString(); ProcessId=$Process.Id
    CreationFileTime=$creation.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    CreationTimeUtc=$creation.ToString('o'); Image=$image
    HarnessParentId=$PID; HarnessParentCreationFileTime=$creator.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
  }
}

function Read-OwnedProcessEvidence {
  param($Session)
  $frame = [ordered]@{
    schemaVersion=1; scope='WINDOWS_LOCAL_READ_ONLY_OWNED_TEST'; machine=$env:COMPUTERNAME
    taskId=$Session.TaskId; invocationId=$Session.InvocationId; sessionNonce=$Session.Nonce
    source='SYSTEM_DIAGNOSTICS_RETAINED_PROCESS'; capturedAt=[DateTime]::UtcNow.ToString('o')
    processId=$Session.ProcessId; creationFileTime=$Session.CreationFileTime; creationTimeUtc=$Session.CreationTimeUtc
    image=$Session.Image; state='UNKNOWN'; descendantsVerified=$false; taskOwnerVerified=$false
    parentProvenance='HARNESS_CREATE_BINDING'; harnessParentId=$Session.HarnessParentId
    harnessParentCreationFileTime=$Session.HarnessParentCreationFileTime
  }
  try {
    if ($Session.Process.Handle.ToInt64() -ne $Session.Handle) { throw 'HANDLE_CHANGED' }
    $Session.Process.Refresh()
    if ($Session.Process.HasExited) {
      if (-not $Session.Process.WaitForExit(0)) { throw 'EXIT_NOT_SIGNALED' }
      $frame.state='EXIT_BOUND_TO_RETAINED_HANDLE'
      $frame.exitCode=$Session.Process.ExitCode
      $frame.exitFileTime=$Session.Process.ExitTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
    } else {
      $currentCreation=$Session.Process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
      if ($currentCreation -ne $Session.CreationFileTime -or $Session.Process.Id -ne $Session.ProcessId) { throw 'IDENTITY_CHANGED' }
      $frame.state='RUNNING_OBSERVED'
    }
  } catch {
    $frame.state='UNKNOWN'
    $frame.reason='NATIVE_READ_FAILED'
    if ($_.Exception.Message -match 'HANDLE_CHANGED|IDENTITY_CHANGED|EXIT_NOT_SIGNALED') { $frame.reason=$Matches[0] }
    $inner=$_.Exception.InnerException
    if (($null -ne $inner) -and ($inner -is [ComponentModel.Win32Exception]) -and $inner.NativeErrorCode -eq 5) { $frame.reason='ACCESS_DENIED' }
  }
  return [pscustomobject]$frame
}

Export-ModuleMember -Function New-OwnedProcessReadSession,Read-OwnedProcessEvidence
