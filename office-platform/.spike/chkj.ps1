$p = 'F:\deepseek\deepseek harness\office-platform\.spike\memory-spike\feedback'
$l = Get-Item $p -Force
Write-Output ("attributes: " + $l.Attributes)
Write-Output ("linktype: " + $l.LinkType)
Write-Output ("target: " + ($l.Target -join ','))
Write-Output ("children: " + ((Get-ChildItem $p -Force | Measure-Object).Count))
