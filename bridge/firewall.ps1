$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:TEMP "gigatool"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "firewall.log"
function Log($m) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m; Add-Content -LiteralPath $log -Value $line }

try {
  foreach ($rule in @(
      @{ Name = "MultiTool Mirror (TCP 8799)"; Protocol = "TCP"; Port = 8799 },
      @{ Name = "MultiTool Mirror (UDP 8798)"; Protocol = "UDP"; Port = 8798 }
    )) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) { Log ("правило уже есть: " + $rule.Name); continue }
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Action Allow `
      -Protocol $rule.Protocol -LocalPort $rule.Port -Profile Private | Out-Null
    Log ("добавлено: " + $rule.Name)
  }
  Log "ГОТОВО"
} catch {
  Log ("ОШИБКА: " + $_.Exception.Message)
}
