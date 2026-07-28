$ErrorActionPreference = "Stop"

$projectRoot = (Get-Location).Path

function Find-PythonExecutable {
  if ($env:PYTHON_EXECUTABLE -and (Test-Path -LiteralPath $env:PYTHON_EXECUTABLE)) {
    return $env:PYTHON_EXECUTABLE
  }

  foreach ($commandName in @("python", "python3")) {
    $command = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($command) {
      & $command.Source -c "import sys; print(sys.executable)" *> $null
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
$ytDlpRoot = Join-Path $projectRoot ".local-tools\yt-dlp"
$whisperRoot = Join-Path $projectRoot ".local-tools\whisper"

$null = New-Item -ItemType Directory -Force -Path $ytDlpRoot
$null = New-Item -ItemType Directory -Force -Path $whisperRoot

Write-Host ""
Write-Host "正在安装本地视频读取组件…" -ForegroundColor Yellow
& $pythonExecutable -m pip install --disable-pip-version-check --upgrade --target $ytDlpRoot yt-dlp
if ($LASTEXITCODE -ne 0) {
  throw "yt-dlp 安装失败。请确认网络可用，并检查 Python 的 pip 是否正常。"
}

Write-Host ""
Write-Host "正在安装本地 Whisper 组件…" -ForegroundColor Yellow
& $pythonExecutable -m pip install --disable-pip-version-check --upgrade --target $whisperRoot faster-whisper numpy
if ($LASTEXITCODE -ne 0) {
  throw "faster-whisper 安装失败。请确认网络可用，并检查 Python 的 pip 是否正常。"
}

Write-Host ""
Write-Host "本地组件安装完成。首次转写时会自动下载所选 Whisper 模型。" -ForegroundColor Green
