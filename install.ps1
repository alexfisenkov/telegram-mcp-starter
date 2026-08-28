# ============================================================================
#  Telegram MCP Starter — установщик для Windows (PowerShell)
#
#  Подключает ваш ЛИЧНЫЙ Telegram-аккаунт к Claude (Desktop / Code / Cursor)
#  через MCP-сервер @overpod/mcp-telegram (MIT, open source).
#
#  Запуск одной командой (PowerShell):
#    irm https://raw.githubusercontent.com/alexfisenkov/telegram-mcp-starter/main/install.ps1 | iex
#
#  Если Windows блокирует запуск скриптов, сначала выполните:
#    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#
#  Скрипт идемпотентный: можно запускать повторно, ничего не сломает.
#  Совместим с Windows PowerShell 5.1 и PowerShell 7+.
# ============================================================================

function Install-TelegramMcp {

$ErrorActionPreference = "Stop"

$PkgName    = "@overpod/mcp-telegram"
$PkgVersion = "1.41.6"

$BaseDir    = Join-Path $env:USERPROFILE ".telegram-mcp"
$ServerDir  = Join-Path $BaseDir "server"
$EnvFile    = Join-Path $BaseDir "telegram.env"
$SessionPath= Join-Path $BaseDir "session"
$RunCmd     = Join-Path $BaseDir "run.cmd"
$DoctorJs   = Join-Path $ServerDir "doctor.mjs"
$MergerJs   = Join-Path $ServerDir "merge-config.mjs"
$CliJs      = Join-Path $ServerDir "node_modules\@overpod\mcp-telegram\dist\cli.js"

function Write-Ok($msg)   { Write-Host "[OK] $msg"  -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "[X]  $msg"  -ForegroundColor Red }
function Write-Warn2($msg){ Write-Host "[!]  $msg"  -ForegroundColor Yellow }
function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

function Ask-YesNo($question) {
    while ($true) {
        $answer = Read-Host "$question [y/n]"
        if ($answer -match '^[YyДд]') { return $true }
        if ($answer -match '^[NnНн]') { return $false }
        Write-Host "Введите y (да) или n (нет)."
    }
}

function Read-Hidden($prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    return $plain
}

Write-Host ""
Write-Host "Telegram MCP Starter — подключаем ваш Telegram к Claude" -ForegroundColor White
Write-Host "Сервер: $PkgName@$PkgVersion  |  Установка в: $BaseDir"
Write-Host ""

# ---------- шаг 1: Node.js --------------------------------------------------
Write-Step "Шаг 1/7 · Проверяю Node.js"

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeBin = $null
if ($NodeCmd) {
    $NodeBin = $NodeCmd.Source
} else {
    Write-Warn2 "Node.js не найден — попробую установить автоматически."
    $WingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($WingetCmd -and (Ask-YesNo "Установить Node.js LTS автоматически через winget?")) {
        & winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
        # PATH текущего окна ещё не знает про node — берём по полному пути
        $Candidate = Join-Path $env:ProgramFiles "nodejs\node.exe"
        if (Test-Path $Candidate) {
            $NodeBin = $Candidate
            Write-Ok "Node.js установлен автоматически"
        }
    }
    if (-not $NodeBin) {
        Write-Err "Node.js так и не установлен."
        Write-Host ""
        Write-Host "Установите вручную и запустите скрипт ещё раз:"
        Write-Host "  • Вариант 1 (рекомендую): скачайте установщик с https://nodejs.org (кнопка LTS)"
        Write-Host "  • Вариант 2 (через winget): winget install OpenJS.NodeJS.LTS"
        Write-Host ""
        Write-Host "После ручной установки ЗАКРОЙТЕ и заново откройте PowerShell."
        return
    }
}
# ВАЖНО: парсим `node -v`, а не `node -p "..."` — в Windows PowerShell 5.1
# кавычки внутри аргументов нативных команд теряются.
$NodeVersionRaw = (& $NodeBin -v)
$NodeMajor = [int]($NodeVersionRaw.TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 18) {
    Write-Err "Найден Node.js $NodeVersionRaw, а нужен 18 или новее. Обновите с https://nodejs.org"
    return
}
Write-Ok "Node.js $NodeVersionRaw — подходит ($NodeBin)"

# npm ищем рядом с node (важно после автоустановки, пока PATH не обновился)
$NpmBin = Join-Path (Split-Path $NodeBin) "npm.cmd"
if (-not (Test-Path $NpmBin)) {
    $NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($NpmCmd) { $NpmBin = $NpmCmd.Source }
}
if (-not $NpmBin -or -not (Test-Path $NpmBin)) {
    Write-Err "npm не найден (обычно ставится вместе с Node.js). Переустановите Node.js с https://nodejs.org"
    return
}
Write-Ok "npm $(& $NpmBin -v)"

# ---------- шаг 2: установка сервера ----------------------------------------
Write-Step "Шаг 2/7 · Устанавливаю MCP-сервер $PkgName@$PkgVersion"

New-Item -ItemType Directory -Force -Path $ServerDir | Out-Null
$PkgJson = Join-Path $ServerDir "package.json"
if (-not (Test-Path $PkgJson)) {
    Set-Content -Path $PkgJson -Value "{`n  `"name`": `"telegram-mcp-local`",`n  `"private`": true`n}" -Encoding Ascii
}

Push-Location $ServerDir
try {
    & $NpmBin install "$PkgName@$PkgVersion" --no-fund --no-audit --loglevel=error
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $CliJs)) {
    Write-Err "Установка не удалась. Проверьте интернет и запустите скрипт снова. Подробности: docs/TROUBLESHOOTING.md"
    return
}
Write-Ok "Сервер установлен: $ServerDir"

# --- Windows: патча больше не нужно ------------------------------------------
# Раньше здесь накладывался свой патч: Node на Windows не умеет слушать unix-сокет
# по файловому пути (listen EACCES), и сервер падал при старте. В 1.41.5 автор
# пакета починил это сам — dist/lock.js переводит IPC на именованный канал
# \\.\pipe\mcp-telegram-<папка сессии>. Наш патч искал старый код socketPath(),
# которого больше нет, и на свежей версии просто падал бы с ошибкой.

# ---------- шаг 3: api_id / api_hash ----------------------------------------
Write-Step "Шаг 3/7 · Ключи Telegram API (api_id / api_hash)"

Write-Host "Ключи берутся на https://my.telegram.org -> API development tools."
Write-Host "Подробная инструкция: docs/01-api-keys.md в репозитории."
Write-Host "Ключи сохраняются ТОЛЬКО на этом компьютере: $EnvFile"
Write-Host ""

$ApiId = $null
$ApiHash = $null
$WriteEnv = $true
if (Test-Path $EnvFile) {
    Write-Ok "Файл с ключами уже существует: $EnvFile"
    if (Ask-YesNo "Оставить текущие ключи?") { $WriteEnv = $false }
}

if ($WriteEnv) {
    while ($true) {
        $ApiId = Read-Host "TELEGRAM_API_ID (только цифры)"
        if ($ApiId -match '^\d+$') { break }
        Write-Warn2 "api_id — это число, например 1234567. Попробуйте ещё раз."
    }
    while ($true) {
        $ApiHash = Read-Hidden "TELEGRAM_API_HASH (32 символа, ввод скрыт)"
        if ($ApiHash -match '^[a-fA-F0-9]{32}$') { break }
        Write-Warn2 "api_hash — 32 шестнадцатеричных символа (буквы a-f и цифры). Попробуйте ещё раз."
    }

    # В файле только ASCII-значения (цифры и hex) — путь к сессии сюда НЕ пишем,
    # чтобы кириллические имена профилей Windows не ломали кодировку.
    $EnvContent = "TELEGRAM_API_ID=$ApiId`r`nTELEGRAM_API_HASH=$ApiHash"
    Set-Content -Path $EnvFile -Value $EnvContent -Encoding Ascii

    # Ограничиваем доступ к файлу только текущим пользователем (аналог chmod 600)
    try {
        icacls $EnvFile /inheritance:r /grant:r "${env:USERNAME}:(R,W)" | Out-Null
        Write-Ok "Ключи сохранены, доступ ограничен: $EnvFile"
    } catch {
        Write-Ok "Ключи сохранены: $EnvFile"
        Write-Warn2 "Не удалось дополнительно ограничить права файла — это не критично."
    }
}

# ---------- служебные файлы (run.cmd, doctor.mjs, merge-config.mjs) ---------
# run.cmd держим в чистом ASCII (комментарии латиницей): cmd читает файлы в
# OEM-кодировке, кириллица здесь превратилась бы в мусор.
$RunCmdContent = @'
@echo off
rem Telegram MCP launcher. Secrets live in telegram.env, not in client configs.
setlocal
set "ENV_FILE=%USERPROFILE%\.telegram-mcp\telegram.env"
if not exist "%ENV_FILE%" (
  echo telegram-mcp: missing %ENV_FILE% - run install.ps1 again 1>&2
  exit /b 78
)
for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do set "%%a=%%b"
if "%TELEGRAM_SESSION_PATH%"=="" set "TELEGRAM_SESSION_PATH=%USERPROFILE%\.telegram-mcp\session"
"__NODE_BIN__" "%USERPROFILE%\.telegram-mcp\server\node_modules\@overpod\mcp-telegram\dist\cli.js" %*
'@
# Если путь к node содержит не-ASCII символы (например, nvm в профиле с русским
# именем) — не зашиваем его, а полагаемся на PATH.
if ($NodeBin -match '^[\x20-\x7E]+$') {
    $RunCmdContent = $RunCmdContent.Replace("__NODE_BIN__", $NodeBin)
} else {
    $RunCmdContent = $RunCmdContent.Replace("`"__NODE_BIN__`"", "node")
    Write-Warn2 "Путь к node.exe содержит не-латинские символы — run.cmd будет искать node через PATH."
}
Set-Content -Path $RunCmd -Value $RunCmdContent -Encoding Ascii

$DoctorContent = @'
#!/usr/bin/env node
// Доктор: подключается к Telegram MCP как настоящий клиент и вызывает telegram-status.
// Использование: node doctor.mjs <команда-сервера> [аргументы...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Использование: node doctor.mjs <команда-сервера> [аргументы...]");
  process.exit(2);
}

