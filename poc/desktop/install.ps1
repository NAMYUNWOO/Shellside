# Shellside for Windows, installed from PowerShell (no setup program, no SmartScreen prompt):
#
#   irm https://raw.githubusercontent.com/NAMYUNWOO/Shellside/main/poc/desktop/install.ps1 | iex
#
# Downloads the latest release's Shellside-<version>-win-x64.zip, checks it against the SHA-256 GitHub lists for the
# release, unpacks it into %LOCALAPPDATA%\Shellside, adds Start menu and desktop shortcuts and an entry in Settings →
# Apps (to uninstall), then starts Shellside. Run it again to update. Uninstalling keeps your boards
# (%USERPROFILE%\Shellside) and the app's data (%APPDATA%\Shellside).
#
# Settings: SHELLSIDE_VERSION=0.1.0 (a given release), SHELLSIDE_INSTALL_DIR, SHELLSIDE_NO_LAUNCH=1; SHELLSIDE_ZIP=<file>
# installs a .zip you already have (CI uses it). Works in Windows PowerShell 5.1 and PowerShell 7.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 downloads many times slower with its progress bar
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $repo = 'NAMYUNWOO/Shellside'
  $dir = if ($env:SHELLSIDE_INSTALL_DIR) { $env:SHELLSIDE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Shellside' }
  $exe = Join-Path $dir 'Shellside.exe'
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Shellside'
  function Say([string]$en, [string]$ko) { Write-Host "$en · $ko" }

  if (-not [Environment]::Is64BitOperatingSystem) { throw 'Shellside needs 64-bit Windows.' }
  if (Get-Process -Name Shellside -ErrorAction SilentlyContinue) {
    Say 'Quit Shellside first, then run this again.' 'Shellside를 먼저 종료한 뒤 다시 실행하세요.'
    return
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('shellside-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'Shellside.zip'
    if ($env:SHELLSIDE_ZIP) {
      Copy-Item -LiteralPath $env:SHELLSIDE_ZIP -Destination $zip
      $version = 'local'
    } else {
      $which = if ($env:SHELLSIDE_VERSION) { 'tags/v' + $env:SHELLSIDE_VERSION.TrimStart('v') } else { 'latest' }
      $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/$which" -Headers @{ 'User-Agent' = 'Shellside-installer' }
      $asset = @($release.assets | Where-Object { $_.name -like 'Shellside-*-win-x64.zip' })[0]
      if (-not $asset) { throw "Release $($release.tag_name) has no Windows .zip." }
      $version = $release.tag_name
      Say "Downloading Shellside $version ($([math]::Round($asset.size / 1MB)) MB)..." "Shellside $version 내려받는 중..."
      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
      if ($asset.digest -match '^sha256:([0-9a-fA-F]{64})$') {
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $Matches[1]) { throw 'The download does not match the release (SHA-256). Run this again.' }
      }
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

  # Settings → Apps → Shellside → Uninstall: removes the app, its shortcuts and this entry (not your boards).
  $q = { param($p) "'" + ($p -replace "'", "''") + "'" }
  $uninstall = "Get-Process -Name Shellside -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1; " +
    "Remove-Item -LiteralPath $(& $q $dir) -Recurse -Force -ErrorAction SilentlyContinue; " +
    "Remove-Item -LiteralPath $((@($links | ForEach-Object { & $q $_ })) -join ',') -Force -ErrorAction SilentlyContinue; " +
    "Remove-Item -LiteralPath $(& $q $uninstallKey) -Recurse -Force"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($uninstall))
  New-Item -Path $uninstallKey -Force | Out-Null
  $entry = [ordered]@{
    DisplayName     = 'Shellside'
    DisplayVersion  = $version.TrimStart('v')
    Publisher       = 'NAM YUNWOO'
    DisplayIcon     = "$exe,0"
    InstallLocation = $dir
    URLInfoAbout    = "https://github.com/$repo"
    UninstallString = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
  }
  foreach ($name in $entry.Keys) { New-ItemProperty -Path $uninstallKey -Name $name -Value $entry[$name] -PropertyType String -Force | Out-Null }
  foreach ($name in 'NoModify', 'NoRepair') { New-ItemProperty -Path $uninstallKey -Name $name -Value 1 -PropertyType DWord -Force | Out-Null }

  Say "Installed Shellside $version in $dir. Start it from the Start menu; uninstall in Settings > Apps." "설치했습니다. 시작 메뉴에서 여세요. 제거는 설정 > 앱에서 합니다."
  if (-not $env:SHELLSIDE_NO_LAUNCH) { Start-Process -FilePath $exe -WorkingDirectory $dir }
}
