# ============================================================================
#  Telegram MCP — постоянный фоновый сервис (Windows, Планировщик заданий)
#
#  Зачем: когда с одним Telegram-аккаунтом работают НЕСКОЛЬКО AI-агентов
#  одновременно (Claude Code + Claude Desktop + Codex + Cursor...), соединение
#  с Telegram может держать только один процесс. Без сервиса владельцем
#  становится первый запустившийся агент — закроешь его, и Telegram отвалится
#  у всех остальных. Сервис же ВСЕГДА владеет соединением: агенты подключаются
#  к нему как клиенты, и закрытие любого из них ни на что не влияет.
#
#  Использование (PowerShell):
#    .\daemon-setup.ps1 install     установить и запустить (автостарт при входе)
#    .\daemon-setup.ps1 remove      остановить и удалить
#    .\daemon-setup.ps1 restart     перезапустить (после повторного входа в Telegram)
#    .\daemon-setup.ps1 status      показать состояние
#
#  Установщик install.ps1 кладёт копию этого скрипта в %USERPROFILE%\.telegram-mcp\.
# ============================================================================
param([string]$Cmd = "install")

$ErrorActionPreference = "Stop"

$TaskName = "TelegramMcpDaemon"
$BaseDir  = Join-Path $env:USERPROFILE ".telegram-mcp"
$RunCmd   = Join-Path $BaseDir "run.cmd"
$VbsPath  = Join-Path $BaseDir "daemon.vbs"
$LockFile = Join-Path $BaseDir "daemon.lock"

if (-not (Test-Path $RunCmd)) {
    Write-Host "[X] Нет $RunCmd — сначала запустите install.ps1" -ForegroundColor Red
    exit 1
}

function Stop-DaemonProcess {
    if (Test-Path $LockFile) {
        $pidText = (Get-Content $LockFile -TotalCount 1 -ErrorAction SilentlyContinue)
        if ($pidText -match '^\d+$') {
            try { Stop-Process -Id ([int]$pidText) -Force -ErrorAction Stop } catch { }
        }
    }
}

switch ($Cmd) {
    "install" {
        # VBS-обёртка запускает run.cmd serve без чёрного окна консоли
        $VbsContent = 'CreateObject("WScript.Shell").Run """__RUN_CMD__"" serve", 0, False'
        Set-Content -Path $VbsPath -Value $VbsContent.Replace("__RUN_CMD__", $RunCmd) -Encoding Ascii

        $action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
        $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Сервис установлен и запущен (автостарт при входе в систему)." -ForegroundColor Green
        Write-Host "     Проверка: .\daemon-setup.ps1 status"
    }
    "remove" {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
        Stop-DaemonProcess
        Remove-Item $VbsPath -ErrorAction SilentlyContinue
        Write-Host "[OK] Сервис остановлен и удалён" -ForegroundColor Green
    }
    "restart" {
        Stop-DaemonProcess
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Сервис перезапущен" -ForegroundColor Green
    }
    "status" {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if (-not $task) { Write-Host "Сервис не установлен"; exit 0 }
        Write-Host "Задание: $($task.TaskName), состояние: $($task.State)"
        if (Test-Path $LockFile) {
            $pidText = (Get-Content $LockFile -TotalCount 1 -ErrorAction SilentlyContinue)
            if ($pidText -match '^\d+$' -and (Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue)) {
                Write-Host "Владелец соединения: процесс PID $pidText — работает"
            } else {
                Write-Host "Процесс-владелец не найден (сервис мог ещё не стартовать)"
            }
        }
    }
    default {
        Write-Host "Использование: .\daemon-setup.ps1 [install|remove|restart|status]"
        exit 2
    }
}