const transport = new StdioClientTransport({ command, args, env: { ...process.env } });
const client = new Client({ name: "telegram-mcp-doctor", version: "1.0.0" });
const timer = setTimeout(() => {
  console.error("[X] Сервер не ответил за 90 секунд. Проверьте интернет и docs/TROUBLESHOOTING.md");
  process.exit(1);
}, 90000);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`[OK] MCP-сервер запустился, инструментов доступно: ${tools.tools.length}`);
  const status = await client.callTool({ name: "telegram-status", arguments: {} });
  const text = (status.content ?? []).map((i) => i.text ?? "").join("\n").trim();
  console.log(text);
  if (status.isError) {
    console.error("[!] Инструмент telegram-status вернул ошибку — см. текст выше.");
    process.exitCode = 1;
  }
  if (/not\s+(logged|connected|authorized)/i.test(text)) {
    console.error("[!] Похоже, вы ещё не вошли в аккаунт — выполните вход по QR-коду (login).");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[X] Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await client.close().catch(() => {});
}
'@
Set-Content -Path $DoctorJs -Value $DoctorContent -Encoding UTF8

$MergerContent = @'
#!/usr/bin/env node
// Безопасно добавляет (или удаляет) сервер "telegram" в JSON-конфиг MCP-клиента.
// Перед изменением делает резервную копию рядом с конфигом.
// Использование:
//   node merge-config.mjs <config.json> <command> [args...]   — добавить/обновить
//   node merge-config.mjs <config.json> --remove              — удалить
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const [configPath, command, ...args] = process.argv.slice(2);
if (!configPath || !command) {
  console.error("Использование: node merge-config.mjs <config.json> <command|--remove> [args...]");
  process.exit(2);
}

