param(
  [string]$Archive,
  [string]$AppDirectory,
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($WorkspaceRoot)) { throw 'Use an absolute isolated test workspace.' }
if (Test-Path $WorkspaceRoot) { throw 'The smoke workspace must be a new directory.' }
New-Item -ItemType Directory -Path $WorkspaceRoot | Out-Null
if ($Archive) {
  $Extracted = Join-Path $WorkspaceRoot 'extracted'
  Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted
  $AppDirectory = Join-Path $Extracted 'PRISM'
}
$Exe = Join-Path $AppDirectory 'PRISM.exe'
if (-not (Test-Path $Exe)) { throw "PRISM.exe was not found at $Exe" }
$PrismProfile = Join-Path $WorkspaceRoot 'test'
New-Item -ItemType Directory -Path $PrismProfile | Out-Null
$Ready = Join-Path $PrismProfile 'ready.json'
$Process = $null
$PreviousSmokeDir = $env:PRISM_WINDOWS_SMOKE_DIR
function Start-Prism {
  if (Test-Path $Ready) { Remove-Item -LiteralPath $Ready }
  $env:PRISM_WINDOWS_SMOKE_DIR = $PrismProfile
  $script:Process = Start-Process -FilePath $Exe -PassThru
  for ($i=0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $failurePath = Join-Path $PrismProfile 'startup-error.txt'
    if (Test-Path $failurePath) { throw (Get-Content -Raw -LiteralPath $failurePath) }
    if ($script:Process.HasExited) { throw "PRISM exited with $($script:Process.ExitCode)" }
    if (Test-Path $Ready) {
      try { $record = Get-Content -Raw -LiteralPath $Ready | ConvertFrom-Json } catch { continue }
      if ($record.origin -ne 'http://127.0.0.1:38741' -or $record.token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid startup record.' }
      if (-not $record.hasMain) { throw 'The native window did not render the PRISM workspace.' }
      $script:Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      $cookie = New-Object System.Net.Cookie('prism_desktop',$record.token,'/','127.0.0.1')
      $script:Session.Cookies.Add($cookie)
      $script:Origin = $record.origin
      return $record
    }
  }
  throw 'PRISM did not become ready in 120 seconds.'
}
function Stop-Prism {
  New-Item -ItemType File -Path (Join-Path $PrismProfile 'stop') -Force | Out-Null
  if (-not $script:Process.WaitForExit(20000)) { throw 'PRISM did not close gracefully.' }
  if ($script:Process.ExitCode -ne 0) { throw "PRISM quit with $($script:Process.ExitCode)" }
}
function Read-Api([string]$Path) {
  return Invoke-RestMethod -Uri "$script:Origin/api/v1$Path" -WebSession $script:Session
}
function Write-Api([string]$Method,[string]$Path,[object]$Data,[string]$Version) {
  $headers = @{ Origin=$script:Origin; 'Idempotency-Key'=[guid]::NewGuid().ToString() }
  if ($Version) { $headers['If-Match'] = '"'+$Version+'"' }
  return Invoke-RestMethod -Method $Method -Uri "$script:Origin/api/v1$Path" -WebSession $script:Session -ContentType 'application/json' -Headers $headers -Body ($Data | ConvertTo-Json -Depth 10)
}
try {
  $initial = Start-Prism
  $DailyFile = Join-Path $PrismProfile 'profile/updates/daily-check.json'
  if ($env:PRISM_WINDOWS_DAILY_CHECK_TEST -eq '1') {
    for ($i=0; $i -lt 30 -and -not (Test-Path $DailyFile); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path $DailyFile)) { throw 'Automatic update check did not run.' }
    $firstDailyCheck = (Get-Content -Raw -LiteralPath $DailyFile | ConvertFrom-Json).lastAttemptAt
  }
  $empty = Read-Api '/knowledge-items?limit=1'
  if ($empty.items.Count -ne 0) { throw 'The new installation included user notes.' }
  $noteId = [guid]::NewGuid().ToString()
  $note = Write-Api 'Post' '/knowledge-items' @{ id=$noteId; title='Windows smoke note'; type='theorem'; content='Synthetic test note.' } ''
  $prefs = Read-Api '/me/preferences'
  $savedPrefs = Write-Api 'Patch' '/me/preferences' @{ daily_review_limit=37 } $prefs.version
  New-Item -ItemType File -Path (Join-Path $PrismProfile 'appearance-dark') | Out-Null
  $dark = $false
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { $record = Get-Content -Raw -LiteralPath $Ready | ConvertFrom-Json } catch { continue }
    if ($record.theme -eq 'dark') { $dark=$true; break }
  }
  if (-not $dark) { throw 'The native UI did not apply the test appearance.' }
  Stop-Prism
  $reopened = Start-Prism
  if ($env:PRISM_WINDOWS_DAILY_CHECK_TEST -eq '1') {
    Start-Sleep -Seconds 2
    $secondDailyCheck = (Get-Content -Raw -LiteralPath $DailyFile | ConvertFrom-Json).lastAttemptAt
    if ($firstDailyCheck -ne $secondDailyCheck) { throw 'Automatic checking repeated before one hour.' }
    Write-Output 'Automatic daily update check ran once and stayed deduplicated after restart.'
  }
  $restored = Read-Api "/knowledge-items/$noteId"
  $restoredPrefs = Read-Api '/me/preferences'
  $appearance = $reopened.appearance | ConvertFrom-Json
  if ($restored.title -ne 'Windows smoke note') { throw 'The note did not survive restart.' }
  if ($restoredPrefs.daily_review_limit -ne 37) { throw 'The review preference did not survive restart.' }
  if ($reopened.theme -ne 'dark' -or $appearance.textSize -ne 18) { throw 'Appearance did not survive restart.' }
  Stop-Prism
  Write-Output "PRISM $($reopened.version) Windows smoke passed. Native window rendered; synthetic note, review preference, and appearance survived restart."
} finally {
  $env:PRISM_WINDOWS_SMOKE_DIR = $PreviousSmokeDir
  if ($Process -and -not $Process.HasExited) {
    & taskkill /PID $Process.Id /T /F | Out-Null
  }
}
