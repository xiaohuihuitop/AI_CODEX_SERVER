param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('send-thread', 'stop', 'list-open-threads')]
  [string]$Action,

  [string]$ProjectName = '',
  [string]$ThreadName = '',
  [string]$TextFile = '',
  [string]$DebugListUrl = 'http://127.0.0.1:9229/json/list'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Send-CdpMessage {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Text
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $segment = [ArraySegment[byte]]::new($bytes)
  $Socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
}

function Receive-CdpMessage {
  param([System.Net.WebSockets.ClientWebSocket]$Socket)
  $buffer = New-Object byte[] 1048576
  $builder = [System.Text.StringBuilder]::new()
  do {
    $segment = [ArraySegment[byte]]::new($buffer)
    $result = $Socket.ReceiveAsync($segment, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($result.Count -gt 0) {
      [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count))
    }
  } while (-not $result.EndOfMessage)
  $builder.ToString()
}

function Invoke-Cdp {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Method,
    [hashtable]$Params = @{}
  )
  $script:NextCdpId += 1
  $id = $script:NextCdpId
  $payload = @{
    id = $id
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 16 -Compress
  Send-CdpMessage -Socket $Socket -Text $payload
  while ($true) {
    $message = Receive-CdpMessage -Socket $Socket
    if (-not $message) { continue }
    $data = $message | ConvertFrom-Json
    if ($data.id -eq $id) {
      if ($data.error) { throw ($data.error | ConvertTo-Json -Depth 8 -Compress) }
      return $data.result
    }
  }
}

function Get-CodexSocket {
  $targets = Invoke-RestMethod -Uri $DebugListUrl -TimeoutSec 5
  $target = @($targets | Where-Object { $_.url -eq 'app://-/index.html' } | Select-Object -First 1)[0]
  if (-not $target) { throw 'CODEX_DEBUG_TARGET_NOT_FOUND' }
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
  $script:NextCdpId = 0
  Invoke-Cdp -Socket $socket -Method 'Runtime.enable' | Out-Null
  Invoke-Cdp -Socket $socket -Method 'Page.bringToFront' | Out-Null
  $socket
}

function Close-CodexSocket {
  param([System.Net.WebSockets.ClientWebSocket]$Socket)
  # AI:Codex Desktop 的 CDP 连接可能仍在推送事件；这里不能等待关闭握手，否则已完成的发送会被误报为失败。
  $Socket.Dispose()
}

function Click-CdpPoint {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [double]$X,
    [double]$Y
  )
  Invoke-Cdp -Socket $Socket -Method 'Input.dispatchMouseEvent' -Params @{
    type = 'mouseMoved'
    x = $X
    y = $Y
    button = 'none'
  } | Out-Null
  Invoke-Cdp -Socket $Socket -Method 'Input.dispatchMouseEvent' -Params @{
    type = 'mousePressed'
    x = $X
    y = $Y
    button = 'left'
    clickCount = 1
  } | Out-Null
  Invoke-Cdp -Socket $Socket -Method 'Input.dispatchMouseEvent' -Params @{
    type = 'mouseReleased'
    x = $X
    y = $Y
    button = 'left'
    clickCount = 1
  } | Out-Null
}

function Get-ThreadRow {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [string]$Project,
    [string]$Thread
  )
  $projectJson = ConvertTo-Json $Project -Compress
  $threadJson = ConvertTo-Json $Thread -Compress
  $expression = @"
(() => {
  const projectName = $projectJson;
  const threadName = $threadJson;
  const labels = {
    empty: '\u6682\u65e0\u5bf9\u8bdd'
  };
  const timePattern = /^\d+\s*(\u79d2|\u5206|\u5c0f\u65f6|\u5929|\u5468|\u4e2a\u6708|\u5e74)$/;
  const linesOf = (el) => (el?.innerText || el?.textContent || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const titleOf = (el) => linesOf(el).find(line => line !== labels.empty && !timePattern.test(line)) || '';
  const rectOf = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const projectRow = [...document.querySelectorAll('[role="listitem"][aria-label]')]
    .find(el => el.getAttribute('aria-label') === projectName && el.querySelector('[role="list"]'));
  if (!projectRow) return { ok: false, code: 'PROJECT_ROW_NOT_FOUND', bodyText: document.body.innerText.slice(0, 800) };
  const threadItem = [...projectRow.querySelectorAll('[role="list"] [role="listitem"]')]
    .find(el => titleOf(el) === threadName);
  if (!threadItem) return { ok: false, code: 'THREAD_ROW_NOT_FOUND', bodyText: projectRow.innerText.slice(0, 800) };
  const row = threadItem.querySelector('[role="button"]');
  if (!row) return { ok: false, code: 'THREAD_BUTTON_NOT_FOUND', bodyText: threadItem.innerText.slice(0, 800) };
  row.scrollIntoView({ block: 'center' });
  return { ok: true, rect: rectOf(row), text: (row.innerText || row.textContent || '').trim() };
})()
"@
  $result = Invoke-Cdp -Socket $Socket -Method 'Runtime.evaluate' -Params @{
    expression = $expression
    returnByValue = $true
  }
  if (-not $result.result.value.ok) {
    throw ($result.result.value | ConvertTo-Json -Depth 8 -Compress)
  }
  $result.result.value
}

