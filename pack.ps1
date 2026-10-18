# Đóng gói extension để gửi người khác: chạy  .\pack.ps1  (hoặc chuột phải > Run with PowerShell).
# Kết quả: dist\TNTool\ (thư mục để "Load unpacked") và dist\TNTool-<version>.zip (file để gửi).
# admin.js được thay bằng bản rỗng: người nhận không vào được admin, mật khẩu thật không bị gửi đi.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'extension'
$dist = Join-Path $root 'dist'
$out = Join-Path $dist 'TNTool'

$version = (Get-Content (Join-Path $src 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zip = Join-Path $dist "TNTool-$version.zip"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

# Chỉ lấy file extension cần, bỏ admin.js và file tạm.
Get-ChildItem $src -File |
  Where-Object { $_.Name -ne 'admin.js' -and $_.Extension -notin '.tmp', '.bak' } |
  ForEach-Object { Copy-Item $_.FullName $out }

$stub = "// Bản phân phối: không có mật khẩu admin.`nconst ADMIN_PASSWORD = '';`n"
[IO.File]::WriteAllText((Join-Path $out 'admin.js'), $stub, (New-Object Text.UTF8Encoding $false))

# Chặn lỡ tay: mật khẩu thật không được nằm trong bản đóng gói.
$realAdmin = Get-Content (Join-Path $src 'admin.js') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($realAdmin -match "ADMIN_PASSWORD\s*=\s*'([^']+)'") {
  $pw = $Matches[1]
  $leak = Get-ChildItem $out -File | Where-Object { (Get-Content $_.FullName -Raw -Encoding UTF8) -like "*$pw*" }
  if ($leak) { throw "Mật khẩu admin xuất hiện trong: $($leak.Name -join ', ')" }
}

# Làm rối code (cần Node.js + npm install), rồi kiểm tra cú pháp bản đã làm rối.
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($node) { $node.Source } else { 'C:\Program Files\nodejs\node.exe' }
if (-not (Test-Path $nodeExe)) { throw 'Chưa cài Node.js: cần để làm rối code' }
if (-not (Test-Path (Join-Path $root 'node_modules\javascript-obfuscator'))) { throw 'Chưa cài javascript-obfuscator: chạy npm install trong thư mục TNTools' }
& $nodeExe (Join-Path $root 'obfuscate.js') $out
if ($LASTEXITCODE) { throw 'Làm rối code lỗi' }
foreach ($f in Get-ChildItem $out -Filter *.js) {
  & $nodeExe --check $f.FullName
  if ($LASTEXITCODE) { throw "Bản làm rối lỗi cú pháp: $($f.Name)" }
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip

Write-Host "Xong: $zip"
Write-Host "Các file: $((Get-ChildItem $out -File).Name -join ', ')"
