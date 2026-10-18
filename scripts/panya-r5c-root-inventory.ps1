# R5C diagnostic-only inspection on GitHub Windows Runner.
# Names, sizes, attributes and hashes only. NEVER output file contents.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [Parameter(Mandatory=$true)][string]$EvidenceRoot
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_REPOSITORY -cne 'VAGOO1/lnwjud' -or
    $env:GITHUB_REF -cne 'refs/heads/panya/native-host-candidate-r5d-20261018') {
  throw 'R5C_NOT_APPROVED_EPHEMERAL_GITHUB_CI'
}
$root = (Resolve-Path -LiteralPath $OutputRoot -ErrorAction Stop).ProviderPath
$evidence = (Resolve-Path -LiteralPath $EvidenceRoot -ErrorAction Stop).ProviderPath
if ([IO.Path]::GetFileName($root) -cne 'installers' -or
    -not $root.StartsWith(($env:GITHUB_WORKSPACE.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or
    -not $evidence.StartsWith(($env:RUNNER_TEMP.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'R5C_ROOT_NOT_EXPECTED_WORKSPACE_OR_RUNNER_TEMP'
}
$rootInfo = Get-Item -LiteralPath $root -Force -ErrorAction Stop
if (-not $rootInfo.PSIsContainer -or ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'R5C_UNSAFE_OUTPUT_DIRECTORY' }
$entries = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
if ($entries.Count -lt 1 -or $entries.Count -gt 32) { throw 'R5C_ROOT_ENTRY_COUNT_UNSAFE' }
$names = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$rows = foreach ($item in $entries) {
  if ($item.Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$' -or
      $item.Name -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)' -or
      -not $names.Add($item.Name)) { throw 'R5C_ROOT_ENTRY_NAME_UNSAFE' }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'R5C_REPARSE_ROOT_ENTRY_DENIED' }
  if (-not $item.PSIsContainer -and -not ($item -is [IO.FileInfo])) { throw 'R5C_UNEXPECTED_FILE_SYSTEM_OBJECT' }
  $isFile = -not $item.PSIsContainer
  $size = if ($isFile) { [long]$item.Length } else { $null }
  if ($isFile -and ($size -lt 1 -or $size -gt 1073741824)) { throw 'R5C_ROOT_FILE_SIZE_OUT_OF_BOUNDS' }
  $sha = if ($isFile) { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } else { $null }
  [pscustomobject][ordered]@{
    name = $item.Name
    type = if ($isFile) { 'file' } else { 'directory' }
    sizeBytes = $size
    attributes = [string]$item.Attributes
    reparsePoint = $false
    sha256 = $sha
  }
}
$rows = @($rows | Sort-Object -Property name)
$files = @($rows | Where-Object { $_.type -eq 'file' })
$directories = @($rows | Where-Object { $_.type -eq 'directory' })
if (@($directories | Where-Object { $_.name -cne 'win-unpacked' }).Count -gt 0 -or
    @($directories | Where-Object { $_.name -ceq 'win-unpacked' }).Count -ne 1) {
  throw 'R5C_ROOT_HAS_UNEXPECTED_DIRECTORY'
}
$report = [ordered]@{
  schema = 'panya-r5c-root-inventory/v1'
  scope = 'GITHUB_CI_ONLY_DIAGNOSIS_NOT_PACKAGING_ACCEPTANCE'
  runId = [string]$env:GITHUB_RUN_ID
  commit = [string]$env:GITHUB_SHA
  root = 'apps/desktop/dist/installers'
  verdict = 'OBSERVED_NOT_YET_ADMITTED'
  rootFileCount = $files.Count
  rootDirectoryCount = $directories.Count
  entries = $rows
  host5090Admission = $false
  liveMutation = $false
}
$dest = Join-Path $evidence 'PANYA_R5C_ROOT_INVENTORY.json'
if (Test-Path -LiteralPath $dest) { throw 'R5C_EVIDENCE_ALREADY_EXISTS' }
$json = $report | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($dest, ($json + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
$readback = Get-Content -LiteralPath $dest -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
if ($readback.verdict -cne 'OBSERVED_NOT_YET_ADMITTED' -or
    $readback.rootFileCount -ne $files.Count -or
    $readback.rootDirectoryCount -ne $directories.Count -or
    @($readback.entries).Count -ne $rows.Count) { throw 'R5C_INVENTORY_READBACK_FAILED' }
Write-Output "R5C_ROOT_INVENTORY_ONLY_RUN=$($env:GITHUB_RUN_ID)"
Write-Output "R5C_ROOT_FILE_COUNT=$($files.Count)"
foreach ($item in $files) {
  Write-Output "R5C_ROOT_FILE_NAME=$($item.name) SIZE=$($item.sizeBytes) ATTRS=$($item.attributes) SHA256=$($item.sha256)"
}
Write-Output 'R5C_DIAGNOSTIC_ONLY_NO_PACKAGE_PASS'
