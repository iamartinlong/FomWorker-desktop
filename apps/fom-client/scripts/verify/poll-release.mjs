/**
 * 盯一个 GitHub Actions run 到结束——发版时用来等 CI，不用反复刷页面。
 *
 * 用法：
 *   node scripts/verify/poll-release.mjs <run-id>            # 盯指定 run
 *   node scripts/verify/poll-release.mjs --tag pkg-33        # 按 tag 找最新 run
 *   node scripts/verify/poll-release.mjs --repo <owner/repo> # 默认 iamartinlong/FomWorker-desktop
 *
 * 退出码：0 = success，1 = 其它结论（failure/cancelled…），2 = 用法/取不到 run。
 * 只读 GitHub 公共 API，**匿名即可**（限流 60 次/小时，四轮发版够用）。
 */

const args = process.argv.slice(2)
const repoIndex = args.indexOf('--repo')
const repo = repoIndex >= 0 ? args[repoIndex + 1] : 'iamartinlong/FomWorker-desktop'
const tagIndex = args.indexOf('--tag')
const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
const runId = args.find((a) => /^\d+$/u.test(a))

if (runId === undefined && tag === undefined) {
  console.error('用法：poll-release.mjs <run-id> | --tag <pkg-nn> [--repo owner/repo]')
  process.exit(2)
}

const headers = { 'User-Agent': 'fom-ci-check', Accept: 'application/vnd.github+json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = async (url) => {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

async function resolveRun() {
  if (runId !== undefined) return get(`https://api.github.com/repos/${repo}/actions/runs/${runId}`)
  const runs = await get(`https://api.github.com/repos/${repo}/actions/runs?per_page=10`)
  const hit = (runs.workflow_runs ?? []).find((r) => r.head_branch === tag)
  if (hit === undefined) throw new Error(`找不到 ref=${tag} 的 run（可能还没被 CI 拾取，稍候再试）`)
  return hit
}

let last = ''
const started = Date.now()

for (;;) {
  let run
  try {
    run = await resolveRun()
  } catch (error) {
    console.log(`取 run 失败：${error.message}（重试）`)
    await sleep(20000)
    continue
  }
  let line = `${new Date().toISOString().slice(11, 19)}  #${run.run_number} ${run.status}/${run.conclusion ?? '-'}`
  try {
    const jobs = await get(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`)
    for (const job of jobs.jobs ?? []) {
      const cur = (job.steps ?? []).find((s) => s.status === 'in_progress')
      line += `  [${job.name}] ${job.status}/${job.conclusion ?? '-'}`
      if (cur) line += ` → ${cur.name}(${cur.number})`
    }
  } catch { /* jobs 取不到不影响主状态 */ }

  if (line !== last) { console.log(line); last = line }
  if (run.status === 'completed') {
    const mins = ((Date.now() - started) / 60000).toFixed(1)
    console.log(`\nFINAL: ${run.status}/${run.conclusion}（本次等待 ${mins} 分钟）`)
    console.log(`URL: ${run.html_url}`)
    process.exit(run.conclusion === 'success' ? 0 : 1)
  }
  await sleep(45000)
}
