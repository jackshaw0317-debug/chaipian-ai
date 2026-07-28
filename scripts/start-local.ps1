$ErrorActionPreference = "Stop"

$projectRoot = (Get-Location).Path

function Find-PythonExecutable {
  if ($env:PYTHON_EXECUTABLE -and (Test-Path -LiteralPath $env:PYTHON_EXECUTABLE)) {
    return $env:PYTHON_EXECUTABLE
  }

  foreach ($commandName in @("python", "python3")) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($command) {
      & $command.Source -c "import sys" *> $null
      if ($LASTEXITCODE -eq 0) {
        return $command.Source
      }
    }
  }

  if ($env:USERPROFILE) {
    $codexPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $codexPython) {
      return $codexPython
    }
  }

  throw "未找到可用的 Python 3。请先安装 Python 3.10 或更高版本，或设置 PYTHON_EXECUTABLE。"
}

$pythonExecutable = Find-PythonExecutable
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  throw "未找到 npm。请先安装 Node.js 22.13 或更高版本。"
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  Write-Host ""
  Write-Host "首次运行需要安装网页依赖…" -ForegroundColor Yellow
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    throw "网页依赖安装失败。请确认网络可用后重试。"
  }
}

$toolRoot = Join-Path $projectRoot ".local-tools\yt-dlp"
$whisperRoot = Join-Path $projectRoot ".local-tools\whisper"

if (
  -not (Test-Path -LiteralPath (Join-Path $toolRoot "yt_dlp")) -or
  -not (Test-Path -LiteralPath (Join-Path $whisperRoot "faster_whisper"))
) {
  Write-Host ""
  Write-Host "首次运行需要安装本地视频读取与 Whisper 组件。" -ForegroundColor Yellow
  & ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 "scripts/setup-local.ps1")))
}

function Test-LocalUrl([string]$url) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Wait-LocalUrl([string]$url, [int]$timeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalUrl $url) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$logRoot = Join-Path $projectRoot "work"
if (-not (Test-Path -LiteralPath $logRoot)) {
  $null = New-Item -ItemType Directory -Path $logRoot
}

$downloader = $null
if (-not (Test-LocalUrl "http://127.0.0.1:4317/health")) {
  $env:PYTHON_EXECUTABLE = $pythonExecutable
  $downloader = Start-Process `
    -FilePath "node" `
    -ArgumentList @("scripts/local-downloader.mjs") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "local-downloader.log") `
    -RedirectStandardError (Join-Path $logRoot "local-downloader-error.log") `
    -PassThru
  if (-not (Wait-LocalUrl "http://127.0.0.1:4317/health" 20)) {
    throw "本地视频下载服务启动失败，请把 work\local-downloader-error.log 交给 Codex 检查。"
  }
}

$transcriber = $null
if (-not (Test-LocalUrl "http://127.0.0.1:4318/health")) {
  $env:PYTHON_EXECUTABLE = $pythonExecutable
  $transcriber = Start-Process `
    -FilePath $pythonExecutable `
    -ArgumentList @("scripts/local-transcriber.py") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logRoot "local-whisper.log") `
    -RedirectStandardError (Join-Path $logRoot "local-whisper-error.log") `
    -PassThru
  if (-not (Wait-LocalUrl "http://127.0.0.1:4318/health" 45)) {
    throw "本机 Whisper 启动失败，请把 work\local-whisper-error.log 交给 Codex 检查。"
  }
}

if (Test-LocalUrl "http://127.0.0.1:3000/") {
  Write-Host ""
  Write-Host "拆片 AI 已经在运行，本机服务也已就绪：" -ForegroundColor Green
  Write-Host "http://localhost:3000/" -ForegroundColor Cyan
  Write-Host ""
  exit 0
}

try {
  Set-Location $projectRoot
  Write-Host ""
  Write-Host "正在准备长期稳定版本，首次启动需要稍等片刻…" -ForegroundColor Yellow
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "页面准备失败，请保持窗口打开并交给 Codex 检查。"
  }

  Write-Host ""
  Write-Host "拆片 AI 已启动：" -ForegroundColor Green
  Write-Host "http://localhost:3000/" -ForegroundColor Cyan
  Write-Host "关闭此窗口即可停止服务。" -ForegroundColor DarkGray
  Write-Host ""
  & npm.cmd run start
} finally {
  if ($downloader -and -not $downloader.HasExited) {
    Stop-Process -Id $downloader.Id -Force -ErrorAction SilentlyContinue
  }
  if ($transcriber -and -not $transcriber.HasExited) {
    Stop-Process -Id $transcriber.Id -Force -ErrorAction SilentlyContinue
  }
}
