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
param(
    [switch]$RuntimeOnly,
    [string]$InstallRoot,
    [string]$SourceArchive,
    [string]$SourceCommit
)

function Install-TelegramMcp {

$ErrorActionPreference = "Stop"

$PkgName    = "@overpod/mcp-telegram"
$PkgVersion = "1.43.1"
$SourceVersion = "v2.0.0"
$SourceRepository = "alexfisenkov/telegram-mcp-starter"

$BaseDir    = if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } elseif ($env:TELEGRAM_MCP_INSTALL_ROOT) { [IO.Path]::GetFullPath($env:TELEGRAM_MCP_INSTALL_ROOT) } else { Join-Path $env:USERPROFILE ".telegram-mcp" }
if (($InstallRoot -or $env:TELEGRAM_MCP_INSTALL_ROOT) -and -not $RuntimeOnly) { Write-Host "[X] Пользовательский install root разрешён только вместе с -RuntimeOnly." -ForegroundColor Red; return }
if ($SourceArchive -or $SourceCommit) {
    if (-not $RuntimeOnly -or -not $InstallRoot -or -not $SourceArchive -or -not $SourceCommit) {
        Write-Host "[X] -SourceArchive и -SourceCommit разрешены только вместе с -RuntimeOnly, -InstallRoot и друг с другом." -ForegroundColor Red
        return
    }
    if ($SourceCommit -notmatch '^[a-fA-F0-9]{40}$' -or -not (Test-Path -LiteralPath $SourceArchive -PathType Leaf)) {
        Write-Host "[X] Для тестового источника нужен существующий архив и полный 40-символьный commit SHA." -ForegroundColor Red
        return
    }
    $SourceCommit = $SourceCommit.ToLowerInvariant()
}
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
Write-Host "Сервер: $PkgName@$PkgVersion  |  исходники $SourceVersion  |  установка в: $BaseDir"
Write-Host ""

