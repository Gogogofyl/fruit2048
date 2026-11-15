# 手动打 APK（不依赖 Gradle，只用 Android SDK 自带工具）
#
# 为什么要挪到纯 ASCII 路径：aapt2 / d8 在中文路径下 stat 文件会失败，
# 而本机用户名和项目目录都带中文，所以构建全部在 D:\f2048build 里做。
#
# 用法：pwsh -File build\android\build-apk.ps1

$ErrorActionPreference = "Stop"

$ProjectRoot = "D:\fylcode\DigitalHuman\小游戏2048"
$SourceDir   = Join-Path $ProjectRoot "build\android"
$WorkDir     = "D:\f2048build"
$WorkAndroid = Join-Path $WorkDir "android"
$WorkJar     = Join-Path $WorkDir "android.jar"

$Sdk         = "C:\Users\防御力\AppData\Local\Android\Sdk"
$BuildTools  = Join-Path $Sdk "build-tools\34.0.0"
$PlatformJar = Join-Path $Sdk "platforms\android-34\android.jar"

$Aapt2     = Join-Path $BuildTools "aapt2.exe"
$Zipalign  = Join-Path $BuildTools "zipalign.exe"
$ApkSigner = Join-Path $BuildTools "apksigner.bat"
$D8        = Join-Path $BuildTools "d8.bat"

$Keystore     = Join-Path $WorkAndroid "fruit2048.jks"
$StorePass    = "fruit2048"
$KeyAlias     = "fruit2048"
$OutApkName   = "Fruit2048.apk"

function Step($msg) { Write-Host "== $msg ==" }

# 0. 准备 ASCII 工作区
Step "同步工程到 $WorkAndroid"
New-Item -ItemType Directory -Path $WorkAndroid -Force | Out-Null
if (-not (Test-Path -LiteralPath $WorkJar)) {
    Copy-Item -LiteralPath $PlatformJar -Destination $WorkJar
    Write-Host "  已复制 android.jar"
}
foreach ($item in @("AndroidManifest.xml", "res", "java", "assets")) {
    $src = Join-Path $SourceDir $item
    if (-not (Test-Path -LiteralPath $src)) { throw "缺少 $src" }
    $dst = Join-Path $WorkAndroid $item
    if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
    Copy-Item -LiteralPath $src -Destination $WorkAndroid -Recurse
    Write-Host "  $item"
}

# 1. 编译资源
Step "aapt2 compile"
if (Test-Path -LiteralPath (Join-Path $WorkAndroid "res.zip")) {
    Remove-Item -LiteralPath (Join-Path $WorkAndroid "res.zip") -Force
}
& $Aapt2 compile --dir (Join-Path $WorkAndroid "res") -o (Join-Path $WorkAndroid "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

# 2. 链接资源
Step "aapt2 link"
if (Test-Path -LiteralPath (Join-Path $WorkAndroid "gen")) {
    Remove-Item -LiteralPath (Join-Path $WorkAndroid "gen") -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $WorkAndroid "gen") -Force | Out-Null
& $Aapt2 link -o (Join-Path $WorkAndroid "base.apk") `
    --manifest (Join-Path $WorkAndroid "AndroidManifest.xml") `
    -R (Join-Path $WorkAndroid "res.zip") `
    -I $WorkJar `
    --java (Join-Path $WorkAndroid "gen") `
    -A (Join-Path $WorkAndroid "assets") `
    --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# 3. 编译 Java
Step "javac"
$classes = Join-Path $WorkAndroid "classes"
if (Test-Path -LiteralPath $classes) { Remove-Item -LiteralPath $classes -Recurse -Force }
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$sources  = (Get-ChildItem -LiteralPath (Join-Path $WorkAndroid "java") -Recurse -Filter "*.java").FullName
$sources += (Get-ChildItem -LiteralPath (Join-Path $WorkAndroid "gen")  -Recurse -Filter "*.java").FullName
& javac -source 8 -target 8 -encoding UTF-8 -classpath $WorkJar -d $classes $sources 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# 4. 打 jar 并转 dex
Step "jar + d8"
$jarPath = Join-Path $WorkAndroid "classes.jar"
if (Test-Path -LiteralPath $jarPath) { Remove-Item -LiteralPath $jarPath -Force }
& jar cf $jarPath -C $classes .
$dexDir = Join-Path $WorkAndroid "dex"
if (Test-Path -LiteralPath $dexDir) { Remove-Item -LiteralPath $dexDir -Recurse -Force }
New-Item -ItemType Directory -Path $dexDir -Force | Out-Null
& $D8 --lib $WorkJar --min-api 24 --output $dexDir $jarPath 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "d8 失败（注意：不要用 Java 泛型形参写 ValueCallback，会让 d8 崩）" }

# 5. 把 dex 合进 apk
Step "合并 classes.dex"
$merged = Join-Path $WorkAndroid "withdex.apk"
& python -c @"
import zipfile, shutil
shutil.copyfile(r'$($WorkAndroid)\base.apk', r'$merged')
with zipfile.ZipFile(r'$merged', 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(r'$dexDir\classes.dex', 'classes.dex')
"@
if ($LASTEXITCODE -ne 0) { throw "合并 dex 失败" }

# 6. 对齐
Step "zipalign"
$aligned = Join-Path $WorkAndroid "aligned.apk"
& $Zipalign -f 4 $merged $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

# 7. 签名
Step "签名"
if (-not (Test-Path -LiteralPath $Keystore)) {
    & keytool -genkeypair -v -keystore $Keystore -alias $KeyAlias `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass $StorePass -keypass $StorePass `
        -dname "CN=Fruit2048, O=Local, L=Nanjing, C=CN" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keystore 生成失败" }
}
$outApk = Join-Path $WorkAndroid $OutApkName
if (Test-Path -LiteralPath $outApk) { Remove-Item -LiteralPath $outApk -Force }
& $ApkSigner sign --ks $Keystore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$StorePass" --key-pass "pass:$StorePass" `
    --out $outApk $aligned
if ($LASTEXITCODE -ne 0) { throw "签名失败" }

# 8. 校验并回拷到项目
Step "校验"
& $ApkSigner verify --print-certs $outApk
if ($LASTEXITCODE -ne 0) { throw "签名校验未通过" }

$distDir = Join-Path $ProjectRoot "build\dist"
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
Copy-Item -LiteralPath $outApk -Destination (Join-Path $distDir $OutApkName) -Force
Copy-Item -LiteralPath $Keystore -Destination (Join-Path $ProjectRoot "build\android\fruit2048-keystore.jks") -Force

Step "完成"
$finalApk = Join-Path $distDir $OutApkName
Write-Host ("APK: {0}  {1:N1} KB" -f $finalApk, ((Get-Item -LiteralPath $finalApk).Length / 1KB))
Write-Host "签名文件: build\android\fruit2048-keystore.jks (口令 $StorePass, 别名 $KeyAlias)"
