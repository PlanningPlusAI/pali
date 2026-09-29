# Pali launcher: starts the backend (hidden) if it is not running, then opens the app window.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 5199
$url = "http://127.0.0.1:$port/"
$logDir = Join-Path $env:LOCALAPPDATA 'Pali\logs'
New-Item -ItemType Directory -Force $logDir | Out-Null

function Test-Backend { try { Invoke-RestMethod "$url`api/status" -TimeoutSec 2 | Out-Null; return $true } catch { return $false } }

# A backend left running from before a code change serves old routes; restart it if server sources are newer.
try {
  $st = Invoke-RestMethod "$url`api/status" -TimeoutSec 2
  $srvNewest = (Get-ChildItem (Join-Path $root 'server\src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  $pkg = (Get-Item (Join-Path $root 'server\package.json')).LastWriteTime
  if ($pkg -gt $srvNewest) { $srvNewest = $pkg }
  if (-not $st.startedAt -or ([datetime]$st.startedAt).ToLocalTime() -lt $srvNewest) {
    & (Join-Path $PSScriptRoot 'stop.ps1') | Out-Null
  }
} catch {}

if (-not (Test-Backend)) {
  # Build the UI once if missing (or if sources are newer than the build).
  $dist = Join-Path $root 'web\dist\index.html'
  $newest = (Get-ChildItem (Join-Path $root 'web\src') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
  if (-not (Test-Path $dist) -or (Get-Item $dist).LastWriteTime -lt $newest) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run build' -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden -Wait
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx tsx src\index.ts > `"$logDir\backend-$stamp.log`" 2>&1" -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if (Test-Backend) { $ok = $true; break } }
  if (-not $ok) { Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show("Pali backend did not start. See $logDir", 'Pali') | Out-Null; exit 1 }
}

# Prefer an Edge/Chrome app window (no browser chrome); fall back to the default browser.
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$profile = Join-Path $env:LOCALAPPDATA 'Pali\browser-profile'
if ($edge) { Start-Process $edge "--app=$url --user-data-dir=`"$profile`" --no-first-run" }
elseif ($chrome) { Start-Process $chrome "--app=$url --user-data-dir=`"$profile`" --no-first-run" }
else { Start-Process $url }
