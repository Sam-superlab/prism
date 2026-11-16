param(
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($WorkspaceRoot)) { throw 'Use the absolute isolated update smoke directory.' }
$AppDirectory = Join-Path $WorkspaceRoot 'extracted/PRISM'
$Node = Join-Path $AppDirectory 'resources/runtime/node.exe'
$Installed = Join-Path $WorkspaceRoot 'test/updater-state.json'
if (-not (Test-Path -LiteralPath $Installed -PathType Leaf) -or
    (Get-Content -Raw -LiteralPath $Installed | ConvertFrom-Json).status -ne 'current') {
  throw 'The signed upgrade and data-retention test must finish before scoring.'
}
$TestScript = Join-Path $PSScriptRoot 'verify-windows-model.mjs'
$Fixture = Join-Path $PSScriptRoot 'public-arxiv-fixture.json'
& $Node $TestScript $AppDirectory $Fixture
if ($LASTEXITCODE -ne 0) { throw 'Bundled Windows MiniLM scoring failed after in-app update.' }
