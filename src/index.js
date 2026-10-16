// dsh-wb-panel — WorkBuddyAPI gateway panel bridge for DeepSeek Harness.
//
// Registers two tools so the agent can inspect and steer the local
// WorkBuddyAPI account pool from inside DSH:
//   wb_accounts    list every account (realm, credits, expiry, state) + pool health
//   wb_account_ctl pause / resume / checkin one account by uid
//
// The plugin is a thin HTTP client of the gateway's existing panel API.
// It never touches auths/, never starts or stops the gateway process, and
// works with any gateway base URL (defaults to the local one).
//
// API key resolution order (first hit wins):
//   1. plugin config `apiKey` (profile cordis.patch.yml → wb-panel config)
//   2. env var WB_PANEL_API_KEY
//   3. api_key read from `gatewayConfigPath` (same user, same machine)

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'

export const name = 'dsh-wb-panel'
export const inject = ['tools']

export const Config = Schema.object({
  baseUrl: Schema.string().default('http://127.0.0.1:7863'),
  apiKey: Schema.string().default(''),
  gatewayConfigPath: Schema.string().default('D:/AI-Space/WorkBuddyAPI/wb2api-panel/config.json'),
  timeoutMs: Schema.number().default(8000),
})

function resolveApiKey(config) {
  if (config.apiKey) return config.apiKey
  if (process.env.WB_PANEL_API_KEY) return process.env.WB_PANEL_API_KEY
  try {
    const raw = JSON.parse(readFileSync(config.gatewayConfigPath, 'utf8'))
    if (raw && typeof raw.api_key === 'string' && raw.api_key) return raw.api_key
  } catch { /* gateway config not present; fall through */ }
  return ''
}

async function callGateway(config, path, method = 'GET') {
  const key = resolveApiKey(config)
  if (!key) {
    throw new Error('未找到网关 API key：请在插件 config.apiKey 配置，或设置环境变量 WB_PANEL_API_KEY')
  }
  const base = config.baseUrl.replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
  try {
    const res = await fetch(base + path, {
      method,
      headers: { 'Authorization': 'Bearer ' + key },
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`网关 ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

function accountState(a) {
  if (a.disabled) return 'disabled'
  if (a.paused === true) return 'paused'
  if (a.cooling) return 'cooling'
  return 'selectable'
}

function fmtExpiry(a) {
  const exp = a.credits_earliest_expiry
  if (!exp) return '-'
  const d = new Date(exp)
  if (Number.isNaN(d.getTime())) return String(exp)
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000)
  return `${d.toISOString().slice(0, 10)}(${days}d,剩${a.credits_earliest_remaining ?? '?'})`
}

function fmtAccountLine(a) {
  const nick = a.nickname || a.uid
  const st = accountState(a)
  const realm = a.realm || '?'
  const credits = `${a.credits ?? '?'}/${a.credits_total ?? '?'}`
  const inFlight = a.in_flight ? `,在途${a.in_flight}` : ''
  const until = a.cooling && a.until ? `,至${String(a.until).slice(0, 16)}` : ''
  return `- [${realm}] ${nick} | uid=${a.uid} | 积分 ${credits} | 到期 ${fmtExpiry(a)} | ${st}${inFlight}${until}`
}

function fmtPool(st) {
  const locks = st.model_locks ? Object.keys(st.model_locks).length : 0
  return `池状态: 共 ${st.total ?? '?'} 号, healthy ${st.healthy ?? '?'}, 冷却 ${st.cooling ?? '?'}, 禁用 ${st.disabled ?? '?'}, 粘性会话 ${st.sticky_sessions ?? '?'}, 模型锁 ${locks}`
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'wb_accounts',
    description:
      '列出 WorkBuddyAPI 网关的全部账号与账号池状态（区域 cn/global、昵称、uid、积分与总额、最早到期、暂停/冷却/禁用状态、在途请求数）。只读，不修改任何状态。',
    parameters: {
      realm: { type: 'string', description: '可选：cn 或 global，只列出该区域的账号' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const [overview, status] = await Promise.all([
        callGateway(config, '/panel/api/overview'),
        callGateway(config, '/status'),
      ])
      let accounts = Array.isArray(overview.accounts) ? overview.accounts : []
      if (args.realm) accounts = accounts.filter((a) => a.realm === args.realm)
      const lines = [fmtPool(status), `账号 ${accounts.length} 个:`]
      for (const a of accounts) lines.push(fmtAccountLine(a))
      if (accounts.length === 0) lines.push('(该区域没有账号)')
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wb_account_ctl',
    description:
      '对 WorkBuddyAPI 网关的单个账号执行操作：pause=暂停选号（签到/保活等定时任务照常运行）；resume=恢复选号；checkin=立即手动签到。uid 必须来自 wb_accounts 的返回。',
    parameters: {
      uid: { type: 'string', required: true, description: '账号 uid（wb_accounts 返回中的 uid= 值）' },
      action: { type: 'string', required: true, description: 'pause | resume | checkin' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const uid = String(args.uid || '').trim()
      const action = String(args.action || '').trim().toLowerCase()
      if (!uid) throw new Error('缺少 uid')
      if (!['pause', 'resume', 'checkin'].includes(action)) {
        throw new Error(`不支持的操作: ${action}（仅支持 pause | resume | checkin）`)
      }
      const before = await callGateway(config, '/panel/api/overview')
      const target = (before.accounts || []).find((a) => a.uid === uid)
      if (!target) throw new Error(`未找到 uid=${uid} 的账号（可能是 realm 不对或账号已移除）`)
      await callGateway(config, `/panel/api/accounts/${encodeURIComponent(uid)}/${action}`, 'POST')
      const after = await callGateway(config, '/panel/api/overview')
      const now = (after.accounts || []).find((a) => a.uid === uid) || {}
      const verb = action === 'pause' ? '已暂停选号' : action === 'resume' ? '已恢复选号' : '已触发签到'
      return `${verb}: [${now.realm || target.realm}] ${now.nickname || target.nickname} uid=${uid} | 当前状态 ${accountState(now)} | 积分 ${now.credits ?? target.credits}/${now.credits_total ?? target.credits_total}`
    },
  }))
}
