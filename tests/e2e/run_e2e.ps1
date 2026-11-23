# Runs all browser end-to-end checks against a throw-away database (your real data/history.db is never used).
#   .\tests\e2e\run_e2e.ps1                      # run everything
#   .\tests\e2e\run_e2e.ps1 -Only reports_model  # run one script (substring match)
# Needs: the project venv, Node 22+, Google Chrome (set $env:CHROME_PATH if it is installed elsewhere).
param([string]$Only = "", [int]$Port = 8791)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$py = Join-Path $root ".venv\Scripts\python.exe"
$metrics = Join-Path $root "evaluation\results\metrics.json"
$work = Join-Path $env:TEMP ("od-e2e-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
& $py -I (Join-Path $PSScriptRoot "prepare_fixtures.py") $work | Out-Null
$scripts = Get-ChildItem (Join-Path $PSScriptRoot "*.mjs") | Where-Object { $_.Name -like "*$Only*" }
$failed = @()
foreach ($s in $scripts) {
    Write-Host "`n=== $($s.Name) ===" -ForegroundColor Cyan
    $env:OPEN_DETECTOR_DB = Join-Path $work ($s.BaseName + ".db")
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
    $srv = Start-Process $py -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $Port -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $work "server.log")
    try {
        $ok = $false
        for ($i = 0; $i -lt 60 -and -not $ok; $i++) { Start-Sleep 3; try { $ok = (Invoke-RestMethod "http://127.0.0.1:$Port/api/status").model -ne $null } catch { } }
        if (-not $ok) { throw "server did not start (see $work\server.log)" }
        $args = @($s.FullName, $work)
        if ($s.Name -like "*reports_model*") { $args += @($metrics, $py) }
        if ($s.Name -like "smoke*") { $args += @((Join-Path $work "screens"), "seed") }
        node @args
        if ($LASTEXITCODE -ne 0) { $failed += $s.Name }
    } finally {
        Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
        Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "remote-debugging-port=93" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep 2
    }
}
Write-Host "`nScratch files: $work"
if ($failed.Count) { Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host "All browser end-to-end scripts passed." -ForegroundColor Green
