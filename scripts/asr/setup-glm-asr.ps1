param(
  [string]$ProjectRoot,
  [string]$ConfigPath,
  [string]$Python = "python",
  [string]$ModelId = "zai-org/GLM-ASR-Nano-2512",
  [int]$ReadyTimeoutSeconds = 180,
  [switch]$SkipInstall,
  [switch]$SkipSmoke,
  [switch]$NoConfigUpdate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)
  Write-Host "[ASR setup] $Message"
}

function Invoke-Checked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )
  Write-Step ("Running: {0} {1}" -f $FilePath, ($Arguments -join " "))
  $previousLocation = Get-Location
  try {
    if ($WorkingDirectory) {
      Set-Location $WorkingDirectory
    }
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
    }
  } finally {
    Set-Location $previousLocation
  }
}

function Resolve-ProjectRoot {
  param([string]$InputRoot)
  if ($InputRoot) {
    return (Resolve-Path $InputRoot).Path
  }
  return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Test-CommandAvailable {
  param([string]$Command)
  $existing = Get-Command $Command -ErrorAction SilentlyContinue
  return $null -ne $existing
}

function ConvertTo-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

function ConvertTo-YamlSingleQuotedScalar {
  param([string]$Value)
  return "'" + ($Value -replace "'", "''") + "'"
}

function Get-AsrSubBlock {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [int]$Start,
    [int]$End,
    [string]$Key
  )
  for ($index = $Start + 1; $index -lt $End; $index++) {
    if ($Lines[$index] -match ("^  " + [regex]::Escape($Key) + ":\s*")) {
      $block = [System.Collections.Generic.List[string]]::new()
      $block.Add($Lines[$index])
      $cursor = $index + 1
      while ($cursor -lt $End) {
        $line = $Lines[$cursor]
        if ($line -match "^  \S" -or $line -notmatch "^\s") {
          break
        }
        $block.Add($line)
        $cursor++
      }
      return $block.ToArray()
    }
  }
  return @()
}

function Update-AsrConfig {
  param(
    [string]$TargetConfigPath,
    [string]$TargetModelId
  )
  $quotedModelId = ConvertTo-YamlSingleQuotedScalar $TargetModelId
  $customCwd = @()
  $customEnv = @()
  $block = [System.Collections.Generic.List[string]]::new()
  $baseBlock = @(
    "asr:",
    "  enabled: true",
    "  provider: local-process",
    "  command: .\.venv-asr\Scripts\python.exe",
    "  args:",
    "    - scripts/asr/glm-asr-transformers-worker.py",
    "    - --model",
    "    - ""{modelId}""",
    "  modelId: $quotedModelId"
  )
  foreach ($line in $baseBlock) {
    $block.Add($line)
  }

  $tailBlock = @(
    "  timeoutMs: 120000",
    "  startupTimeoutMs: 180000",
    "  restartBackoffMs: 3000",
    "  maxConcurrent: 1",
    "  maxQueueSize: 4",
    "  maxAudioBytes: 26214400",
    "  maxOutputBytes: 1048576",
    "  resultFormat: json"
  )

  if (!(Test-Path $TargetConfigPath)) {
    foreach ($line in $tailBlock) {
      $block.Add($line)
    }
    [System.IO.File]::WriteAllLines($TargetConfigPath, $block, [System.Text.UTF8Encoding]::new($false))
    return
  }

  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.AddRange([System.IO.File]::ReadAllLines($TargetConfigPath))
  $start = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match "^asr:\s*(#.*)?$") {
      $start = $index
      break
    }
  }

  if ($start -lt 0) {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim().Length -gt 0) {
      $lines.Add("")
    }
    foreach ($line in $tailBlock) {
      $block.Add($line)
    }
    foreach ($line in $block) {
      $lines.Add($line)
    }
  } else {
    $end = $start + 1
    while ($end -lt $lines.Count) {
      $line = $lines[$end]
      if ($line.Trim().Length -eq 0) {
        $end++
        continue
      }
      if ($line -notmatch "^\s" -and $line -notmatch "^#") {
        break
      }
      $end++
    }
    $customCwd = Get-AsrSubBlock -Lines $lines -Start $start -End $end -Key "cwd"
    $customEnv = Get-AsrSubBlock -Lines $lines -Start $start -End $end -Key "env"
    foreach ($line in $customCwd) {
      $block.Add($line)
    }
    foreach ($line in $customEnv) {
      $block.Add($line)
    }
    foreach ($line in $tailBlock) {
      $block.Add($line)
    }
    $replacement = [System.Collections.Generic.List[string]]::new()
    for ($index = 0; $index -lt $start; $index++) {
      $replacement.Add($lines[$index])
    }
    foreach ($line in $block) {
      $replacement.Add($line)
    }
    for ($index = $end; $index -lt $lines.Count; $index++) {
      $replacement.Add($lines[$index])
    }
    $lines = $replacement
  }

  [System.IO.File]::WriteAllLines($TargetConfigPath, $lines, [System.Text.UTF8Encoding]::new($false))
}

