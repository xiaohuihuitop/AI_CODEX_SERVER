param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ConfigDir = Join-Path $env:USERPROFILE '.codex-windows-bridge'
$ConfigPath = Join-Path $ConfigDir 'manager-config.json'
$AgentScriptPath = (Resolve-Path (Join-Path $ProjectRoot 'desktop-agent.js')).Path
$Script:AgentProcess = $null
$Script:LastLog = New-Object System.Collections.Generic.List[string]

function U {
  param([string]$Text)
  [regex]::Replace($Text, '\\u([0-9A-Fa-f]{4})', {
    param($Match)
    [string][char][Convert]::ToInt32($Match.Groups[1].Value, 16)
  })
}

function Add-Log {
  param([string]$Line)
  if (-not $Line) { return }
  $Script:LastLog.Add(("$(Get-Date -Format 'HH:mm:ss')  $Line"))
  while ($Script:LastLog.Count -gt 80) {
    $Script:LastLog.RemoveAt(0)
  }
}

function Get-DefaultConfig {
  $bytes = New-Object byte[] 24
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  @{
    serverUrl = ''
    token = "codex_$([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))"
    deviceName = $env:COMPUTERNAME
    autoStart = $false
  }
}

function Normalize-ServerUrl {
  param([string]$Value)
  if ($null -eq $Value) { return '' }
  $Value.Trim().TrimEnd('/')
}

function Read-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return Get-DefaultConfig }
  $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
  $json = $raw | ConvertFrom-Json
  @{
    serverUrl = Normalize-ServerUrl $json.serverUrl
    token = [string]$json.token
    deviceName = if ($json.deviceName) { [string]$json.deviceName } else { $env:COMPUTERNAME }
    autoStart = [bool]$json.autoStart
  }
}

function Save-Config {
  param([hashtable]$Config)
  if (-not (Test-Path -LiteralPath $ConfigDir)) {
    New-Item -ItemType Directory -Path $ConfigDir | Out-Null
  }
  $normalized = [ordered]@{
    serverUrl = Normalize-ServerUrl $Config.serverUrl
    token = ([string]$Config.token).Trim()
    deviceName = ([string]$Config.deviceName).Trim()
    autoStart = [bool]$Config.autoStart
  }
  $normalized | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
  Add-Log "$((U '\u914d\u7f6e\u5df2\u4fdd\u5b58\uff1a'))$ConfigPath"
}

function Get-ConfigFromForm {
  @{
    serverUrl = Normalize-ServerUrl $ServerUrlBox.Text
    token = $TokenBox.Text.Trim()
    deviceName = $DeviceNameBox.Text.Trim()
    autoStart = $AutoStartBox.Checked
  }
}

function Set-FormConfig {
  param([hashtable]$Config)
  $ServerUrlBox.Text = [string]$Config.serverUrl
  $TokenBox.Text = [string]$Config.token
  $DeviceNameBox.Text = [string]$Config.deviceName
  $AutoStartBox.Checked = [bool]$Config.autoStart
}

function Get-MobileUrl {
  param([hashtable]$Config)
  if (-not $Config.serverUrl -or -not $Config.token) { return '' }
  $builder = [System.UriBuilder]::new($Config.serverUrl)
  $builder.Query = "token=$([Uri]::EscapeDataString($Config.token))"
  $builder.Uri.AbsoluteUri
}

function Test-Cloud {
  param([hashtable]$Config)
  if (-not $Config.serverUrl -or -not $Config.token) {
    return @{ ok = $false; online = $false; detail = (U '\u4e91\u7aef\u5730\u5740\u6216 Token \u672a\u586b\u5199') }
  }
  try {
    $url = "$(Normalize-ServerUrl $Config.serverUrl)/codex/health?token=$([Uri]::EscapeDataString($Config.token))"
    $result = Invoke-RestMethod -Uri $url -TimeoutSec 5
    @{ ok = [bool]$result.ok; online = [bool]$result.online; detail = (U 'HTTP \u6b63\u5e38') }
  } catch {
    @{ ok = $false; online = $false; detail = $_.Exception.Message }
  }
}

