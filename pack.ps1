# Đóng gói extension để phát hành: chạy  .\pack.ps1  (hoặc chuột phải > Run with PowerShell).
# Kết quả: dist\TNTool-<version>.zip

$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'extension'
$dist = Join-Path $PSScriptRoot 'dist'

$version = (Get-Content (Join-Path $src 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zip = Join-Path $dist "TNTool-$version.zip"

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $zip) { Remove-Item $zip -Force }

# Chỉ lấy file extension cần, bỏ file tạm.
$files = Get-ChildItem $src -File | Where-Object { $_.Extension -notin '.tmp', '.bak' }
Compress-Archive -Path $files.FullName -DestinationPath $zip

Write-Host "Xong: $zip"
Write-Host "Các file: $($files.Name -join ', ')"