function Get-Composer {
  param([System.Net.WebSockets.ClientWebSocket]$Socket)
  $expression = @'
(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const editor = document.querySelector('[contenteditable="true"].ProseMirror') || document.querySelector('[contenteditable="true"]');
  const buttons = [...document.querySelectorAll('button')].filter(btn => {
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const sendButton = buttons.find(btn => String(btn.className || '').includes('size-token-button-composer'));
  return {
    ok: !!editor && !!sendButton,
    editorRect: rectOf(editor),
    sendRect: rectOf(sendButton),
    sendDisabled: !!sendButton?.disabled,
    bodyText: document.body.innerText.slice(0, 800)
  };
})()
'@
  $result = Invoke-Cdp -Socket $Socket -Method 'Runtime.evaluate' -Params @{
    expression = $expression
    returnByValue = $true
  }
  if (-not $result.result.value.ok) {
    throw ($result.result.value | ConvertTo-Json -Depth 8 -Compress)
  }
  $result.result.value
}

function Get-OpenThreads {
  $socket = Get-CodexSocket
  try {
    $expression = @'
(() => {
  const labels = {
    projects: '\u9879\u76ee',
    empty: '\u6682\u65e0\u5bf9\u8bdd'
  };
  const timePattern = /^\d+\s*(\u79d2|\u5206|\u5c0f\u65f6|\u5929|\u5468|\u4e2a\u6708|\u5e74)$/;
  const root = [...document.querySelectorAll('div')]
    .filter(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').trim();
      return rect.width > 180 && rect.width < 360 && rect.height > 120 && text.includes(labels.projects) && text.includes('\n');
    })
    .sort((a, b) => a.innerText.length - b.innerText.length)[0];
  if (!root) return { ok: false, code: 'OPEN_THREADS_ROOT_NOT_FOUND', bodyText: document.body.innerText.slice(0, 1000) };

  const projectRows = [...root.querySelectorAll('[role="listitem"]')]
    .filter(row => row.getAttribute('aria-label') && row.querySelector('[role="list"]'));
  const projects = projectRows.flatMap(row => {
    const projectName = (row.getAttribute('aria-label') || '').trim();
    return [...row.querySelectorAll('[role="list"] [role="listitem"]')]
      .map(item => (item.innerText || item.textContent || '').split(/\n+/).map(line => line.trim()).filter(Boolean))
      .map(lines => lines.find(line => line && line !== labels.empty && !timePattern.test(line)) || '')
      .filter(Boolean)
      .map(threadName => ({ projectName, threadName }));
  });

  return {
    ok: true,
    threads: projects
      .filter(item => item.projectName && item.threadName)
      .map(item => ({ projectName: item.projectName, threadName: item.threadName }))
  };
})()
'@
    $result = Invoke-Cdp -Socket $socket -Method 'Runtime.evaluate' -Params @{
      expression = $expression
      returnByValue = $true
    }
    if (-not $result.result.value.ok) {
      throw ($result.result.value | ConvertTo-Json -Depth 8 -Compress)
    }
    $result.result.value.threads | ConvertTo-Json -Depth 8
  } finally {
    Close-CodexSocket -Socket $socket
  }
}

function Send-ToThread {
  if (-not $ProjectName) { throw 'PROJECT_NAME_REQUIRED' }
  if (-not $ThreadName) { throw 'THREAD_NAME_REQUIRED' }
  if (-not (Test-Path -LiteralPath $TextFile)) { throw "TEXT_FILE_NOT_FOUND: $TextFile" }

  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  if (-not $text.Trim()) { throw 'EMPTY_TEXT' }

  $socket = Get-CodexSocket
  try {
    $row = Get-ThreadRow -Socket $socket -Project $ProjectName -Thread $ThreadName
    $rect = $row.rect
    $clickX = [double]($rect.x + ($rect.width / 2))
    $clickY = [double]($rect.y + [Math]::Min($rect.height - 14, [Math]::Max(16, $rect.height * 0.72)))
    Click-CdpPoint -Socket $socket -X $clickX -Y $clickY
    Start-Sleep -Milliseconds 1800

    $composer = Get-Composer -Socket $socket
    $editorRect = $composer.editorRect
    Click-CdpPoint -Socket $socket -X ([double]($editorRect.x + 24)) -Y ([double]($editorRect.y + ($editorRect.height / 2)))
    Start-Sleep -Milliseconds 200
    Invoke-Cdp -Socket $socket -Method 'Input.insertText' -Params @{ text = $text } | Out-Null
    Start-Sleep -Milliseconds 500

    $composer = Get-Composer -Socket $socket
    $sendRect = $composer.sendRect
    Click-CdpPoint -Socket $socket -X ([double]($sendRect.x + ($sendRect.width / 2))) -Y ([double]($sendRect.y + ($sendRect.height / 2)))
    Start-Sleep -Milliseconds 500

    [pscustomobject]@{
      ok = $true
      projectName = $ProjectName
      threadName = $ThreadName
    } | ConvertTo-Json -Depth 4
  } finally {
    Close-CodexSocket -Socket $socket
  }
}

function Stop-CodexResponse {
  $socket = Get-CodexSocket
  try {
    Invoke-Cdp -Socket $socket -Method 'Input.dispatchKeyEvent' -Params @{
      type = 'keyDown'
      key = 'Escape'
      code = 'Escape'
      windowsVirtualKeyCode = 27
    } | Out-Null
    Invoke-Cdp -Socket $socket -Method 'Input.dispatchKeyEvent' -Params @{
      type = 'keyUp'
      key = 'Escape'
      code = 'Escape'
      windowsVirtualKeyCode = 27
    } | Out-Null
  } finally {
    Close-CodexSocket -Socket $socket
  }
}

if ($Action -eq 'send-thread') {
  Send-ToThread
  exit 0
}

if ($Action -eq 'stop') {
  Stop-CodexResponse
  exit 0
}

if ($Action -eq 'list-open-threads') {
  Get-OpenThreads
  exit 0
}
