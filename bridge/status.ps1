$statusFile = Join-Path $env:LOCALAPPDATA "MultiTool-Mirror\status.json"
if (-not (Test-Path -LiteralPath $statusFile)) {
  Write-Host "Мост ещё не запускался: нет файла $statusFile" -ForegroundColor Yellow
  Write-Host "Файл появится после перезапуска MultiTool с установленным плагином."
  exit 1
}
$status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
Write-Host ""
Write-Host "  MultiTool Mirror (мост на компьютере)" -ForegroundColor Cyan
Write-Host "  версия $($status.version), запущен $($status.startedAt)"
Write-Host ""
Write-Host "  Код сопряжения: " -NoNewline
Write-Host $status.code -ForegroundColor Green -BackgroundColor Black
Write-Host ""
Write-Host "  Адреса для телефона:"
foreach ($url in $status.urls) { Write-Host "    $url" }
Write-Host ""
Write-Host "  Подключённые устройства: $($status.paired)"
foreach ($device in $status.devices) { Write-Host "    - $($device.name) ($($device.createdAt))" }
Write-Host ""
Write-Host "  Инстансов движка: $($status.instances.Count), известно чатов: $($status.sessions)"
if ($status.lastError) { Write-Host "  Последняя ошибка: $($status.lastError)" -ForegroundColor Yellow }
Write-Host ""
