param(
  [Parameter(Mandatory=$true)][string]$BaseArchive,
  [Parameter(Mandatory=$true)][string]$UpdateArchive,
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($WorkspaceRoot)) { throw 'Use an absolute isolated test workspace.' }
if (Test-Path $WorkspaceRoot) { throw 'The update smoke workspace must be a new directory.' }
foreach ($file in @($BaseArchive, $UpdateArchive, $Manifest)) {
  if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw 'Provide absolute paths to the base ZIP, update ZIP, and signed manifest.'
  }
}
New-Item -ItemType Directory -Path $WorkspaceRoot | Out-Null
$Extracted = Join-Path $WorkspaceRoot 'extracted'
Expand-Archive -LiteralPath $BaseArchive -DestinationPath $Extracted
$AppDirectory = Join-Path $Extracted 'PRISM'
$Exe = Join-Path $AppDirectory 'PRISM.exe'
$RouteCache = Join-Path $AppDirectory 'resources/desktop/web/apps/web/.next/server/route-cache'
if (-not (Test-Path -LiteralPath $Exe)) { throw 'The base archive does not contain PRISM.exe.' }
$PrismProfile = Join-Path $WorkspaceRoot 'test'
New-Item -ItemType Directory -Path $PrismProfile | Out-Null
$Ready = Join-Path $PrismProfile 'ready.json'
$State = Join-Path $PrismProfile 'updater-state.json'
$ActiveManifest = Join-Path $WorkspaceRoot 'manifest-active.json'
$CorruptionMarker = Join-Path $WorkspaceRoot 'corrupt-download'
$Utf8 = [Text.UTF8Encoding]::new($false)
$SignedManifest = [IO.File]::ReadAllText($Manifest)
$Envelope = $SignedManifest | ConvertFrom-Json
$Payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Envelope.payload)) | ConvertFrom-Json
$TargetVersion = $Payload.version
if (-not $TargetVersion -or $Payload.url -ne 'http://127.0.0.1:38744/PRISM-Windows-x64.zip') {
  throw 'The test manifest must name the loopback archive on port 38744.'
}
$PrismProcess = $null
$ServerProcess = $null
$PreviousSmokeDir = $env:PRISM_WINDOWS_SMOKE_DIR
$PreviousFeed = $env:PRISM_WINDOWS_UPDATE_TEST_FEED

# Keep the test server runtime outside the program folder so the updater can replace that folder.
$ServerNode = Join-Path $WorkspaceRoot 'server-node.exe'
Copy-Item -LiteralPath (Join-Path $AppDirectory 'resources/runtime/node.exe') -Destination $ServerNode
$ServerScript = Join-Path $WorkspaceRoot 'server.mjs'
$ServerReady = Join-Path $WorkspaceRoot 'server-ready'
$ServerSource = @'
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Transform } from 'node:stream';
const [manifest, archive, corrupt, ready] = process.argv.slice(2);
const server = createServer((request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (request.url === '/windows-update.json') {
    const bytes = readFileSync(manifest);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
    response.end(bytes);
    return;
  }
  if (request.url === '/PRISM-Windows-x64.zip') {
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': statSync(archive).size });
    const source = createReadStream(archive);
    source.on('error', () => response.destroy());
    if (!existsSync(corrupt)) { source.pipe(response); return; }
    let changed = false;
    source.pipe(new Transform({ transform(chunk, _encoding, next) {
      if (!changed && chunk.length) { chunk[0] ^= 1; changed = true; }
      next(null, chunk);
    } })).pipe(response);
    return;
  }
  response.writeHead(404).end();
});
server.listen(38744, '127.0.0.1', () => writeFileSync(ready, 'ready'));
'@
[IO.File]::WriteAllText($ServerScript, $ServerSource, $Utf8)