# ---------- шаг 1: Node.js --------------------------------------------------
Write-Step "Шаг 1/7 · Проверяю Node.js"

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeBin = $null
if ($NodeCmd) {
    $NodeBin = $NodeCmd.Source
} else {
    if ($RuntimeOnly) {
        Write-Err "Режим -RuntimeOnly не устанавливает системные зависимости. Сначала установите Node.js 22+ и запустите команду повторно."
        throw "Node.js 22+ is required in runtime-only mode."
    }
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
if ($NodeMajor -lt 22) {
    Write-Err "Найден Node.js $NodeVersionRaw, а нужен 22 или новее. Обновите с https://nodejs.org"
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

# ---------- шаг 2: установка проверенного публичного runtime ------------------
Write-Step "Шаг 2/7 · Устанавливаю $PkgName@$PkgVersion и runtime $SourceVersion"

New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
$StageRoot = Join-Path $BaseDir (".telegram-mcp-stage-" + [Guid]::NewGuid().ToString("N"))
$StagedServer = Join-Path $StageRoot "server"
$BackupDir = $null
try {
    New-Item -ItemType Directory -Force -Path $StagedServer | Out-Null
    $ArchivePath = Join-Path $StageRoot "source.tar.gz"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not $SourceArchive) {
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$SourceRepository/commits/$SourceVersion" -Headers @{ "User-Agent" = "telegram-mcp-starter-installer" }
        $SourceCommit = [string]$Release.sha
        if ($SourceCommit -notmatch '^[a-fA-F0-9]{40}$') { throw "GitHub API не вернул полный commit SHA для $SourceVersion." }
        $SourceCommit = $SourceCommit.ToLowerInvariant()
        Invoke-WebRequest -Uri "https://github.com/$SourceRepository/archive/$SourceCommit.tar.gz" -OutFile $ArchivePath -UseBasicParsing
        $SourceArchive = $ArchivePath
    }
    $ExtractDir = Join-Path $StageRoot "extract"
    New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
    if ([IO.Path]::GetExtension($SourceArchive) -ieq ".zip") {
        Expand-Archive -LiteralPath $SourceArchive -DestinationPath $ExtractDir -Force
    } else {
        $TarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
        if (-not $TarCommand) { $TarCommand = Get-Command tar -ErrorAction SilentlyContinue }
        if (-not $TarCommand) { throw "Не найдена команда tar для распаковки закреплённого source archive." }
        & $TarCommand.Source -xzf $SourceArchive -C $ExtractDir
        if ($LASTEXITCODE -ne 0) { throw "Распаковка source archive завершилась с кодом $LASTEXITCODE." }
    }
    $ArchiveRoot = Get-ChildItem -LiteralPath $ExtractDir -Directory | Select-Object -First 1
    if (-not $ArchiveRoot) { throw "Архив $SourceVersion не содержит корневую папку." }
    Copy-Item -Path (Join-Path $ArchiveRoot.FullName "*") -Destination $StagedServer -Recurse -Force
    foreach ($RequiredFile in @("package.json", "package-lock.json", "runtime\manifest.json")) {
        if (-not (Test-Path (Join-Path $StagedServer $RequiredFile) -PathType Leaf)) {
            throw "Архив $SourceVersion неполный: отсутствует $RequiredFile."
        }
    }
    $SourcePackage = Get-Content (Join-Path $StagedServer "package.json") -Raw | ConvertFrom-Json
    if ($SourcePackage.version -ne "2.0.0") { throw "Ожидалась версия исходников 2.0.0, получена $($SourcePackage.version)." }
    if ($SourcePackage.overrides.telegram -ne "npm:teleproto@1.229.0") { throw "Исходники должны закреплять override telegram: npm:teleproto@1.229.0." }
    $LockReaderScript = @'
const fs = require("node:fs");
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({
  package: p.packages?.["node_modules/@overpod/mcp-telegram"]?.version,
  teleproto: p.packages?.["node_modules/@overpod/mcp-telegram/node_modules/telegram"]?.version,
  playwright: p.packages?.["node_modules/playwright"]?.version,
}));
'@
    $LockReaderPath = Join-Path $StageRoot "read-lockfile.cjs"
    Set-Content -LiteralPath $LockReaderPath -Value $LockReaderScript -Encoding Ascii
    $LockJson = & $NodeBin $LockReaderPath (Join-Path $StagedServer "package-lock.json")
    if ($LASTEXITCODE -ne 0) { throw "Не удалось прочитать закреплённые версии из package-lock.json." }
    $LockInfo = $LockJson | ConvertFrom-Json
    if ($LockInfo.package -ne $PkgVersion) { throw "Lockfile закрепляет $PkgName@$($LockInfo.package), ожидалась $PkgVersion." }
    if ($LockInfo.teleproto -ne "1.229.0") { throw "Lockfile не закрепляет teleproto@1.229.0 (получено $($LockInfo.teleproto))." }
    if ($LockInfo.playwright -ne "1.62.1") { throw "Lockfile не закрепляет Playwright@1.62.1 (получено $($LockInfo.playwright))." }

    Push-Location $StagedServer
    try { & $NpmBin ci --ignore-scripts --no-audit --no-fund --loglevel=error }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "npm ci завершился с кодом $LASTEXITCODE." }
    & $NodeBin (Join-Path $StagedServer "tools\apply-patches.mjs") --package-dir (Join-Path $StagedServer "node_modules\@overpod\mcp-telegram")
    if ($LASTEXITCODE -ne 0) { throw "Применение runtime patches завершилось с кодом $LASTEXITCODE." }
    & $NodeBin (Join-Path $StagedServer "tools\apply-patches.mjs") --package-dir (Join-Path $StagedServer "node_modules\@overpod\mcp-telegram") --check
    if ($LASTEXITCODE -ne 0) { throw "Проверка runtime manifest завершилась с кодом $LASTEXITCODE." }
    if (-not (Test-Path (Join-Path $StagedServer "node_modules\@overpod\mcp-telegram\dist\cli.js") -PathType Leaf)) { throw "Runtime CLI не найден после проверки." }
    Set-Content -LiteralPath (Join-Path $StagedServer "doctor.mjs") -Value 'import "./tools/doctor.mjs";' -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $StagedServer "merge-config.mjs") -Value 'import "./tools/merge-config.mjs";' -Encoding Ascii
    $Receipt = [ordered]@{ repository = $SourceRepository; version = $SourceVersion; commitSHA = $SourceCommit } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $StagedServer "runtime\source-receipt.json"), $Receipt + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

    if (Test-Path $ServerDir) {
        $BackupDir = Join-Path $BaseDir ("server.backup-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ"))
        if (Test-Path $BackupDir) { throw "Каталог резервной копии уже существует: $BackupDir" }
        Move-Item -LiteralPath $ServerDir -Destination $BackupDir
    }
    try {
        Move-Item -LiteralPath $StagedServer -Destination $ServerDir
    } catch {
        if ($BackupDir -and (Test-Path $BackupDir) -and -not (Test-Path $ServerDir)) { Move-Item -LiteralPath $BackupDir -Destination $ServerDir; $BackupDir = $null }
        throw
    }
    Write-Ok "Runtime $SourceVersion активирован: $ServerDir"
    if ($BackupDir) { Write-Ok "Предыдущая версия сохранена: $BackupDir" }
} catch {
    Write-Err "Не удалось подготовить runtime: $($_.Exception.Message)"
    throw "Public runtime installation failed."
} finally {
    if (Test-Path $StageRoot) { Remove-Item -LiteralPath $StageRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($RuntimeOnly) {
    Write-Ok "Runtime установлен. Режим -RuntimeOnly не запрашивал ключи, не входил в Telegram и не менял конфиги клиентов или службы."
    return
}

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
if not "%TELEGRAM_MCP_NO_AUTH%"=="1" for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do set "%%a=%%b"
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





$DaemonPs1 = Join-Path $BaseDir "daemon-setup.ps1"
Copy-Item -LiteralPath (Join-Path $ServerDir "tools\daemon-setup.ps1") -Destination $DaemonPs1 -Force

Write-Ok "Обёртка run.cmd создана; doctor, merge-config и daemon-setup взяты из закреплённого архива."

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
        throw "Telegram login did not complete."
    }
    Write-Ok "Вход выполнен, сессия сохранена: $SessionPath"

}

