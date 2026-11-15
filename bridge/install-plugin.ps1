param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE ".config\gigatool\opencode.json"),
  [string]$PluginPath = ((Join-Path $PSScriptRoot "multitool-mirror.mjs") -replace '\\', '/'),
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PluginPath)) { throw "не найден файл плагина: $PluginPath" }

if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "не найден конфиг: $ConfigPath" }
$raw = Get-Content -LiteralPath $ConfigPath -Raw
$json = $raw | ConvertFrom-Json
$current = @()
if ($json.PSObject.Properties.Name -contains "plugin" -and $json.plugin) { $current = @($json.plugin) }

$backup = "$ConfigPath.bak-mirror-" + (Get-Date -Format "yyyyMMdd-HHmmss")
Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
Write-Host "Резервная копия: $backup"

if ($Remove) {
  $next = $current | Where-Object { $_ -ne $PluginPath }
  if ($next.Count -eq $current.Count) { Write-Host "Плагина в конфиге нет — нечего убирать"; exit 0 }
} else {
  if ($current -contains $PluginPath) { Write-Host "Плагин уже прописан в конфиге"; exit 0 }
  $next = @($current) + $PluginPath
}

$list = ($next | ForEach-Object { '    "' + ($_ -replace '\\', '\\') + '"' }) -join ",`r`n"
$block = "  `"plugin`": [`r`n$list`r`n  ],`r`n"

if ($json.PSObject.Properties.Name -contains "plugin") {
  $pattern = '(?s)("plugin"\s*:\s*\[).*?(\]\s*,?)'
  $updated = [regex]::Replace($raw, $pattern, { param($m) "`"plugin`": [`r`n$list`r`n  ]," }, 1)
} else {
  $index = $raw.IndexOf("{")
  $updated = $raw.Substring(0, $index + 1) + "`r`n" + $block + $raw.Substring($index + 1)
}

$updated | Set-Content -LiteralPath $ConfigPath -Encoding utf8 -NoNewline
$check = (Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json)
Write-Host "Готово. Текущий список плагинов:"
@($check.plugin) | ForEach-Object { Write-Host "  - $_" }
Write-Host ""
Write-Host "Чтобы плагин заработал, MultiTool нужно перезапустить." -ForegroundColor Yellow
