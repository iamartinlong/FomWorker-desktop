import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card } from '@fominfo/dsh-ui'
import { createLocalStore, createSession, type OfficeSession, type UserInfo } from '../../session.ts'
import { ImBindings } from './ImBindings.tsx'
import css from './LoginPage.module.css'

/** 登录 / 账号面板（对着 C1 `/auth/login`；登录经**宿主代理**，见 `session.ts`）。样式走 `LoginPage.module.css`。 */
export function LoginPage() {
  const [session] = useState<OfficeSession>(() => createSession({ store: createLocalStore() }))
  const [user, setUser] = useState<UserInfo | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setUser(session.current()?.user ?? null)
  }, [session])

  const submit = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // 登录经**宿主代理**：宿主在服务端调平台、写凭据，只把 user 回给我们（令牌不过浏览器）。
      const u = await session.login({ method: 'email', email, password })
      setUser(u)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [session, email, password])

  const logout = useCallback(() => {
    session.logout()
    setUser(null)
  }, [session])

  return (
    <div className={css.page}>
      <h2 className={css.title}>登录 · FomWorker</h2>
      {user !== null ? (
        <Card>
          <div className={css.userLine}>
            已登录：<b>{user.displayName || user.email || user.userId}</b>
            <span className={css.muted}>{`（租户 ${user.tenantId}${user.role ? ' · ' + user.role : ''}）`}</span>
          </div>
          <div>
            <Button variant="outline" size="sm" onClick={logout}>退出登录</Button>
          </div>
        </Card>
      ) : null}
      {user !== null ? (
        <Card>
          <ImBindings active={user !== null} />
        </Card>
      ) : (
        <Card variant="form">
          <label className={css.field}>
            邮箱
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" />
          </label>
          <label className={css.field}>
            密码
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <div>
            <Button variant="primary" size="sm" disabled={busy} onClick={submit}>
              {busy ? '登录中…' : '登录'}
            </Button>
          </div>
          <span className={css.muted}>登录经宿主代理（平台地址由宿主配置，契约 /auth/login）</span>
        </Card>
      )}
      {error !== null ? <p className={css.error}>{error}</p> : null}
    </div>
  )
}