let config = {};
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(configPath, `${configPath}.backup-${stamp}`);
  if (raw.trim() !== "") {
    try {
      config = JSON.parse(raw);
    } catch {
      console.error(`[X] Файл повреждён (невалидный JSON): ${configPath}. Исправьте его вручную.`);
      process.exit(1);
    }
  }
} else {
  mkdirSync(dirname(configPath), { recursive: true });
}

config.mcpServers = config.mcpServers ?? {};
if (command === "--remove") {
  delete config.mcpServers.telegram;
  console.log(`[OK] Сервер "telegram" удалён из ${configPath}`);
} else {
  config.mcpServers.telegram = args.length > 0 ? { command, args } : { command };
  console.log(`[OK] Сервер "telegram" добавлен в ${configPath}`);
}
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
'@
Set-Content -Path $MergerJs -Value $MergerContent -Encoding UTF8

$DaemonPs1 = Join-Path $BaseDir "daemon-setup.ps1"
$DaemonContent = @'
# Telegram MCP — постоянный фоновый сервис (Windows, Планировщик заданий).
# Нужен, когда с одним аккаунтом работают несколько AI-агентов одновременно:
# сервис всегда владеет соединением, агенты подключаются к нему как клиенты,
# и закрытие любого агента не отключает Telegram у остальных.
# Использование: .\daemon-setup.ps1 [install|remove|restart|status]
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
        $VbsContent = 'CreateObject("WScript.Shell").Run """__RUN_CMD__"" serve", 0, False'
        Set-Content -Path $VbsPath -Value $VbsContent.Replace("__RUN_CMD__", $RunCmd) -Encoding Ascii

        $action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
        $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "[OK] Сервис установлен и запущен (автостарт при входе в систему)." -ForegroundColor Green
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
'@
Set-Content -Path $DaemonPs1 -Value $DaemonContent -Encoding UTF8