$ManagedDaemonTask = Get-ScheduledTask -TaskName "TelegramMcpDaemon" -ErrorAction SilentlyContinue
$ManagedDaemonExisting = [bool]$ManagedDaemonTask
if ($ManagedDaemonExisting) {
    try {
        & $DaemonPs1 restart
    } catch {
        Write-Err "Runtime обновлён, но новый owner службы не подтверждён: $($_.Exception.Message)"
        Write-Host "Не подключайте клиентов. Проверьте службу, остановите старые MCP-клиенты и повторите установку." -ForegroundColor Yellow
        throw "Managed Telegram MCP service restart failed."
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
if ($ManagedDaemonExisting) {
    Write-Ok "Управляемая служба уже настроена и перезапущена."
} elseif (Ask-YesNo "Настроить фоновый сервис сейчас?") {
    & $DaemonPs1 install
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Фоновый сервис установлен; подключение проверю в следующем шаге."
    } else {
        Write-Warn2 "Не удалось настроить сервис — см. docs/08-multi-agent.md"
    }
}

# ---------- шаг 7: проверка ---------------------------------------------------
Write-Step "Шаг 7/7 · Проверяю подключение (doctor)"

& $NodeBin $DoctorJs --status "cmd" "/c" $RunCmd
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Runtime, каталог инструментов и авторизованное подключение подтверждены."
} else {
    Write-Err "Runtime установлен, но подключение или каталог актуального owner не подтверждены. Закройте/перезапустите службу или MCP-клиенты и повторите проверку doctor --status."
    throw "Telegram MCP connection readiness was not verified."
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
