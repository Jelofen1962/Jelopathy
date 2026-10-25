$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) { $python = 'py'; $pythonArgs = @('-3') } else {
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { throw 'Python 3.10+ is required. Install Python from python.org and retry.' }
  $python = 'python'; $pythonArgs = @()
}
& $python @pythonArgs -c "import sys; assert sys.version_info >= (3,10), 'Python 3.10+ required'"
if (-not (Test-Path '.venv')) { & $python @pythonArgs -m venv .venv }
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements.txt
$envLines = @()
if (Test-Path '.env') { $envLines = @(Get-Content '.env') }
$tokenLine = $envLines | Where-Object { $_ -match '^JELOPATHY_SERVER_TOKEN=(.+)$' } | Select-Object -First 1
if (-not $tokenLine -or $tokenLine -match 'replace-with-a-long-random-secret' -or $tokenLine.Length -lt 25) {
  $token = & $venvPython -c "import secrets; print(secrets.token_urlsafe(36))"
  if ($tokenLine) {
    $envLines = @($envLines | ForEach-Object { if ($_ -match '^JELOPATHY_SERVER_TOKEN=') { "JELOPATHY_SERVER_TOKEN=$token" } else { $_ } })
  } else {
    $envLines += "JELOPATHY_SERVER_TOKEN=$token"
  }
  if (-not ($envLines | Where-Object { $_ -match '^JELOPATHY_HOST=' })) { $envLines += 'JELOPATHY_HOST=0.0.0.0' }
  if (-not ($envLines | Where-Object { $_ -match '^JELOPATHY_PORT=' })) { $envLines += 'JELOPATHY_PORT=8080' }
  $envLines | Set-Content -Encoding ascii '.env'
  Write-Host 'Generated a strong server token in server/.env. Keep it secret.' -ForegroundColor Green
}
Get-Content '.env' | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process') }
}
Write-Host "Jelopathy relay starting on port $($env:JELOPATHY_PORT). Use the token from server/.env in the desktop app." -ForegroundColor Cyan
& $venvPython server.py