Write-Ok "Служебные скрипты записаны (run.cmd, doctor.mjs, merge-config.mjs, daemon-setup.ps1)"

# ---------- шаг 4: вход по QR-коду ------------------------------------------
Write-Step "Шаг 4/7 · Вход в Telegram по QR-коду"

$DoLogin = $true
if (Test-Path $SessionPath) {
    Write-Ok "Файл сессии уже существует — вероятно, вы уже входили."
    if (-not (Ask-YesNo "Войти заново? (обычно НЕ нужно)")) { $DoLogin = $false }
}

if ($DoLogin) {
    Write-Host ""
    if (Ask-YesNo "Включён ли у вас облачный пароль (2FA) в Telegram? (Настройки -> Конфиденциальность -> Облачный пароль)") {
        $env:TELEGRAM_2FA_PASSWORD = Read-Hidden "Введите облачный пароль (ввод скрыт, нигде не сохраняется)"
    }
    Write-Host ""
    Write-Host "Сейчас в окне появится QR-код. На телефоне откройте Telegram:"
    Write-Host "  Настройки -> Устройства -> Подключить устройство — и отсканируйте код."
    Write-Host ""
    Write-Host "Если QR-код выглядит «поехавшим» — разверните окно на весь экран"
    Write-Host "или уменьшите шрифт (Ctrl + колесо мыши), код перерисуется."
    Write-Host ""

    # Ключи — из введённых значений или из файла (значения ASCII, читается безопасно)
    if (-not $ApiId) {
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^TELEGRAM_API_ID=(.*)$')   { $ApiId   = $Matches[1].Trim() }
            if ($_ -match '^TELEGRAM_API_HASH=(.*)$') { $ApiHash = $Matches[1].Trim() }
        }
    }
    $env:TELEGRAM_API_ID = $ApiId
    $env:TELEGRAM_API_HASH = $ApiHash
    # Путь к сессии задаём напрямую (НЕ через файл — там могла бы пострадать кириллица)
    $env:TELEGRAM_SESSION_PATH = $SessionPath

    & $NodeBin $CliJs login
    $LoginExit = $LASTEXITCODE
    Remove-Item Env:TELEGRAM_2FA_PASSWORD -ErrorAction SilentlyContinue
    if ($LoginExit -ne 0) {
        Write-Err "Вход не удался. Посмотрите docs/TROUBLESHOOTING.md и запустите установщик снова."
        return
    }
    Write-Ok "Вход выполнен, сессия сохранена: $SessionPath"

    # Если фоновый сервис уже настроен — перезапускаем, чтобы он подхватил новую сессию
    if (Get-ScheduledTask -TaskName "TelegramMcpDaemon" -ErrorAction SilentlyContinue) {
        & $DaemonPs1 restart
        Write-Ok "Фоновый сервис перезапущен с новой сессией"
    }
}

# ---------- шаг 5: подключение к клиентам -----------------------------------
Write-Step "Шаг 5/7 · Подключаю к Claude"

