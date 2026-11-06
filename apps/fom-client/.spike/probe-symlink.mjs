import { mkdtemp, mkdir, writeFile, symlink, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'mem-probe-'))
const mem = join(root, 'mem')
const outside = join(root, 'outside')
await mkdir(mem, { recursive: true })
await mkdir(outside, { recursive: true })
await writeFile(join(outside, 'secret.md'), 'OUTSIDE')

async function probe(kind, create) {
  try {
    await create()
    const st = await lstat(join(mem, 'user', 'x.md')).catch(() => undefined)
    const real = await realpath(join(mem, 'user', 'x.md')).catch(e => 'ERR ' + e.code)
    console.log(kind, 'lstat-isLink=', st?.isSymbolicLink(), 'realpath=', real, 'root=', resolve(mem))
  } catch (error) {
    console.log(kind, 'CREATE-FAILED', error.code)
  }
  await rm(join(mem, 'user'), { recursive: true, force: true })
}

await probe('junction-dir', async () => { await symlink(outside, join(mem, 'user'), 'junction') })
await probe('file-symlink', async () => {
  await mkdir(join(mem, 'user'), { recursive: true })
  await symlink(join(outside, 'secret.md'), join(mem, 'user', 'x.md'), 'file')
})
await rm(root, { recursive: true, force: true })
