$ErrorActionPreference = "Stop"
$SDK = "C:\Users\Admin\AppData\Local\Android\Sdk"
$BUILD_TOOLS = "$SDK\build-tools\34.0.0"
$PLATFORM_JAR = "$SDK\platforms\android-34\android.jar"
$JAVA_BIN = "C:\Program Files\Java\jdk-17\bin"
$APP_DIR = "C:\Users\Admin\Desktop\whatsapp\android_app"

Write-Host ">>> 1. Generating Keystore if needed..."
if (-not (Test-Path "$APP_DIR\debug.keystore")) {
    & "$JAVA_BIN\keytool.exe" -genkey -v -keystore "$APP_DIR\debug.keystore" -alias androiddebugkey -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
}

Set-Location $APP_DIR

Write-Host ">>> 2. Compiling resources with aapt2..."
if (Test-Path "compiled_res.zip") { Remove-Item "compiled_res.zip" -Force }
& "$BUILD_TOOLS\aapt2.exe" compile --dir res -o compiled_res.zip

Write-Host ">>> 3. Linking resources and generating R.java..."
if (Test-Path "unaligned.apk") { Remove-Item "unaligned.apk" -Force }
& "$BUILD_TOOLS\aapt2.exe" link -I $PLATFORM_JAR compiled_res.zip --manifest AndroidManifest.xml -o unaligned.apk --java src

Write-Host ">>> 4. Compiling Java sources with javac..."
if (-not (Test-Path "bin")) { New-Item -ItemType Directory -Path "bin" }
Get-ChildItem -Path "bin\*" -Recurse | Remove-Item -Force -Recurse
$javaFiles = Get-ChildItem -Path "src\com\whatsapp\sender\*.java" | ForEach-Object { $_.FullName }
& "$JAVA_BIN\javac.exe" -cp "$PLATFORM_JAR;src" -d bin $javaFiles

Write-Host ">>> 5. Compiling classes to DEX with d8..."
if (Test-Path "classes.dex") { Remove-Item "classes.dex" -Force }
$classFiles = Get-ChildItem -Path "bin\com\whatsapp\sender\*.class" | ForEach-Object { $_.FullName }
& "$BUILD_TOOLS\d8.bat" $classFiles --output .

Write-Host ">>> 6. Adding classes.dex to APK with aapt..."
& "$BUILD_TOOLS\aapt.exe" add unaligned.apk classes.dex

Write-Host ">>> 7. Aligning APK with zipalign..."
if (Test-Path "aligned.apk") { Remove-Item "aligned.apk" -Force }
& "$BUILD_TOOLS\zipalign.exe" -p -f 4 unaligned.apk aligned.apk

Write-Host ">>> 8. Signing APK with apksigner..."
if (Test-Path "WhatsApp-Sender.apk") { Remove-Item "WhatsApp-Sender.apk" -Force }
& "$BUILD_TOOLS\apksigner.bat" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out WhatsApp-Sender.apk aligned.apk

Write-Host ">>> 9. Copying APK to public/ and Desktop..."
Copy-Item "WhatsApp-Sender.apk" -Destination "C:\Users\Admin\Desktop\whatsapp\public\WhatsApp-Sender.apk" -Force
Copy-Item "WhatsApp-Sender.apk" -Destination "C:\Users\Admin\Desktop\WhatsApp-Sender.apk" -Force

Write-Host "SUCCESS: APK Built successfully!"
Get-Item "C:\Users\Admin\Desktop\WhatsApp-Sender.apk" | Select-Object Name, Length, LastWriteTime