function Test-AsrWorkerReady {
  param(
    [string]$VenvPython,
    [string]$Root,
    [string]$TargetModelId,
    [int]$TimeoutSeconds
  )
  $worker = Join-Path $Root "scripts/asr/glm-asr-transformers-worker.py"
  if (!(Test-Path $worker)) {
    throw "ASR worker script not found: $worker"
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo.FileName = $VenvPython
  $process.StartInfo.Arguments = @(
    ConvertTo-ProcessArgument $worker,
    "--model",
    ConvertTo-ProcessArgument $TargetModelId
  ) -join " "
  $process.StartInfo.WorkingDirectory = $Root
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardInput = $true
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $outputLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
  $errorLines = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
  $process.add_OutputDataReceived({ if ($EventArgs.Data) { $outputLines.Enqueue($EventArgs.Data) } })
  $process.add_ErrorDataReceived({ if ($EventArgs.Data) { $errorLines.Enqueue($EventArgs.Data) } })

  Write-Step "Starting ASR worker smoke test. This may download/load the model on first run."
  [void]$process.Start()
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  try {
    while ((Get-Date) -lt $deadline) {
      $line = $null
      while ($outputLines.TryDequeue([ref]$line)) {
        if ($line -match '"type"\s*:\s*"ready"') {
          Write-Step "ASR worker reported ready."
          return
        }
        Write-Host $line
      }
      if ($process.HasExited) {
        $errors = $errorLines.ToArray() -join [Environment]::NewLine
        throw "ASR worker exited before ready with code $($process.ExitCode). $errors"
      }
      Start-Sleep -Milliseconds 250
    }
    $stderr = $errorLines.ToArray() -join [Environment]::NewLine
    throw "ASR worker did not report ready within $TimeoutSeconds seconds. $stderr"
  } finally {
    if (!$process.HasExited) {
      $process.Kill()
      $process.WaitForExit(5000) | Out-Null
    }
    $process.Dispose()
  }
}

$root = Resolve-ProjectRoot $ProjectRoot
$config = if ($ConfigPath) { $ConfigPath } else { Join-Path $root "config.yaml" }
$config = [System.IO.Path]::GetFullPath($config)
$venvDir = Join-Path $root ".venv-asr"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

Write-Step "Project root: $root"
Write-Step "Config path: $config"

if (!(Test-Path $venvPython)) {
  if (!(Test-CommandAvailable $Python)) {
    throw "Python command not found: $Python"
  }
  Invoke-Checked -FilePath $Python -Arguments @("-m", "venv", $venvDir) -WorkingDirectory $root
}

if (!(Test-Path $venvPython)) {
  throw "Python virtual environment was not created: $venvPython"
}

if (!$SkipInstall) {
  Invoke-Checked -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel") -WorkingDirectory $root
  Invoke-Checked -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cpu") -WorkingDirectory $root
  Invoke-Checked -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "transformers", "accelerate", "soundfile", "librosa", "scipy", "numpy") -WorkingDirectory $root
} else {
  Write-Step "Skipping Python dependency installation."
}

if (!(Test-CommandAvailable "ffmpeg")) {
  Write-Warning "ffmpeg was not found in PATH. WAV input can still work, but some audio formats may fail."
}

if (!$NoConfigUpdate) {
  Update-AsrConfig -TargetConfigPath $config -TargetModelId $ModelId
  Write-Step "Updated ASR config."
} else {
  Write-Step "Skipping config update."
}

if (!$SkipSmoke) {
  Test-AsrWorkerReady -VenvPython $venvPython -Root $root -TargetModelId $ModelId -TimeoutSeconds $ReadyTimeoutSeconds
} else {
  Write-Step "Skipping worker smoke test."
}

Write-Step "ASR setup completed."
