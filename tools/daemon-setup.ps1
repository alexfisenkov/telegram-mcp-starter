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
param(
    [string]$Cmd = "install",
    [string]$TestRunCommand,
    [string]$TestVbsPath
)

$ErrorActionPreference = "Stop"

$TaskName = "TelegramMcpDaemon"
$BaseDir  = Join-Path $env:USERPROFILE ".telegram-mcp"
$RunCmd   = Join-Path $BaseDir "run.cmd"
$CliJs    = Join-Path $BaseDir "server\node_modules\@overpod\mcp-telegram\dist\cli.js"
$VbsPath  = Join-Path $BaseDir "daemon.vbs"
$LockFile = Join-Path $BaseDir "daemon.lock"

function Write-DaemonVbs([string]$Path, [string]$RunCommand) {
    # Windows Script Host reads Unicode command paths only when the script has a UTF-16LE BOM.
    $content = 'CreateObject("WScript.Shell").Run """' + $RunCommand + '"" serve", 0, False'
    $encoding = [System.Text.UnicodeEncoding]::new($false, $true)
    [IO.File]::WriteAllText($Path, $content, $encoding)
}

if ($Cmd -eq "vbs-fixture") {
    if (-not $TestRunCommand -or -not $TestVbsPath) {
        throw "Использование test-only fixture: -Cmd vbs-fixture -TestRunCommand <путь> -TestVbsPath <путь>"
    }
    Write-DaemonVbs $TestVbsPath $TestRunCommand
    return
}

if (-not (Test-Path $RunCmd)) {
    Write-Host "[X] Нет $RunCmd — сначала запустите install.ps1" -ForegroundColor Red
    exit 1
}

function Read-DaemonOwnerPid {
    if (Test-Path $LockFile) {
        $pidText = (Get-Content $LockFile -TotalCount 1 -ErrorAction SilentlyContinue)
        if ($pidText -match '^\d+$') { return [int]$pidText }
    }
    return $null
}

function Stop-DaemonProcess([Nullable[int]]$OwnerPid) {
    $ownerPid = if ($null -ne $OwnerPid) { $OwnerPid.Value } else { Read-DaemonOwnerPid }
    if ($null -ne $ownerPid) {
            $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if (-not $ownerProcess) { return $ownerPid }
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
            if (-not $processInfo -or -not $processInfo.CommandLine -or
                $processInfo.CommandLine.IndexOf($CliJs, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw "daemon.lock указывает на PID $ownerPid, но путь процесса не совпадает с установленным Telegram MCP; процесс не остановлен."
            }
            Stop-Process -Id $ownerPid -Force -ErrorAction Stop
            try { Wait-Process -Id $ownerPid -Timeout 20 -ErrorAction Stop } catch { }
            if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) {
                throw "Старый Telegram MCP owner PID $ownerPid не завершился за 20 секунд."
            }
        return $ownerPid
    }
    return $null
}

function Wait-ForNewOwner([Nullable[int]]$OldOwnerPid) {
    for ($i = 0; $i -lt 120; $i += 1) {
        $pidText = if (Test-Path $LockFile) { (Get-Content $LockFile -TotalCount 1 -ErrorAction SilentlyContinue).Trim() } else { "" }
        if ($pidText -match '^\d+$') {
            $newPid = [int]$pidText
            $newProcess = Get-Process -Id $newPid -ErrorAction SilentlyContinue
            if ($newProcess -and (($null -eq $OldOwnerPid) -or ($newPid -ne $OldOwnerPid.Value))) {
                $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $newPid" -ErrorAction SilentlyContinue
                if ($processInfo -and $processInfo.CommandLine -and
                    $processInfo.CommandLine.IndexOf($CliJs, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    return $newPid
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw "После перезапуска службы не появился новый Telegram MCP owner. Проверьте telegram-mcp daemon.lock и перезапустите клиенты после устранения причины."
}

switch ($Cmd) {
    "install" {
        # VBS-обёртка запускает run.cmd serve без чёрного окна консоли
        Write-DaemonVbs $VbsPath $RunCmd

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
        $oldOwnerPid = Read-DaemonOwnerPid
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch { }
        if ($oldOwnerPid -and (Get-Process -Id $oldOwnerPid -ErrorAction SilentlyContinue)) {
            Stop-DaemonProcess $oldOwnerPid | Out-Null
        }
        if ($oldOwnerPid) {
            for ($i = 0; $i -lt 80 -and (Get-Process -Id $oldOwnerPid -ErrorAction SilentlyContinue); $i += 1) { Start-Sleep -Milliseconds 250 }
            if (Get-Process -Id $oldOwnerPid -ErrorAction SilentlyContinue) { throw "Старый owner PID $oldOwnerPid остаётся запущен; новый процесс не стартовал." }
        }
        Start-ScheduledTask -TaskName $TaskName
        $newOwnerPid = Wait-ForNewOwner $oldOwnerPid
        Write-Host "[OK] Служба перезапущена; новый owner PID $newOwnerPid подтверждён." -ForegroundColor Green
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
