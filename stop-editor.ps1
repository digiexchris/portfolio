# Stop the portfolio editor, however it was started.
# Usage: .\stop-editor.ps1            (-Port 8080 for another port)
#        .\stop-editor.ps1 -All       stop every editor started from this folder
#
# A running editor records itself in .cache\editor-<port>.json. This asks it
# to shut down; if it doesn't answer, it is killed by PID -- but only after
# checking that PID is still a node process running server.js, so a stale
# file can never take some other process down with it.
param(
    [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4321 }),
    [switch]$All
)

Set-Location $PSScriptRoot

if ($All) {
    $files = @(Get-ChildItem -Path .cache -Filter 'editor-*.json' -ErrorAction SilentlyContinue)
    if (-not $files) { Write-Host 'No editor is running.'; exit 0 }
} else {
    $f = Join-Path '.cache' "editor-$Port.json"
    if (-not (Test-Path $f)) { Write-Host "No editor found on port $Port."; exit 1 }
    $files = @(Get-Item $f)
}

function Test-Ours([int]$ProcessId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    return $p -and $p.Name -like 'node*' -and $p.CommandLine -like '*server.js*'
}

$status = 0
foreach ($file in $files) {
    $st = Get-Content $file.FullName -Raw | ConvertFrom-Json
    $procId = [int]$st.pid
    $p = [int]$st.port

    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue) -or -not (Test-Ours $procId)) {
        Write-Host "Port ${p}: not running (removed a stale record)."
        Remove-Item $file.FullName -Force
        continue
    }

    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/shutdown" -Method Post -UseBasicParsing `
            -Headers @{ 'X-Portfolio-Editor' = '1' } -TimeoutSec 3 | Out-Null
    } catch {}

    for ($i = 0; $i -lt 20 -and (Get-Process -Id $procId -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 250
    }

    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
        Write-Host "Port ${p}: editor (PID $procId) did not answer; stopping it."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }

    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
        Write-Warning "Port ${p}: could not stop PID $procId."
        $status = 1
    } else {
        if (Test-Path $file.FullName) { Remove-Item $file.FullName -Force }
        Write-Host "Port ${p}: editor stopped."
    }
}
exit $status
