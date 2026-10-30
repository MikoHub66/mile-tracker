# Builds the Mile Tracker debug APK from scratch (safe to re-run).
# Output: dist\MileTracker-debug.apk
#
# NOTE: npm, npx and gradlew all write warnings to stderr (npm's audit summary,
# Gradle's SDK-XML note). PowerShell's "Stop" preference turns native stderr into
# a terminating error, so we keep ErrorActionPreference at "Continue" and check
# $LASTEXITCODE after each native command ourselves via Run().
$ErrorActionPreference = "Continue"
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "C:\Users\Matt\AndroidSdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
$root = $PSScriptRoot
$app = Join-Path $root "mobile-app"

function Run($cmd, [string[]]$cmdArgs) {
    & $cmd @cmdArgs
    if ($LASTEXITCODE -ne 0) { throw "$cmd $($cmdArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

Set-Location $app
Write-Output "Installing npm packages..."
Run "npm" @("install")
Run "npm" @("run", "sync:shared")
Write-Output "Bundling Firebase + Leaflet..."
Run "npm" @("run", "prepare:vendor")
Run "npm" @("test")

if (-not (Test-Path (Join-Path $app "android"))) {
    Write-Output "Generating the Android project..."
    Run "npx" @("cap", "add", "android")
    Run "npx" @("capacitor-assets", "generate", "--android", "--iconBackgroundColor", "#1f2a37", "--splashBackgroundColor", "#1f2a37")
}
Run "npx" @("cap", "sync", "android")
Run "node" @("scripts/patch-android.mjs")
Run "node" @("scripts/pack-assets.mjs")   # minify/obfuscate the JS bundled into the APK

Write-Output "Building debug APK + native unit tests..."
Set-Location (Join-Path $app "android")
Run ".\gradlew.bat" @(":mile-native:testDebugUnitTest", "assembleDebug")
& .\gradlew.bat --stop | Out-Null

New-Item -ItemType Directory -Force (Join-Path $root "dist") | Out-Null
Copy-Item "app\build\outputs\apk\debug\app-debug.apk" (Join-Path $root "dist\MileTracker-debug.apk") -Force
Write-Output "APK ready: $(Join-Path $root 'dist\MileTracker-debug.apk')"
