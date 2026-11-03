# Shellside for Windows, installed from PowerShell (no setup program, no SmartScreen prompt):
#
#   irm https://raw.githubusercontent.com/NAMYUNWOO/Shellside/main/poc/desktop/install.ps1 | iex
#
# Downloads the latest release's Shellside-<version>-win-x64.zip, checks it against the release's SHA256SUMS.txt,
# unpacks it into %LOCALAPPDATA%\Shellside, adds Start menu and desktop shortcuts and an entry in Settings >
# Apps (to uninstall), then starts Shellside. Run it again to update. Uninstalling keeps your boards
# (%USERPROFILE%\Shellside) and the app's data (%APPDATA%\Shellside).
#
# When that version is installed already, it says so and only starts it (SHELLSIDE_FORCE=1 installs it again).
#
# Settings: SHELLSIDE_VERSION=0.1.0 (a given release), SHELLSIDE_INSTALL_DIR, SHELLSIDE_NO_LAUNCH=1, SHELLSIDE_FORCE=1;
# SHELLSIDE_ZIP=<file> (+ SHELLSIDE_ZIP_VERSION) installs a .zip you already have (CI uses it). Works in Windows
# PowerShell 5.1 and PowerShell 7.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads many times slower with its progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = 'NAMYUNWOO/Shellside'
  $dir = if ($env:SHELLSIDE_INSTALL_DIR) { $env:SHELLSIDE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Shellside' }
  $exe = Join-Path $dir 'Shellside.exe'
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Shellside'
  function Say([string]$text) { Write-Host $text }

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Shellside needs 64-bit Windows.' }

  # Which version to install: a .zip given here, a given release, or the latest. The latest comes from where
  # github.com/<repo>/releases/latest redirects (.../releases/tag/v<version>), not from api.github.com, which allows only
  # 60 requests an hour per address (and offices share one).
  if ($env:SHELLSIDE_ZIP) {
    $version = if ($env:SHELLSIDE_ZIP_VERSION) { $env:SHELLSIDE_ZIP_VERSION } else { 'local' }
  } elseif ($env:SHELLSIDE_VERSION) {
    $version = $env:SHELLSIDE_VERSION
  } else {
    # The query keeps an edge cache from answering with the redirect from before the newest release.
    $request = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest?t=$([DateTime]::UtcNow.Ticks)")
    $request.Method = 'HEAD'
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'Shellside-installer'
    $response = $request.GetResponse()
    try { $location = [string]$response.Headers['Location'] } finally { $response.Close() }
    if ($location -notmatch '/releases/tag/([^/?#]+)$') { throw "No Shellside release is published yet (github.com/$repo/releases)." }
    $version = [Uri]::UnescapeDataString($Matches[1])
  }
  $version = $version.TrimStart('v')
  $base = "https://github.com/$repo/releases/download/v$version"
  $zipName = "Shellside-$version-win-x64.zip"
  $installed = (Get-ItemProperty -Path $uninstallKey -ErrorAction SilentlyContinue).DisplayVersion
  if ($installed -and $installed -eq $version -and $version -ne 'local' -and -not $env:SHELLSIDE_FORCE -and (Test-Path -LiteralPath $exe)) {
    Say "Shellside $version is installed and up to date."
    if (-not $env:SHELLSIDE_NO_LAUNCH) { Start-Process -FilePath $exe -WorkingDirectory $dir }
    return
  }

  # Its files are in use while it runs.
  if (Get-Process -Name Shellside -ErrorAction SilentlyContinue) {
    Say 'Quit Shellside first, then run this again.'
    return
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('shellside-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'Shellside.zip'
    if ($env:SHELLSIDE_ZIP) {
      Copy-Item -LiteralPath $env:SHELLSIDE_ZIP -Destination $zip
    } else {
      $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -UseBasicParsing).Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
      $line = @($sums -split "`n" | Where-Object { $_ -match ('^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($zipName) + '\s*$') })[0]
      if (-not $line) { throw "Release v$version lists no SHA-256 for $zipName." }
      $expected = ($line -split '\s+')[0]
      Say $(if ($installed) { "Updating Shellside $installed to $version..." } else { "Downloading Shellside $version..." })
      Invoke-WebRequest -Uri "$base/$zipName" -OutFile $zip -UseBasicParsing
      if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected.ToUpper()) { throw 'The download does not match the release (SHA-256). Run this again.' }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $new = Join-Path $tmp 'app'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $new)
    if (-not (Test-Path -LiteralPath (Join-Path $new 'Shellside.exe'))) { throw 'Shellside.exe is not in the .zip.' }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $dir) -Force | Out-Null
    Move-Item -LiteralPath $new -Destination $dir
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Shortcuts in the Start menu and on the desktop.
  $links = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Shellside.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Shellside.lnk'))
  $shell = New-Object -ComObject WScript.Shell
  foreach ($path in $links) {
    $link = $shell.CreateShortcut($path)
    $link.TargetPath = $exe
    $link.WorkingDirectory = $dir
    $link.Description = 'Shellside'
    $link.Save()
  }

  # Settings > Apps > Shellside > Uninstall: removes the app, its shortcuts and this entry (not your boards).
  $q = { param($p) "'" + ($p -replace "'", "''") + "'" }
  $uninstall = "Get-Process -Name Shellside -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1; " +
    "Remove-Item -LiteralPath $(& $q $dir) -Recurse -Force -ErrorAction SilentlyContinue; " +
    "Remove-Item -LiteralPath $((@($links | ForEach-Object { & $q $_ })) -join ',') -Force -ErrorAction SilentlyContinue; " +
    "Remove-Item -LiteralPath $(& $q $uninstallKey) -Recurse -Force"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($uninstall))
  New-Item -Path $uninstallKey -Force | Out-Null
  $entry = [ordered]@{
    DisplayName     = 'Shellside'
    DisplayVersion  = $version
    Publisher       = 'NAM YUNWOO'
    DisplayIcon     = "$exe,0"
    InstallLocation = $dir
    URLInfoAbout    = "https://github.com/$repo"
    UninstallString = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
  }
  foreach ($name in $entry.Keys) { New-ItemProperty -Path $uninstallKey -Name $name -Value $entry[$name] -PropertyType String -Force | Out-Null }
  foreach ($name in 'NoModify', 'NoRepair') { New-ItemProperty -Path $uninstallKey -Name $name -Value 1 -PropertyType DWord -Force | Out-Null }

  Say "Installed Shellside $version in $dir."
  Say 'Start it from the Start menu. To update, run this line again; to uninstall, use Settings > Apps.'
  if (-not $env:SHELLSIDE_NO_LAUNCH) { Start-Process -FilePath $exe -WorkingDirectory $dir }
}
