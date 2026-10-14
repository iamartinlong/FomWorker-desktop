$t = 'C:\Users\EDY\workspace\step2-link-target'
New-Item -ItemType Directory -Force -Path $t | Out-Null
$p = 'F:\deepseek\deepseek harness\office-platform\.spike\memory-spike\feedback'
New-Item -ItemType Junction -Path $p -Target $t | Out-Null
