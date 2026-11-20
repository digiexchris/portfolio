# Start the portfolio editor and print the address to open in a browser.
# Usage: .\start-editor.ps1 [-NoFfmpeg]   (-Port 8080 for another port)
#   -NoFfmpeg   start even without ffmpeg (video uploads will then fail)
# Ctrl+C stops the server.
param(
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4321 }),
    [switch]$NoFfmpeg
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Url = "http://127.0.0.1:$Port/editor/"
$env:PORT = "$Port"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js is not installed (need 22.12+).'
}

# Video uploads are converted with ffmpeg; without it they would only fail
# later, inside the editor.
function Test-Tool([string]$Path) {
    try { & $Path -version *> $null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
if (-not $NoFfmpeg) {
    $ff = if ($env:FFMPEG_PATH) { $env:FFMPEG_PATH } else { 'ffmpeg' }
    $fp = if ($env:FFPROBE_PATH) { $env:FFPROBE_PATH } else { 'ffprobe' }
    if (-not (Test-Tool $ff) -or -not (Test-Tool $fp)) {
        Write-Host 'ffmpeg/ffprobe not found - needed to convert video uploads.'
        Write-Host '  Windows:        winget install Gyan.FFmpeg'
        Write-Host '  Debian/Ubuntu:  sudo apt install ffmpeg'
        Write-Host 'Or set FFMPEG_PATH / FFPROBE_PATH, or start without video support:'
        Write-Host '  .\start-editor.ps1 -NoFfmpeg'
        exit 1
    }
}

if (-not (Test-Path node_modules)) {
    Write-Host 'Installing dependencies (npm ci)...'
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Test-Editor {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# Already running (e.g. another terminal)? Just say where.
if (Test-Editor) {
    Write-Host "Editor already running at $Url"
    exit 0
}

# Through the supervisor, so the editor's Restart button keeps it attached
# to this window.
$server = Start-Process -FilePath node -ArgumentList 'scripts/editor.js' -NoNewWindow -PassThru
try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Editor) { $ready = $true; break }
        if ($server.HasExited) { Write-Error 'Server exited before it was ready.' }
        Start-Sleep -Milliseconds 500
    }
    if ($ready) { Write-Host ''; Write-Host "Open $Url in your browser. Ctrl+C (or .\stop-editor.ps1) stops the editor." }
    else { Write-Warning "Server did not respond at $Url yet; open it when ready." }

    $server.WaitForExit()
} finally {
    # Windows has no signal to pass on, so stopping the supervisor alone would
    # leave the server running: ask the server to stop first.
    if (-not $server.HasExited) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/shutdown" -Method Post -UseBasicParsing `
                -Headers @{ 'X-Portfolio-Editor' = '1' } -TimeoutSec 3 | Out-Null
        } catch {}
        Start-Sleep -Milliseconds 500
        if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    }
}
