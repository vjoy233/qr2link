# oskeys.ps1 — 前台化自动化浏览器窗口并注入 OS 级组合键（触发真实扩展 commands 手势）
# 用法：powershell -File oskeys.ps1 <chrome|msedge> <Combo>
#   Combo 例：Alt+Shift+S、Escape
# 安全：发送前校验前台窗口确为本自动化实例（命令行含标记），否则中止，绝不误发到用户窗口。
param(
  [Parameter(Mandatory=$true)][string]$Channel,
  [Parameter(Mandatory=$true)][string]$Combo
)
$ErrorActionPreference = 'Stop'
$marker = 'QR2LINK-E2E-MARKER'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Kbd {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref uint v, uint init);
  public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
  public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public KEYBDINPUT U; public IntPtr pad; } // pad 凑齐 x64 真实 INPUT=40B（含 MOUSEINPUT union），cbSize 校验必需
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public const uint KEYEVENTF_KEYUP = 0x0002;

  static void One(ushort vk, bool up) {
    // 实测本环境 SendInput 注入成功(ret=1)但事件不达目标窗口；keybd_event 可达 → 用 keybd_event
    keybd_event((byte)vk, 0, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
  }
  public static void Combo(ushort[] mods, ushort key) {
    foreach (var m in mods) One(m, false);
    System.Threading.Thread.Sleep(60);
    One(key, false);
    System.Threading.Thread.Sleep(60);
    One(key, true);
    foreach (var m in mods) One(m, true);
  }
}
"@

# ---- 定位自动化浏览器主窗口 ----
$procName = if ($Channel -eq 'msedge') { 'msedge' } else { 'chrome' }
$target = $null
Get-CimInstance Win32_Process -Filter "Name='$procName.exe'" | ForEach-Object {
  if ($target) { return }
  if ($_.CommandLine -and $_.CommandLine.Contains($marker)) {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $target = $p }
  }
}
if (-not $target) { throw "未找到带标记的 $procName 主窗口（标记：$marker）" }
$hwnd = $target.MainWindowHandle

# 已是前台则直接跳过（避免 Alt-tap 触发浏览器菜单焦点副作用）
if ([Kbd]::GetForegroundWindow() -eq $hwnd) {
  Start-Sleep -Milliseconds 150
} else {
[Kbd]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE（最小化时还原）
Start-Sleep -Milliseconds 300

# ---- 前台化组合拳（Windows 前台锁：后台进程默认禁止抢焦点） ----
$timeoutOld = [uint32]0
[Kbd]::SystemParametersInfo([Kbd]::SPI_GETFOREGROUNDLOCKTIMEOUT, 0, [ref]$timeoutOld, 0) | Out-Null
$zero = [uint32]0
[Kbd]::SystemParametersInfo([Kbd]::SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [ref]$zero, 0) | Out-Null   # 临时禁锁

function Test-Fg { return ([Kbd]::GetForegroundWindow() -eq $hwnd) }

# 1) 直接尝试（无按键注入，零副作用）
[Kbd]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 250
$ok = Test-Fg

# 2) AttachThreadInput：把输入队列接到前台线程再抢（无按键注入）
if (-not $ok) {
  $fg = [Kbd]::GetForegroundWindow()
  $fgThread = [Kbd]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $myThread = [Kbd]::GetCurrentThreadId()
  [Kbd]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
  [Kbd]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 250
  [Kbd]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
  $ok = Test-Fg
}

# 3) Alt-tap 最后手段（副作用：可能让浏览器进入菜单焦点模式，吞掉后续组合键）
if (-not $ok) {
  [Kbd]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [Kbd]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # KEYEVENTF_KEYUP
  Start-Sleep -Milliseconds 80
  [Kbd]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 250
  $ok = Test-Fg
}

[Kbd]::SystemParametersInfo([Kbd]::SPI_SETFOREGROUNDLOCKTIMEOUT, 0, [ref]$timeoutOld, 0) | Out-Null  # 还原

if (-not $ok) { throw "前台化失败（当前前台不是自动化实例），为安全起见不发送按键" }
Start-Sleep -Milliseconds 300
}

# ---- 解析组合键 ----
$vkMap = @{
  'shift'=0x10; 'ctrl'=0x11; 'alt'=0x12
  'a'=0x41;'b'=0x42;'c'=0x43;'d'=0x44;'e'=0x45;'f'=0x46;'g'=0x47;'h'=0x48;'i'=0x49;'j'=0x4A
  'k'=0x4B;'l'=0x4C;'m'=0x4D;'n'=0x4E;'o'=0x4F;'p'=0x50;'q'=0x51;'r'=0x52;'s'=0x53;'t'=0x54
  'u'=0x55;'v'=0x56;'w'=0x57;'x'=0x58;'y'=0x59;'z'=0x5A
  'esc'=0x1B; 'enter'=0x0D; 'tab'=0x09
}
$mods = @(); $key = $null
foreach ($part in $Combo.Split('+')) {
  $k = $part.ToLower()
  if (-not $vkMap.ContainsKey($k)) { throw "未知按键：$part" }
  if ($k -in @('shift','ctrl','alt')) { $mods += [uint16]$vkMap[$k] } else { $key = [uint16]$vkMap[$k] }
}
if ($null -eq $key) { throw "组合键未含主键：$Combo" }

[Kbd]::Combo([uint16[]]$mods, $key)

# ---- 发送后再次校验前台未被抢占（记录用） ----
if ([Kbd]::GetForegroundWindow() -ne $hwnd) { Write-Output 'WARN: 发送后前台已变化' }
