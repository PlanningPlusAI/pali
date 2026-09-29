# Stops the Pali backend (and its Claude child processes) started by launch.ps1.
$ErrorActionPreference = 'SilentlyContinue'
try { Invoke-RestMethod -Method Post 'http://127.0.0.1:5199/api/shutdown' -TimeoutSec 3 | Out-Null } catch {}
Start-Sleep -Seconds 3
# Belt and braces: kill whatever still listens on the port.
$pids = (netstat -ano | Select-String '127.0.0.1:5199\s+.*LISTENING') | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique
foreach ($p in $pids) { if ($p -match '^\d+$') { taskkill /PID $p /F /T | Out-Null } }
Write-Host 'Pali stopped.'