function Test-CodexDebug {
  try {
    $targets = Invoke-RestMethod -Uri 'http://127.0.0.1:9229/json/list' -TimeoutSec 3
    $hasCodex = @($targets | Where-Object { $_.url -eq 'app://-/index.html' }).Count -gt 0
    $detail = if ($hasCodex) { U 'CDP \u5c31\u7eea' } else { U '\u672a\u627e\u5230 Codex \u9875\u9762\u76ee\u6807' }
    @{ ok = $hasCodex; detail = $detail }
  } catch {
    @{ ok = $false; detail = $_.Exception.Message }
  }
}

function Get-AgentProcess {
  if ($Script:AgentProcess -and -not $Script:AgentProcess.HasExited) { return $Script:AgentProcess }
  $Script:AgentProcess = $null
  $scriptPattern = [regex]::Escape($AgentScriptPath)
  $candidate = Get-CimInstance Win32_Process |
    Where-Object { $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -match $scriptPattern } |
    Sort-Object ProcessId |
    Select-Object -First 1
  if (-not $candidate) { return $null }
  try {
    $process = [System.Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId)
    if (-not $process.HasExited) {
      $Script:AgentProcess = $process
      return $process
    }
  } catch {
    return $null
  }
  return $null
}

function Test-AgentRunning {
  $null -ne (Get-AgentProcess)
}

