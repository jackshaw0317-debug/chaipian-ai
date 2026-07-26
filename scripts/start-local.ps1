$ErrorActionPreference = "Stop"

$projectRoot = (Get-Location).Path
$bundledPython = "C:\Users\jacks\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$pythonExecutable = if ($env:PYTHON_EXECUTABLE -and (Test-Path -LiteralPath $env:PYTHON_EXECUTABLE)) {
  $env:PYTHON_EXECUTABLE
} elseif (Test-Path -LiteralPath $bundledPython) {
  $bundledPython
} elseif ($pythonCommand) {
  $pythonCommand.Source
} else {
  throw "未找到可用的 Python。"
}

$toolRoot = Join-Path $projectRoot ".local-tools\yt-dlp"
if (-not (Test-Path -LiteralPath (Join-Path $toolRoot "yt_dlp"))) {
  throw "本地下载组件尚未安装，请先在 Codex 中完成初始化。"
}

$whisperRoot = Join-Path $projectRoot ".local-tools\whisper"
if (-not (Test-Path -LiteralPath (Join-Path $whisperRoot "faster_whisper"))) {
  throw "本地 Whisper 组件尚未安装，请先在 Codex 中完成初始化。"
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
