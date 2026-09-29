# Creates "Pali.lnk" (Desktop + project root) that runs launch.ps1 hidden, with the Pali icon. Removes old Canvas shortcuts.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'scripts\pali.ico'
foreach ($old in @((Join-Path $root 'Canvas.lnk'), (Join-Path $root 'Stop Canvas.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Canvas.lnk'))) { if (Test-Path $old) { Remove-Item $old -Force } }
$target = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\launch.ps1`""
$shell = New-Object -ComObject WScript.Shell
foreach ($dest in @((Join-Path $root 'Pali.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Pali.lnk'))) {
  $lnk = $shell.CreateShortcut($dest)
  $lnk.TargetPath = $target
  $lnk.Arguments = $args
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'Pali - AI writing workspace (palimpsest)'
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Host "created $dest"
}
$stop = $shell.CreateShortcut((Join-Path $root 'Stop Pali.lnk'))
$stop.TargetPath = $target
$stop.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$root\scripts\stop.ps1`""
$stop.WorkingDirectory = $root
$stop.IconLocation = "$env:SystemRoot\System32\imageres.dll,100"
$stop.Save()
Write-Host 'created Stop Pali.lnk'
