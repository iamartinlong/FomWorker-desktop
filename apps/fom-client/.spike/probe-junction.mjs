import { mkdtemp, mkdir, writeFile, symlink, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'mem-probe-'))
const mem = join(root, 'mem')
const outside = join(root, 'outside')
await mkdir(mem, { recursive: true })
await mkdir(outside, { recursive: true })
await writeFile(join(outside, 'secret.md'), 'OUTSIDE')
await symlink(outside, join(mem, 'user'), 'junction')
console.log('lstat(user).isLink=', (await lstat(join(mem, 'user'))).isSymbolicLink())
console.log('realpath(user)=', await realpath(join(mem, 'user')))
console.log('realpath(user/x.md)=', await realpath(join(mem, 'user', 'x.md')).catch(e => 'ERR ' + e.code))
console.log('root=', resolve(mem), 'outside=', resolve(outside))
console.log('case check:', await realpath(mem))
await rm(root, { recursive: true, force: true })