function Set-ApiSession([object]$Record) {
  if ($Record.origin -ne 'http://127.0.0.1:38741' -or $Record.token -notmatch '^[a-f0-9]{64}$') {
    throw 'Invalid application startup record.'
  }
  if (-not $Record.hasMain) { throw 'The native window did not render the PRISM workspace.' }
  $script:Session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $cookie = New-Object System.Net.Cookie('prism_desktop', $Record.token, '/', '127.0.0.1')
  $script:Session.Cookies.Add($cookie)
  $script:Origin = $Record.origin
}
function Visit-Companion {
  $response = Invoke-WebRequest -Uri "$script:Origin/focus-pet" -WebSession $script:Session
  if ($response.StatusCode -ne 200) { throw 'The companion page did not load.' }
}
function Wait-Ready([string]$Version, [int]$PreviousPid = 0) {
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    $failure = Join-Path $PrismProfile 'startup-error.txt'
    if (Test-Path -LiteralPath $failure) { throw (Get-Content -Raw -LiteralPath $failure) }
    if (Test-Path -LiteralPath $State) {
      try { $stateRecord = Get-Content -Raw -LiteralPath $State | ConvertFrom-Json } catch { continue }
      if ($stateRecord.status -in @('error', 'rolled-back')) { throw "Update failed: $($stateRecord.message)" }
    }
    if (-not (Test-Path -LiteralPath $Ready)) { continue }
    try { $record = Get-Content -Raw -LiteralPath $Ready | ConvertFrom-Json } catch { continue }
    if ($Version -and $record.version -ne $Version) { continue }
    if ($PreviousPid -and $record.pid -eq $PreviousPid) { continue }
    Set-ApiSession $record
    $script:PrismProcess = Get-Process -Id $record.pid -ErrorAction Stop
    # Retain the native process handle so ExitCode remains available after the app exits.
    $null = $script:PrismProcess.Handle
    return $record
  }
  throw 'The expected native app did not become ready in 120 seconds.'
}
function Wait-UpdateState([string]$Status) {
  for ($i = 0; $i -lt 360; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $State)) { continue }
    try { $record = Get-Content -Raw -LiteralPath $State | ConvertFrom-Json } catch { continue }
    if ($record.status -eq $Status) { return $record }
    if ($record.status -in @('error', 'rolled-back') -and $Status -ne 'error') {
      throw "Update failed: $($record.message)"
    }
  }
  throw "Updater did not reach '$Status' in 180 seconds."
}
function Trigger-Update {
  if (Test-Path -LiteralPath $State) { Remove-Item -LiteralPath $State }
  New-Item -ItemType File -Path (Join-Path $PrismProfile 'update') -Force | Out-Null
}
function Read-Api([string]$Path) {
  return Invoke-RestMethod -Uri "$script:Origin/api/v1$Path" -WebSession $script:Session
}
function Write-Api([string]$Method, [string]$Path, [object]$Data, [string]$Version) {
  $headers = @{ Origin=$script:Origin; 'Idempotency-Key'=[guid]::NewGuid().ToString() }
  if ($Version) { $headers['If-Match'] = '"' + $Version + '"' }
  return Invoke-RestMethod -Method $Method -Uri "$script:Origin/api/v1$Path" -WebSession $script:Session -ContentType 'application/json' -Headers $headers -Body ($Data | ConvertTo-Json -Depth 10)
}
function Stop-Prism {
  New-Item -ItemType File -Path (Join-Path $PrismProfile 'stop') -Force | Out-Null
  if (-not $script:PrismProcess.WaitForExit(20000)) { throw 'PRISM did not close gracefully.' }
  if ($script:PrismProcess.ExitCode -ne 0) { throw "PRISM closed with exit code '$($script:PrismProcess.ExitCode)'." }
}
try {
  [IO.File]::WriteAllText($ActiveManifest, $SignedManifest, $Utf8)
  $arguments = @($ServerScript, $ActiveManifest, $UpdateArchive, $CorruptionMarker, $ServerReady) | ForEach-Object { '"' + $_ + '"' }
  $ServerProcess = Start-Process -FilePath $ServerNode -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $WorkspaceRoot 'server-error.log')
  for ($i = 0; $i -lt 30 -and -not (Test-Path -LiteralPath $ServerReady); $i++) {
    if ($ServerProcess.HasExited) { throw 'The loopback update server exited.' }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $ServerReady)) { throw 'The loopback update server did not start.' }
  $env:PRISM_WINDOWS_SMOKE_DIR = $PrismProfile
  $env:PRISM_WINDOWS_UPDATE_TEST_FEED = 'http://127.0.0.1:38744/windows-update.json'
  $PrismProcess = Start-Process -FilePath $Exe -PassThru
  $initial = Wait-Ready ''
  if ($initial.version -eq $TargetVersion) { throw 'The target archive must have a newer version than the base.' }
  if ((Read-Api '/knowledge-items?limit=1').items.Count -ne 0) { throw 'The base included personal notes.' }
  $noteId = [guid]::NewGuid().ToString()
  $note = Write-Api 'Post' '/knowledge-items' @{ id=$noteId; title='Windows update persistence'; type='theorem'; content='Synthetic update test note.' } ''
  $prefs = Read-Api '/me/preferences'
  $savedPrefs = Write-Api 'Patch' '/me/preferences' @{ daily_review_limit=37 } $prefs.version
  New-Item -ItemType File -Path (Join-Path $PrismProfile 'appearance-dark') | Out-Null
  $appearanceReady = $false
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try { $current = Get-Content -Raw -LiteralPath $Ready | ConvertFrom-Json } catch { continue }
    if ($current.theme -eq 'dark') { $appearanceReady = $true; break }
  }
  if (-not $appearanceReady) { throw 'The appearance test setup failed.' }

  # Alter a signature while retaining a valid envelope. The installed program must stay intact.
  $badEnvelope = $SignedManifest | ConvertFrom-Json
  $signature = [Convert]::FromBase64String($badEnvelope.signature)
  $signature[0] = $signature[0] -bxor 1
  $badEnvelope.signature = [Convert]::ToBase64String($signature)
  [IO.File]::WriteAllText($ActiveManifest, ($badEnvelope | ConvertTo-Json -Compress), $Utf8)
  Trigger-Update
  $rejected = Wait-UpdateState 'error'
  if ($PrismProcess.HasExited) { throw 'A bad manifest stopped the installed app.' }
  if ((Get-Content -Raw -LiteralPath (Join-Path $AppDirectory 'resources/app/package.json') | ConvertFrom-Json).version -ne $initial.version) {
    throw 'A bad manifest replaced the installed app.'
  }
  Write-Output 'Invalid manifest signature was rejected before installation.'

  # Serve corrupted bytes with the signed length to exercise download digest/signature validation.
  [IO.File]::WriteAllText($ActiveManifest, $SignedManifest, $Utf8)
  New-Item -ItemType File -Path $CorruptionMarker | Out-Null
  Trigger-Update
  $rejectedDownload = Wait-UpdateState 'error'
  if ($PrismProcess.HasExited) { throw 'A corrupt download stopped the installed app.' }
  if ((Get-Content -Raw -LiteralPath (Join-Path $AppDirectory 'resources/app/package.json') | ConvertFrom-Json).version -ne $initial.version) {
    throw 'A corrupt download replaced the installed app.'
  }
  if ($rejectedDownload.message -notmatch 'checksum or signature') { throw "Unexpected download failure: $($rejectedDownload.message)" }
  Remove-Item -LiteralPath $CorruptionMarker
  Write-Output 'Corrupt download was rejected before installation.'

  # The older standalone runtime creates this disposable prerender cache while the companion opens.
  # Keep a copy beside the test program to exercise the documented one-time recovery.
  Visit-Companion
  if (Test-Path -LiteralPath $RouteCache) {
    Trigger-Update
    $blocked = Wait-UpdateState 'error'
    if ($blocked.message -notmatch 'extra files') { throw "Unexpected legacy cache failure: $($blocked.message)" }
    Move-Item -LiteralPath $RouteCache -Destination (Join-Path $WorkspaceRoot 'legacy-route-cache')
    Write-Output 'Confirmed the old version refuses its generated companion cache and can retry after moving it.'
  }
  $oldPid = $PrismProcess.Id
  Trigger-Update
  $installed = Wait-UpdateState 'installed'
  $updated = Wait-Ready $TargetVersion $oldPid
  Visit-Companion
  if (Test-Path -LiteralPath $RouteCache) { throw 'The updated companion wrote a cache into the installation.' }
  $restored = Read-Api "/knowledge-items/$noteId"
  $restoredPrefs = Read-Api '/me/preferences'
  $appearance = $updated.appearance | ConvertFrom-Json
  if ($restored.content -ne $note.content) { throw 'The note changed during installation.' }
  if ($restoredPrefs.daily_review_limit -ne 37) { throw 'The review setting changed during installation.' }
  if ($updated.theme -ne 'dark' -or $appearance.textSize -ne 18) { throw 'Appearance changed during installation.' }
  if ((Get-Content -Raw -LiteralPath (Join-Path $AppDirectory 'resources/app/package.json') | ConvertFrom-Json).version -ne $TargetVersion) {
    throw 'The original program folder did not receive the update.'
  }
  Trigger-Update
  $currentState = Wait-UpdateState 'current'
  Stop-Prism
  Write-Output "Windows in-app update $($initial.version) -> $TargetVersion passed. Invalid signatures and corrupted downloads were rejected. The native app relaunched with its synthetic note, review setting, Dark appearance, and font size preserved. The next check reported current."
} finally {
  $env:PRISM_WINDOWS_SMOKE_DIR = $PreviousSmokeDir
  $env:PRISM_WINDOWS_UPDATE_TEST_FEED = $PreviousFeed
  if ($PrismProcess -and -not $PrismProcess.HasExited) {
    & taskkill /PID $PrismProcess.Id /T /F | Out-Null
  }
  if ($ServerProcess -and -not $ServerProcess.HasExited) { Stop-Process -Id $ServerProcess.Id -Force }
}
