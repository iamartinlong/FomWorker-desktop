import { useCallback, useEffect, useState } from 'react'
import { createLocalStore, createSession, type OfficeSession, type UserInfo } from '../../session.ts'

/** 平台 API 地址（TODO：改为配置 / 构建期环境）。 */
const PLATFORM_URL = 'http://127.0.0.1:5180'

/** 登录 / 账号面板（对着 C1 `/auth/login`）。 */
export function LoginPage() {
  const [session] = useState<OfficeSession>(() => createSession({ platformUrl: PLATFORM_URL, store: createLocalStore() }))
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
      const u = await session.login({ method: 'email', email, password })
      const token = session.token()
      if (token !== null) {
        try {
          await fetch('/api/office/login/token', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accessToken: token }),
          })
        } catch {
          /* 宿主未就绪：忽略（令牌仍在本地会话） */
        }
      }
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

  const inputStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit', boxSizing: 'border-box' }
  const btnStyle: React.CSSProperties = { padding: '7px 16px', borderRadius: 8, border: 'none', background: '#038AC6', color: '#fff', fontWeight: 600, cursor: 'pointer' }

  return (
    <div style={{ padding: '18px 20px', fontFamily: 'system-ui', lineHeight: 1.6, width: '100%', boxSizing: 'border-box', maxWidth: 420 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>登录 · FomWorker</h2>
      {user !== null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13 }}>
            已登录：<b>{user.displayName || user.email || user.userId}</b>
            <span style={{ opacity: 0.6 }}>{`（租户 ${user.tenantId}${user.role ? ' · ' + user.role : ''}）`}</span>
          </div>
          <button style={{ ...btnStyle, background: 'transparent', color: '#038AC6', border: '1px solid #038AC666', alignSelf: 'flex-start' }} onClick={logout}>
            退出登录
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 12.5, opacity: 0.8 }}>
            邮箱
            <input style={{ ...inputStyle, marginTop: 4 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" />
          </label>
          <label style={{ fontSize: 12.5, opacity: 0.8 }}>
            密码
            <input style={{ ...inputStyle, marginTop: 4 }} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button style={{ ...btnStyle, alignSelf: 'flex-start', opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={submit}>
            {busy ? '登录中…' : '登录'}
          </button>
          <div style={{ fontSize: 11.5, opacity: 0.5 }}>{`平台：${PLATFORM_URL}（契约 /auth/login）`}</div>
        </div>
      )}
      {error !== null ? <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'crimson' }}>{error}</p> : null}
    </div>
  )
}
