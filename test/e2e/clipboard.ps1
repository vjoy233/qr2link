# clipboard.ps1 — 系统剪贴板置数 / 读图（须 STA 线程）
# 用法：powershell -STA -File clipboard.ps1 <mode> <imagePath> <text>
#   mode: image | text | mixed | clear | read-image（imagePath 作输出 PNG 路径）
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
  'read-image' {
    # 读回剪贴板图片并存为 PNG（$Image 作输出路径）；stdout：OK <w>x<h> | NOIMAGE
    #（V1.2-PLAN PR-3 H 组：断言「复制图片」实际写入了图片，并供回环解码）
    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      $img.Save($Image, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("OK {0}x{1}" -f $img.Width, $img.Height)
    } else {
      Write-Output 'NOIMAGE'
    }
  }
  default { throw "unknown mode: $Mode" }
}
