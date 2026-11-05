Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $c = $_.CommandLine
  if ($c.Length -gt 160) { $c = $c.Substring(0,160) }
  Write-Output "$($_.ProcessId) :: $c"
}
