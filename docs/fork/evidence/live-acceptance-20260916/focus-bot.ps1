Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class BotWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$target = Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -like '*AIRI-bot*' } | Select-Object -First 1
if (-not $target) { Write-Output 'no bot java process'; exit 1 }
$pid2 = [int]$target.ProcessId
$hwnd = (Get-Process -Id $pid2).MainWindowHandle
if ($hwnd -eq 0) { Write-Output 'no window handle yet'; exit 1 }

# Lost focus opens the vanilla pause menu; focus regain closes it again. Both
# transitions are automatic, so this pair is a deterministic way to reach the
# no-screen normal-play state the charge-reset report was about.
[BotWindow]::ShowWindow($hwnd, 6) | Out-Null
Start-Sleep -Milliseconds 700
[BotWindow]::ShowWindow($hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 300
[Microsoft.VisualBasic.Interaction]::AppActivate($pid2) | Out-Null
Start-Sleep -Milliseconds 700

$foreground = [BotWindow]::GetForegroundWindow()
Write-Output "pid=$pid2 hwnd=$hwnd foreground=$foreground focused=$($foreground -eq $hwnd)"
