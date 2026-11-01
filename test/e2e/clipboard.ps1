# clipboard.ps1 — 系统剪贴板置数（须 STA 线程）
# 用法：powershell -STA -File clipboard.ps1 <mode> <imagePath> <text>
#   mode: image | text | mixed | clear
param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [string]$Image = '',
  [string]$Text = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

switch ($Mode) {
  'clear' { [System.Windows.Forms.Clipboard]::Clear() }
  'text'  { [System.Windows.Forms.Clipboard]::SetText($Text) }
  'image' {
    $img = [System.Drawing.Image]::FromFile($Image)
    [System.Windows.Forms.Clipboard]::SetImage($img)
  }
  'mixed' {
    $img = [System.Drawing.Image]::FromFile($Image)
    $d = New-Object System.Windows.Forms.DataObject
    $d.SetImage($img)
    if ($Text) { $d.SetText($Text) }
    [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)
  }
  default { throw "unknown mode: $Mode" }
}