# Claude Code (CLI)
$ClaudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($ClaudeCmd) {
    if (Ask-YesNo "Найден Claude Code. Подключить Telegram к Claude Code?") {
        # try/catch + временный EAP: в PS 5.1 перенаправление stderr нативной команды
        # при $ErrorActionPreference='Stop' иначе роняет скрипт (NativeCommandError)
        try {
            $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
            & claude mcp remove telegram -s user 2>$null | Out-Null
        } catch { } finally { $ErrorActionPreference = $eap }
        & claude mcp add telegram -s user -- cmd /c $RunCmd
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Готово. Проверка внутри Claude Code: наберите /mcp"
        } else {
            Write-Warn2 "Не удалось подключить автоматически — см. docs/06-claude-code.md"
        }
    }
} else {
    Write-Warn2 "Claude Code (команда claude) не найден — пропускаю. Инструкция: docs/06-claude-code.md"
}

# Claude Desktop
$DesktopCfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if ((Test-Path (Split-Path $DesktopCfg)) -or (Test-Path $DesktopCfg)) {
    if (Ask-YesNo "Найден Claude Desktop. Добавить Telegram в его конфиг (с резервной копией)?") {
        & $NodeBin $MergerJs $DesktopCfg "cmd" "/c" $RunCmd
        if ($LASTEXITCODE -eq 0) {
            Write-Warn2 "Полностью перезапустите Claude Desktop (выйти через значок в трее и открыть заново)."
        } else {
            Write-Warn2 "Не удалось изменить конфиг автоматически — настройте вручную по docs/05-claude-desktop.md"
        }
    }
} else {
    Write-Warn2 "Claude Desktop не найден — пропускаю. Инструкция: docs/05-claude-desktop.md"
}

# ---------- шаг 6: несколько агентов (опционально) ---------------------------
Write-Step "Шаг 6/7 · Несколько AI-агентов одновременно (опционально)"

Write-Host "Если вы работаете с НЕСКОЛЬКИМИ AI-агентами сразу (Claude Code + Claude"
Write-Host "Desktop + Codex + Cursor...), рекомендуется фоновый сервис: он постоянно"
Write-Host "владеет соединением с Telegram, агенты подключаются к нему как клиенты,"
Write-Host "и закрытие любого агента не отключает Telegram у остальных."
Write-Host "Настроить можно и позже: powershell $DaemonPs1 install"
Write-Host ""
if (Ask-YesNo "Настроить фоновый сервис сейчас?") {
    & $DaemonPs1 install
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Фоновый сервис работает (подробнее: docs/08-multi-agent.md)"
    } else {
        Write-Warn2 "Не удалось настроить сервис — см. docs/08-multi-agent.md"
    }
}

# ---------- шаг 7: проверка ---------------------------------------------------
Write-Step "Шаг 7/7 · Проверяю подключение (doctor)"

& $NodeBin $DoctorJs "cmd" "/c" $RunCmd
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Всё работает!"
} else {
    Write-Warn2 "Проверка не прошла. Загляните в docs/TROUBLESHOOTING.md — там разобраны типовые ошибки."
}

# ---------- итог --------------------------------------------------------------
Write-Host ""
Write-Host "================= ГОТОВО =================" -ForegroundColor Green
Write-Host ""
Write-Host "Что установлено:"
Write-Host "  • Сервер:    $ServerDir  ($PkgName@$PkgVersion)"
Write-Host "  • Ключи API: $EnvFile  (доступ только у вашего пользователя)"
Write-Host "  • Сессия:    $SessionPath"
Write-Host "  • Запуск:    $RunCmd"
Write-Host "  • Проверка:  node `"$DoctorJs`" cmd /c `"$RunCmd`""
Write-Host "  • Фоновый сервис (несколько агентов): powershell `"$DaemonPs1`" [install|remove|restart|status]"
Write-Host ""
Write-Host "Первые команды для Claude (просто напишите в чат):"
Write-Host "  • «Покажи мои непрочитанные сообщения в Telegram»"
Write-Host "  • «Найди в Telegram чат с <имя> и покажи последние 10 сообщений»"
Write-Host ""
Write-Host "Безопасность (обязательно прочитайте docs/SECURITY.md):" -ForegroundColor Yellow
Write-Host "  • Файлы telegram.env и session никому не передавайте —"
Write-Host "    это полный доступ к вашему аккаунту."
Write-Host "  • Проверить/отозвать сессию: Telegram -> Настройки -> Устройства."
Write-Host ""

}

Install-TelegramMcp
