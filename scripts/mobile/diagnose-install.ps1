# Find out why an Android phone refuses to install Telga.
#
# "App not installed" is the installer's entire vocabulary. Android knows the
# real reason and does not show it: INSTALL_FAILED_UPDATE_INCOMPATIBLE,
# INSTALL_FAILED_VERIFICATION_FAILURE, INSTALL_FAILED_INSUFFICIENT_STORAGE and
# a dozen others all look identical on the screen. This asks for the code.
#
# Run it with the phone connected by USB and USB debugging on:
#
#   powershell -ExecutionPolicy Bypass -File scripts\mobile\diagnose-install.ps1
#
# Turning on USB debugging: Settings > About phone > tap "Build number" seven
# times > back > System > Developer options > USB debugging. Then replug and
# accept the "Allow USB debugging?" prompt on the phone.

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$apk = Join-Path $PSScriptRoot '..\..\apps\mobile\android\app\build\outputs\apk\release\app-release.apk'
$apk = [System.IO.Path]::GetFullPath($apk)

if (-not (Test-Path $adb)) { Write-Host "adb not found at $adb" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $apk)) { Write-Host "APK not found. Run: npm run mobile:release" -ForegroundColor Red; exit 1 }

Write-Host "`n=== 1. Is the phone connected? ===" -ForegroundColor Cyan
& $adb devices -l
$devices = (& $adb devices | Select-String -Pattern "`tdevice$")
if (-not $devices) {
  Write-Host "No device in 'device' state." -ForegroundColor Red
  Write-Host "  - 'unauthorized' means the phone is waiting for you to accept the USB debugging prompt."
  Write-Host "  - nothing listed means USB debugging is off, or the cable is charge-only."
  exit 1
}

Write-Host "`n=== 2. What is this phone? ===" -ForegroundColor Cyan
$sdk = (& $adb shell getprop ro.build.version.sdk).Trim()
$rel = (& $adb shell getprop ro.build.version.release).Trim()
$abi = (& $adb shell getprop ro.product.cpu.abi).Trim()
$brand = (& $adb shell getprop ro.product.brand).Trim()
$model = (& $adb shell getprop ro.product.model).Trim()
Write-Host "  $brand $model - Android $rel (API $sdk), $abi"
if ([int]$sdk -lt 24) {
  Write-Host "  *** This phone is older than Telga's minimum (API 24). That is the reason. ***" -ForegroundColor Red
}

Write-Host "`n=== 3. Is a conflicting Telga already installed? ===" -ForegroundColor Cyan
# The commonest cause of a silent refusal: a package of the same name signed
# with a different key. Android will not replace it, and will not say so.
$existing = (& $adb shell pm list packages) | Select-String "telga"
if ($existing) {
  Write-Host "  Found:" -ForegroundColor Yellow
  $existing | ForEach-Object { Write-Host "    $_" }
  Write-Host "  If installation keeps failing, remove them first:" -ForegroundColor Yellow
  Write-Host "    adb uninstall et.mulesoo.telga"
  Write-Host "    adb uninstall et.mulesoo.telga.debug"
} else {
  Write-Host "  None. So this is not a signature conflict."
}

Write-Host "`n=== 4. Is there room? ===" -ForegroundColor Cyan
(& $adb shell df /data) | Select-Object -Last 1

Write-Host "`n=== 5. Installing, with the real error ===" -ForegroundColor Cyan
Write-Host "  $apk"
$result = & $adb install -r --no-streaming $apk 2>&1 | Out-String
Write-Host $result

if ($result -match 'Success') {
  Write-Host "INSTALLED." -ForegroundColor Green
  Write-Host "Launching..."
  & $adb shell am start -n et.mulesoo.telga/.MainActivity | Out-Null
  Start-Sleep -Seconds 4
  $pid_ = (& $adb shell pidof et.mulesoo.telga).Trim()
  if ($pid_) { Write-Host "Running (pid $pid_). Open the app on the phone." -ForegroundColor Green }
  else { Write-Host "Installed but not running - check: adb logcat -d | Select-String FATAL" -ForegroundColor Yellow }
} else {
  Write-Host "STILL FAILING. The code above is the answer; the common ones mean:" -ForegroundColor Red
  Write-Host "  INSTALL_FAILED_UPDATE_INCOMPATIBLE  a Telga signed with a different key is installed - uninstall it (step 3)"
  Write-Host "  INSTALL_FAILED_VERIFICATION_FAILURE Play Protect blocked it - Play Store > profile > Play Protect > turn off scanning, install, turn back on"
  Write-Host "  INSTALL_FAILED_INSUFFICIENT_STORAGE not enough free space"
  Write-Host "  INSTALL_FAILED_OLDER_SDK             the phone is older than API 24"
  Write-Host "  INSTALL_PARSE_FAILED_NO_CERTIFICATES the file was altered in transit - re-copy it"
  Write-Host "  INSTALL_FAILED_USER_RESTRICTED       the phone blocks sideloading - allow it in Developer options"
  Write-Host "`nSend the exact line above and it can be fixed for certain rather than guessed at."
}