function Start-Agent {
  $config = Get-ConfigFromForm
  if (-not $config.serverUrl) { throw (U '\u8bf7\u5148\u586b\u5199\u4e91\u7aef\u670d\u52a1\u5668\u5730\u5740\u3002') }
  if (-not $config.token) { throw (U '\u8bf7\u5148\u586b\u5199\u56fa\u5b9a Token\u3002') }
  Save-Config $config
  $runningProcess = Get-AgentProcess
  if ($runningProcess) {
    Add-Log "$((U 'Agent \u5df2\u5728\u8fd0\u884c\uff0cPID '))$($runningProcess.Id)"
    return
  }
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = 'node'
  $psi.Arguments = "`"$AgentScriptPath`""
  $psi.WorkingDirectory = $ProjectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['CODEX_CLOUD_URL'] = $config.serverUrl
  $psi.EnvironmentVariables['CODEX_DEVICE_TOKEN'] = $config.token
  $psi.EnvironmentVariables['CODEX_DEVICE_NAME'] = $config.deviceName
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  [void]$process.Start()
  $Script:AgentProcess = $process
  Add-Log "$((U 'Agent \u5df2\u542f\u52a8\uff0cPID '))$($process.Id)"
}

function Stop-Agent {
  $runningProcess = Get-AgentProcess
  if ($runningProcess) {
    $pid = $runningProcess.Id
    $runningProcess.Kill()
    $runningProcess.WaitForExit(3000) | Out-Null
    $Script:AgentProcess = $null
    Add-Log "$((U 'Agent \u5df2\u505c\u6b62\uff0cPID '))$pid"
  } else {
    Add-Log (U 'Agent \u5f53\u524d\u672a\u8fd0\u884c')
  }
}

function Update-GeneratedFields {
  $config = Get-ConfigFromForm
  $MobileUrlBox.Text = Get-MobileUrl $config
  $EnvBox.Text = "CODEX_CLOUD_URL=$($config.serverUrl)`r`nCODEX_DEVICE_TOKEN=$($config.token)`r`nCODEX_DEVICE_NAME=$($config.deviceName)"
}

function Set-StatusLabel {
  param(
    [System.Windows.Forms.Label]$Label,
    [bool]$Ok,
    [string]$Text
  )
  $Label.Text = $Text
  $Label.ForeColor = if ($Ok) { [System.Drawing.Color]::FromArgb(18, 128, 92) } else { [System.Drawing.Color]::FromArgb(180, 35, 24) }
}

function Refresh-Status {
  Update-GeneratedFields
  $config = Get-ConfigFromForm
  $cloud = Test-Cloud $config
  $codex = Test-CodexDebug
  $agentProcess = Get-AgentProcess
  $agentRunning = $null -ne $agentProcess
  Set-StatusLabel $CloudStatusLabel $cloud.ok ($(if ($cloud.ok) { U '\u4e91\u7aef\uff1a\u53ef\u8bbf\u95ee' } else { "$((U '\u4e91\u7aef\uff1a\u4e0d\u53ef\u8bbf\u95ee - '))$($cloud.detail)" }))
  Set-StatusLabel $AgentStatusLabel $agentRunning ($(if ($agentRunning) { "$((U 'Agent\uff1a\u8fd0\u884c\u4e2d PID '))$($agentProcess.Id)" } else { U 'Agent\uff1a\u672a\u8fd0\u884c' }))
  Set-StatusLabel $CodexStatusLabel $codex.ok ($(if ($codex.ok) { U 'Codex Desktop\uff1aCDP \u5df2\u5f00\u653e' } else { "$((U 'Codex Desktop\uff1aCDP \u4e0d\u53ef\u7528 - '))$($codex.detail)" }))
  $CloudOnlineLabel.Text = if ($cloud.online) { U '\u4e91\u7aef\u663e\u793a\uff1aAgent \u5df2\u5728\u7ebf' } else { U '\u4e91\u7aef\u663e\u793a\uff1aAgent \u672a\u5728\u7ebf' }
  $CloudOnlineLabel.ForeColor = if ($cloud.online) { [System.Drawing.Color]::FromArgb(18, 128, 92) } else { [System.Drawing.Color]::FromArgb(107, 114, 128) }
  $LogBox.Text = ($Script:LastLog -join "`r`n")
}

$Form = [System.Windows.Forms.Form]::new()
$Form.Text = U 'Codex Desktop \u7ba1\u7406\u5668'
$Form.StartPosition = 'CenterScreen'
$Form.Size = [System.Drawing.Size]::new(760, 650)
$Form.MinimumSize = [System.Drawing.Size]::new(720, 600)

$Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 9)
$Form.Font = $Font

$Root = [System.Windows.Forms.TableLayoutPanel]::new()
$Root.Dock = 'Fill'
$Root.Padding = [System.Windows.Forms.Padding]::new(14)
$Root.ColumnCount = 1
$Root.RowCount = 9
$Root.AutoScroll = $true
$Form.Controls.Add($Root)

function Add-Label {
  param([string]$Text)
  $label = [System.Windows.Forms.Label]::new()
  $label.Text = $Text
  $label.Dock = 'Fill'
  $label.Height = 22
  $label
}

function Add-TextBox {
  $box = [System.Windows.Forms.TextBox]::new()
  $box.Dock = 'Fill'
  $box.Height = 26
  $box
}

$CloudStatusLabel = Add-Label (U '\u4e91\u7aef\uff1a\u68c0\u6d4b\u4e2d')
$AgentStatusLabel = Add-Label (U 'Agent\uff1a\u68c0\u6d4b\u4e2d')
$CodexStatusLabel = Add-Label (U 'Codex Desktop\uff1a\u68c0\u6d4b\u4e2d')
$CloudOnlineLabel = Add-Label (U '\u4e91\u7aef\u663e\u793a\uff1a\u68c0\u6d4b\u4e2d')

$StatusPanel = [System.Windows.Forms.TableLayoutPanel]::new()
$StatusPanel.Dock = 'Fill'
$StatusPanel.ColumnCount = 1
$StatusPanel.RowCount = 4
$StatusPanel.Height = 96
$StatusPanel.Controls.Add($CloudStatusLabel)
$StatusPanel.Controls.Add($CloudOnlineLabel)
$StatusPanel.Controls.Add($AgentStatusLabel)
$StatusPanel.Controls.Add($CodexStatusLabel)
$Root.Controls.Add($StatusPanel)

$Root.Controls.Add((Add-Label (U '\u4e91\u7aef\u670d\u52a1\u5668\u5730\u5740')))
$ServerUrlBox = Add-TextBox
$Root.Controls.Add($ServerUrlBox)

$ConfigGrid = [System.Windows.Forms.TableLayoutPanel]::new()
$ConfigGrid.Dock = 'Fill'
$ConfigGrid.ColumnCount = 2
$ConfigGrid.RowCount = 2
$ConfigGrid.Height = 58
[void]$ConfigGrid.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 50))
[void]$ConfigGrid.ColumnStyles.Add([System.Windows.Forms.ColumnStyle]::new([System.Windows.Forms.SizeType]::Percent, 50))
$ConfigGrid.Controls.Add((Add-Label (U '\u56fa\u5b9a Token')), 0, 0)
$ConfigGrid.Controls.Add((Add-Label (U '\u8bbe\u5907\u540d\u79f0')), 1, 0)
$TokenBox = Add-TextBox
$DeviceNameBox = Add-TextBox
$ConfigGrid.Controls.Add($TokenBox, 0, 1)
$ConfigGrid.Controls.Add($DeviceNameBox, 1, 1)
$Root.Controls.Add($ConfigGrid)

$AutoStartBox = [System.Windows.Forms.CheckBox]::new()
$AutoStartBox.Text = U '\u5f00\u673a\u81ea\u542f'
$AutoStartBox.Height = 28
$Root.Controls.Add($AutoStartBox)

$ButtonPanel = [System.Windows.Forms.FlowLayoutPanel]::new()
$ButtonPanel.Dock = 'Fill'
$ButtonPanel.Height = 42
$SaveButton = [System.Windows.Forms.Button]::new()
$SaveButton.Text = U '\u4fdd\u5b58\u914d\u7f6e'
$SaveButton.Width = 100
$StartButton = [System.Windows.Forms.Button]::new()
$StartButton.Text = U '\u542f\u52a8 Agent'
$StartButton.Width = 100
$StopButton = [System.Windows.Forms.Button]::new()
$StopButton.Text = U '\u505c\u6b62 Agent'
$StopButton.Width = 100
$RefreshButton = [System.Windows.Forms.Button]::new()
$RefreshButton.Text = U '\u5237\u65b0\u72b6\u6001'
$RefreshButton.Width = 100
$OpenMobileButton = [System.Windows.Forms.Button]::new()
$OpenMobileButton.Text = U '\u6253\u5f00\u624b\u673a\u9875'
$OpenMobileButton.Width = 110
$ButtonPanel.Controls.AddRange(@($SaveButton, $StartButton, $StopButton, $RefreshButton, $OpenMobileButton))
$Root.Controls.Add($ButtonPanel)

$Root.Controls.Add((Add-Label (U '\u624b\u673a\u8bbf\u95ee\u5730\u5740')))
$MobileUrlBox = Add-TextBox
$MobileUrlBox.ReadOnly = $true
$Root.Controls.Add($MobileUrlBox)

$Root.Controls.Add((Add-Label (U 'Agent \u73af\u5883\u53d8\u91cf')))
$EnvBox = [System.Windows.Forms.TextBox]::new()
$EnvBox.Dock = 'Fill'
$EnvBox.Multiline = $true
$EnvBox.ReadOnly = $true
$EnvBox.Height = 72
$Root.Controls.Add($EnvBox)

$Root.Controls.Add((Add-Label (U '\u65e5\u5fd7')))
$LogBox = [System.Windows.Forms.TextBox]::new()
$LogBox.Dock = 'Fill'
$LogBox.Multiline = $true
$LogBox.ReadOnly = $true
$LogBox.ScrollBars = 'Vertical'
$LogBox.Height = 160
$Root.Controls.Add($LogBox)

$Config = Read-Config
Set-FormConfig $Config

$SaveButton.Add_Click({
  try {
    Save-Config (Get-ConfigFromForm)
    Refresh-Status
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (U '\u4fdd\u5b58\u5931\u8d25'), 'OK', 'Error') | Out-Null
  }
})

$StartButton.Add_Click({
  try {
    Start-Agent
    Start-Sleep -Milliseconds 500
    Refresh-Status
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, (U '\u542f\u52a8\u5931\u8d25'), 'OK', 'Error') | Out-Null
  }
})

$StopButton.Add_Click({
  Stop-Agent
  Refresh-Status
})

$RefreshButton.Add_Click({ Refresh-Status })

$OpenMobileButton.Add_Click({
  Update-GeneratedFields
  if ($MobileUrlBox.Text) {
    Start-Process $MobileUrlBox.Text
  }
})

$ServerUrlBox.Add_TextChanged({ Update-GeneratedFields })
$TokenBox.Add_TextChanged({ Update-GeneratedFields })
$DeviceNameBox.Add_TextChanged({ Update-GeneratedFields })

$Timer = [System.Windows.Forms.Timer]::new()
$Timer.Interval = 5000
$Timer.Add_Tick({ Refresh-Status })
$Timer.Start()

$Form.Add_FormClosing({
  $Timer.Stop()
})

Refresh-Status
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($Form)
