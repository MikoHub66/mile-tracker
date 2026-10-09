# Builds the Mile Tracker debug APK from scratch (safe to re-run).
# Output: dist\MileTracker-debug.apk
$ErrorActionPreference = "Stop"
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Users\Matt\AndroidSdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
$root = $PSScriptRoot
$app = Join-Path $root "mobile-app"

Set-Location $app
Write-Output "Installing npm packages..."
npm install
npm run sync:shared
Write-Output "Bundling Firebase + Leaflet..."
npm run prepare:vendor
npm test

if (-not (Test-Path (Join-Path $app "android"))) {
    Write-Output "Generating the Android project..."
    npx cap add android
    npx capacitor-assets generate --android --iconBackgroundColor "#1f2a37" --splashBackgroundColor "#1f2a37"
}
npx cap sync android
node scripts/patch-android.mjs

Write-Output "Building debug APK + native unit tests..."
Set-Location (Join-Path $app "android")
# Gradle prints SDK warnings on stderr; don't let PowerShell treat them as fatal.
$ErrorActionPreference = "Continue"
.\gradlew.bat :mile-native:testDebugUnitTest assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed ($LASTEXITCODE)" }
$ErrorActionPreference = "Stop"
.\gradlew.bat --stop | Out-Null

New-Item -ItemType Directory -Force (Join-Path $root "dist") | Out-Null
Copy-Item "app\build\outputs\apk\debug\app-debug.apk" (Join-Path $root "dist\MileTracker-debug.apk") -Force
Write-Output "APK ready: $(Join-Path $root 'dist\MileTracker-debug.apk')"
