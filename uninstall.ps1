# ============================================================================
#  Telegram MCP Starter — полное удаление (Windows)
#
#  Запуск (PowerShell):
#    irm https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/uninstall.ps1 | iex
#
#  Удаляет: сервер, ключи, сессию, записи в конфигах Claude Code и Claude Desktop.
#  ВАЖНО: после удаления зайдите в Telegram -> Настройки -> Устройства
#  и завершите сессию «MCP Telegram», если она там осталась.
#  Совместим с Windows PowerShell 5.1 и PowerShell 7+.
# ============================================================================

function Uninstall-TelegramMcp {

$ErrorActionPreference = "Stop"

$BaseDir  = Join-Path $env:USERPROFILE ".telegram-mcp"
$MergerJs = Join-Path $BaseDir "server\merge-config.mjs"

$answer = Read-Host "Удалить Telegram MCP полностью (папка $BaseDir и записи в конфигах)? [y/n]"
if ($answer -notmatch '^[YyДд]') { Write-Host "Отменено."; return }

# 0. Фоновый сервис (если настраивался)
try { Stop-ScheduledTask -TaskName "TelegramMcpDaemon" -ErrorAction SilentlyContinue } catch { }
try { Unregister-ScheduledTask -TaskName "TelegramMcpDaemon" -Confirm:$false -ErrorAction SilentlyContinue } catch { }
$LockFile = Join-Path $BaseDir "daemon.lock"
if (Test-Path $LockFile) {
    $pidText = (Get-Content $LockFile -TotalCount 1 -ErrorAction SilentlyContinue)
    if ($pidText -match '^\d+$') {
        try { Stop-Process -Id ([int]$pidText) -Force -ErrorAction Stop } catch { }
    }
}
Write-Host "[OK] Фоновый сервис остановлен и удалён (если был)"

# 1. Claude Code
if (Get-Command claude -ErrorAction SilentlyContinue) {
    # try/catch + временный EAP: в PS 5.1 перенаправление stderr нативной команды
    # при $ErrorActionPreference='Stop' иначе роняет скрипт (NativeCommandError)
    try {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & claude mcp remove telegram -s user 2>$null | Out-Null
    } catch { } finally { $ErrorActionPreference = $eap }
    Write-Host "[OK] Удалён из Claude Code (если был подключён)"
}

# 2. Claude Desktop (с резервной копией)
$DesktopCfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ((Test-Path $DesktopCfg) -and (Test-Path $MergerJs) -and $NodeCmd) {
    & $NodeCmd.Source $MergerJs $DesktopCfg --remove
}

# 3. Файлы
if (Test-Path $BaseDir) {
    Remove-Item -Recurse -Force $BaseDir
    Write-Host "[OK] Удалена папка $BaseDir (сервер, ключи, сессия)"
}

Write-Host ""
Write-Host "Готово. Последний шаг — сделайте вручную на телефоне:"
Write-Host "  Telegram -> Настройки -> Устройства -> завершите сессию «MCP Telegram» (если есть)."
Write-Host "Ключи api_id/api_hash на https://my.telegram.org удалять не обязательно."

}

Uninstall-TelegramMcp
