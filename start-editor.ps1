# Start the portfolio editor and open it in Firefox.
# Usage: .\start-editor.ps1            (.\start-editor.ps1 -Port 8080 for another port)
# Ctrl+C stops the server.
param([int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4321 }))

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$Url = "http://127.0.0.1:$Port/editor/"
$env:PORT = "$Port"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js is not installed (need 20+).'
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

function Find-Firefox {
    $cmd = Get-Command firefox -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:ProgramFiles\Mozilla Firefox\firefox.exe",
        "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe",
        "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe"
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    foreach ($key in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe') {
        try { $p = (Get-ItemProperty $key).'(default)'; if ($p -and (Test-Path $p)) { return $p } } catch {}
    }
    return $null
}

function Open-Firefox {
    $ff = Find-Firefox
    if ($ff) { Start-Process -FilePath $ff -ArgumentList '--new-window', $Url }
    else { Write-Warning "Firefox not found; open $Url manually." }
}

# Already running (e.g. another terminal)? Just open the browser.
if (Test-Editor) {
    Write-Host "Editor already running at $Url"
    Open-Firefox
    exit 0
}

$server = Start-Process -FilePath node -ArgumentList 'server.js' -NoNewWindow -PassThru
try {
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Editor) { $ready = $true; break }
        if ($server.HasExited) { Write-Error 'Server exited before it was ready.' }
        Start-Sleep -Milliseconds 500
    }
    if ($ready) { Open-Firefox }
    else { Write-Warning "Server did not respond at $Url yet; open it manually when ready." }

    $server.WaitForExit()
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
