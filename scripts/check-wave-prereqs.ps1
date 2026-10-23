# Checks the optional runtimes the God-Tier waves depend on. Every check is
# read-only and safe to run on any machine; missing items only mean the
# matching wave cannot be *live-tested* here — code still reports truthful
# availability at runtime.
[CmdletBinding()]
param()

$results = [ordered]@{}

function Test-DotNetSdk {
  try {
    $version = (& dotnet --version 2>$null)
    if ($LASTEXITCODE -eq 0 -and $version -match '^8|^9|^1[0-9]') { "yes ($version)" }
    elseif ($LASTEXITCODE -eq 0) { "present but old ($version)" }
    else { 'no' }
  } catch { 'no' }
}

function Test-WindowsSandbox {
  $exe = Join-Path $env:WINDIR 'System32\WindowsSandbox.exe'
  if (-not (Test-Path $exe)) { return 'no (WindowsSandbox.exe missing)' }
  $feature = Get-WindowsOptionalFeature -FeatureName 'Containers-DisposableClientVM' -Online -ErrorAction SilentlyContinue
  if ($feature -and $feature.State -eq 'Enabled') { 'yes' }
  else { "exe present, feature state: $($feature.State)" }
}

function Test-OfficeCom([string]$ProgId) {
  try {
    $app = New-Object -ComObject $ProgId -ErrorAction Stop
    try { if ($app) { 'yes' } else { 'no' } } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
  } catch { "no ($($_.Exception.Message))" }
}

function Test-SdkTool([string]$Tool) {
  $found = Get-Command $Tool -ErrorAction SilentlyContinue
  if ($found) { "yes ($($found.Source))" } else { 'no' }
}

$results['dotnet-sdk'] = Test-DotNetSdk
$results['windows-sandbox'] = Test-WindowsSandbox
$results['office-excel'] = Test-OfficeCom 'Excel.Application'
$results['office-word'] = Test-OfficeCom 'Word.Application'
$results['office-powerpoint'] = Test-OfficeCom 'PowerPoint.Application'
$results['office-outlook'] = Test-OfficeCom 'Outlook.Application'
$results['makeappx'] = Test-SdkTool 'makeappx.exe'
$results['signtool'] = Test-SdkTool 'signtool.exe'
$results['pdftotext'] = Test-SdkTool 'pdftotext.exe'

foreach ($key in $results.Keys) {
  '{0,-18} {1}' -f $key, $results[$key]
}
