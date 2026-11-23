# Start Open Detector (FastAPI) on http://127.0.0.1:8000
Set-Location $PSScriptRoot
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
& "$PSScriptRoot\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
