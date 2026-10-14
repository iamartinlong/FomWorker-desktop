// 列出命令行里含某个关键词的进程（默认 node.exe），只报 pid + 截断后的命令行。
// 用法：node .spike/ps-grep.mjs [keyword]
const keyword = process.argv[2] ?? 'node.exe'
const { execFileSync } = await import('node:child_process')
const out = execFileSync('powershell.exe', [
  '-NoProfile', '-Command',
  "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
const rows = JSON.parse(out)
const list = Array.isArray(rows) ? rows : [rows]
for (const row of list) {
  const cl = row.CommandLine ?? ''
  if (!cl.toLowerCase().includes(keyword.toLowerCase())) continue
  console.log(`${row.ProcessId}\t${(row.Name ?? '').padEnd(14)}\t${cl.slice(0, 150)}`)
}
