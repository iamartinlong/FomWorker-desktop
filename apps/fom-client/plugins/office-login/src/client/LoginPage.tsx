/**
 * 登录门禁页（全屏，挂在 `shell.overlay`）。
 *
 * 两条出路：
 * - **登录** ⇒ 走宿主代理 `/api/office/login/session`（令牌不过浏览器），成功后进应用；
 * - **先本地使用** ⇒ 进应用，平台能力不可用（本地能力完整，见设计稿 §1.1）。
 *
 * 视觉：左侧品牌区 + 右侧表单（窄视口堆叠）。样式走 `LoginPage.module.css`，颜色只用
 * `--dsw-alias-*` 令牌，零颜色字面量。
 */
import { useCallback, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { createLocalStore, createSession, type OfficeSession, type UserInfo } from '../../session.ts'
import css from './LoginPage.module.css'

/** FomWorker 标记（与侧栏品牌同形；16:16 视图框）。 */
function Mark() {
  return (
    <svg className={css.mark} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="currentColor" opacity="0.12" />
      <path d="M10 22V10h3.4l2.6 6.2L18.6 10H22v12h-2.8v-7.4L16.9 21h-1.8l-2.3-6.4V22H10Z" fill="currentColor" />
    </svg>
  )
}

export interface LoginPageProps {
  /** 登录成功。 */
  onSignedIn(user: UserInfo): void
  /** 选「先本地使用」。 */
  onLocalMode(): void
  /** 会话（缺省自建；测试可注入）。 */
  session?: OfficeSession
}

/**
 * 登录门禁。
 * @param props.onSignedIn - 登录成功回调（调用方切到 `signed` 态）。
 * @param props.onLocalMode - 选择本地使用（调用方记标记并进应用）。
 * @param props.session - 会话实现（缺省用 localStorage 存身份）。
 * @returns 全屏登录页。
 */
export function LoginPage({ onSignedIn, onLocalMode, session: injected }: LoginPageProps) {
  const [session] = useState<OfficeSession>(() => injected ?? createSession({ store: createLocalStore() }))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSubmit = email.trim() !== '' && password !== '' && !busy

  const submit = useCallback(async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const user = await session.login({ method: 'email', email: email.trim(), password })
      onSignedIn(user)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [canSubmit, session, email, password, onSignedIn])

  return (
    <div className={css.gate} role="dialog" aria-modal="true" aria-label="登录 FomWorker">
      <div className={css.shell}>
        <aside className={css.brand}>
          <div className={css.brandTop}>
            <Mark />
            <span className={css.brandName}>FomWorker</span>
          </div>
          <div className={css.brandBody}>
            <h1 className={css.slogan}>让每个员工都有一位 AI 助手</h1>
            <p className={css.sub}>企业统一供给，全程可管可查</p>
            <ul className={css.points}>
              <li>本机执行，文件与桌面应用都能用</li>
              <li>会话与待办只存在你自己的电脑上</li>
              <li>登录后解锁派活、审批托管与手机接力</li>
            </ul>
          </div>
          <p className={css.brandFoot}>企业 AI 中台 · 员工助手</p>
        </aside>

        <section className={css.formPane}>
          <h2 className={css.formTitle}>登录</h2>
          <p className={css.formHint}>用企业邮箱登录，解锁云端协同能力。</p>

          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label className={css.field}>
              邮箱
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                disabled={busy}
                autoFocus
              />
            </label>
            <label className={css.field}>
              密码
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={busy}
              />
            </label>

            {error !== null ? (
              <p className={css.error} role="alert">{error}</p>
            ) : null}

            <Button variant="primary" type="submit" disabled={!canSubmit}>
              {busy ? '登录中…' : '登录'}
            </Button>
          </form>

          <div className={css.divider}>
            <span>或者</span>
          </div>

          <div className={css.localRow}>
            <Button variant="outline" onClick={onLocalMode} disabled={busy}>
              先本地使用
            </Button>
            <p className={css.localHint}>
              不登录也能用：AI 对话、文件、技能、待办都在本机。派活、审批托管、手机接力需要登录。
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
