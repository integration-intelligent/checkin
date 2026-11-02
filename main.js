// ========== 工具函数：敏感信息脱敏 ==========
// 只显示首尾各4位，避免日志泄露密钥
const mask = (str, startLen = 4, endLen = 4) => {
  if (!str || typeof str !== 'string') return '***'
  if (str.length <= startLen + endLen) return '*'.repeat(str.length)
  return str.slice(0, startLen) + '****' + str.slice(-endLen)
}

// ========== 默认 UA ==========
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// ========== Cookie 结构诊断 ==========
// GLaDOS 登录态由多个 Cookie 共同组成。新版站点用冒号命名（koa:sess / gld:sess），
// 旧版用点与下划线（koa.sess / gld_sess），两种命名都要兼容。
// 实测结论（2026-11-01 对 /api/user/status 逐组验证）：
//   必需 2 项 → gld:sess、gld:sess.sig（缺任一项或 sig 不匹配都返回 code=-2）
//   可选 4 项 → koa:sess、koa:sess.sig、gld:accts、gld:accts.sig
//   新版站点只下发 gld: 系字段即可鉴权，koa: 系为旧版遗留，缺失不影响
// 这里只解析「字段名」用于日志自检，不输出任何字段值，避免泄露密钥。
const REQUIRED_COOKIE_FIELDS = [
  { label: 'gld:sess', variants: ['gld:sess', 'gld_sess'] },
  { label: 'gld:sess.sig', variants: ['gld:sess.sig', 'gld_sess.sig'] },
]

const OPTIONAL_COOKIE_FIELDS = [
  { label: 'koa:sess', variants: ['koa:sess', 'koa.sess'] },
  { label: 'koa:sess.sig', variants: ['koa:sess.sig', 'koa.sess.sig'] },
  { label: 'gld:accts', variants: ['gld:accts', 'gld_accts'] },
  { label: 'gld:accts.sig', variants: ['gld:accts.sig', 'gld_accts.sig'] },
]

const parseCookieNames = (cookie) =>
  String(cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq === -1) return `(缺少name)${part.slice(0, 4)}…`
      return part.slice(0, eq).trim()
    })

const diagnoseCookie = (cookie) => {
  const raw = String(cookie || '')
  const names = parseCookieNames(raw)
  const named = names.filter((n) => !n.startsWith('(缺少name)'))
  const has = (group) => group.variants.some((v) => named.includes(v))
  return {
    names,
    named,
    hasAssign: raw.includes('='),
    missing: REQUIRED_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
    optionalMissing: OPTIONAL_COOKIE_FIELDS.filter((g) => !has(g)).map((g) => g.label),
  }
}

// ========== 多账号环境变量收集 ==========
// 规则：GLADOS、GLADOS2、GLADOS3 …… 各自独立存放账号 Cookie，互不覆盖。
// 单个环境变量内仍支持用换行分隔多个 Cookie（完全兼容原有写法）。
// 所有来源会被合并成一个账号列表，按顺序逐个签到。
// UA 可选配置：GLADOS_UA / GLADOS_UA2 / GLADOS2_UA（任选其一），按行与 Cookie 对应。
const MAX_ACCOUNT_SLOTS = 20

const splitEnvLines = (value) =>
  String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)

const resolveUaList = (slot) => {
  const candidates =
    slot === 1 ? ['GLADOS_UA'] : [`GLADOS_UA${slot}`, `GLADOS${slot}_UA`]
  for (const name of candidates) {
    const lines = splitEnvLines(process.env[name])
    if (lines.length) return { list: lines, source: name }
  }
  // 该槽位未单独配置 UA 时，回退到通用 GLADOS_UA（按行对应）
  return { list: splitEnvLines(process.env.GLADOS_UA), source: 'GLADOS_UA(回退)' }
}

const collectAccounts = () => {
  const accounts = []
  const seen = new Map() // cookie -> 首次出现的环境变量名，用于去重

  for (let slot = 1; slot <= MAX_ACCOUNT_SLOTS; slot++) {
    const envName = slot === 1 ? 'GLADOS' : `GLADOS${slot}`
    const cookies = splitEnvLines(process.env[envName])
    if (!cookies.length) continue

    const { list: uaList, source: uaSource } = resolveUaList(slot)
    cookies.forEach((cookie, i) => {
      if (seen.has(cookie)) {
        console.log(
          `⚠️  ${envName} 中第 ${i + 1} 条 Cookie 与 ${seen.get(cookie)} 中的记录重复，已自动跳过`
        )
        return
      }
      seen.set(cookie, envName)
      const ua = uaList[i] || uaList[0] || DEFAULT_UA
      accounts.push({
        envName,
        cookie,
        ua,
        uaSource: ua === DEFAULT_UA ? '内置默认UA' : uaSource,
      })
    })
  }

  return accounts
}

// ========== GLaDOS 签到核心逻辑 ==========
const glados = async () => {
  const notice = []
  const pointsSummary = [] // 用于最终汇总各账号积分
  let successCount = 0 // 按账号计数，避免依赖文本匹配重复统计
  let failCount = 0
  console.log('========== GLaDOS 签到任务开始 ==========')

  // 多环境变量账号收集（GLADOS / GLADOS2 / GLADOS3 …）
  const accounts = collectAccounts()
  if (!accounts.length) {
    console.log('⚠️  未配置 GLADOS / GLADOS2 / GLADOS3… 任一环境变量，跳过签到任务')
    return notice
  }

  const sources = [...new Set(accounts.map((a) => a.envName))]
  console.log(`📋 共检测到 ${accounts.length} 个账号`)
  console.log(`📋 环境变量来源: ${sources.join('、')}`)

  for (const [index, account] of accounts.entries()) {
    const accountNo = index + 1
    const tag = `账号 ${accountNo}|${account.envName}`
    console.log(`\n[${tag}] ---------- 开始处理 ----------`)
    console.log(`[${tag}] Cookie: ${mask(account.cookie)}`)

    // Cookie 结构自检：只输出字段名，不输出字段值
    const diag = diagnoseCookie(account.cookie)
    console.log(`[${tag}] Cookie 字段(${diag.named.length}): ${diag.named.join('、') || '无'}`)
    if (!diag.hasAssign) {
      console.log(
        `[${tag}] ⚠️ Cookie 不含 "name=value" 结构，可能只粘贴了值；请从 DevTools → Network → 该请求的 Cookie 请求头整行复制`
      )
    }
    if (diag.missing.length) {
      console.log(
        `[${tag}] ⚠️ 缺少必需字段: ${diag.missing.join('、')}——实测缺任意一项都会返回 code=-2，请重新完整复制 Cookie`
      )
    } else if (diag.optionalMissing.length) {
      console.log(
        `[${tag}] ℹ️ 未包含可选项: ${diag.optionalMissing.join('、')}（不影响鉴权，浏览器复制时通常会带上）`
      )
    }

    try {
      const domain = process.env.DOMAIN || 'glados.cloud'
      const ua = account.ua

      console.log(`[${tag}] 目标域名: ${domain}`)
      console.log(`[${tag}] UA(${account.uaSource}): ${mask(ua, 8, 8)}`)
      const common = {
        'cookie': account.cookie,
        'referer': `https://${domain}/console/checkin`,
        'user-agent': ua,
      }
      // 1. 执行签到（与原代码顺序完全一致）
      console.log(`[${tag}] 正在执行签到请求...`)
      const checkinRes = await fetch(`https://${domain}/api/user/checkin`, {
        method: 'POST',
        headers: { ...common, 'content-type': 'application/json' },
        body: JSON.stringify({ token: domain }),
      })
      // HTTP 层错误捕获（网络错误、404、500等）
      if (!checkinRes.ok) {
        throw new Error(`签到接口HTTP错误: ${checkinRes.status} ${checkinRes.statusText}`)
      }
      const action = await checkinRes.json()
      console.log(`[${tag}] 签到接口响应码: ${action?.code ?? '无'}`)
      // code=0 签到成功；code=1 表示今日已签到过（属正常情况，仍继续查询剩余天数与积分）
      const alreadyCheckedIn = action?.code === 1
      if (action?.code !== 0 && !alreadyCheckedIn) {
        throw new Error(
          `${action?.message || '签到失败'} (code=${action.code}${action?.reason ? ', reason=' + action.reason : ''})`
        )
      }
      if (alreadyCheckedIn) {
        console.log(`[${tag}] 今日已签到过，继续查询剩余天数与积分...`)
      }
      // 2. 获取账号状态（签到后更新剩余天数）
      console.log(`[${tag}] 正在获取账号状态...`)
      const statusRes = await fetch(`https://${domain}/api/user/status`, {
        method: 'GET',
        headers: { ...common },
      })
      if (!statusRes.ok) {
        throw new Error(`状态接口HTTP错误: ${statusRes.status} ${statusRes.statusText}`)
      }
      const status = await statusRes.json()
      console.log(`[${tag}] 状态接口响应码: ${status?.code ?? '无'}`)
      if (status?.code !== 0) {
        throw new Error(`登录状态异常: ${status?.message || '未知错误'} (code=${status.code})`)
      }
      // 签到成功
      const leftDays = Number(status?.data?.leftDays)

      // ========== 3. 查询当前积分（始终执行，保证运行日志能看到每个账号积分） ==========
      let currentPoints = null
      try {
        console.log(`[${tag}] 正在获取积分...`)
        const pointsRes = await fetch(`https://${domain}/api/user/points`, {
          method: 'GET',
          headers: { ...common },
        })
        if (!pointsRes.ok) {
          throw new Error(`积分接口HTTP错误: ${pointsRes.status} ${pointsRes.statusText}`)
        }
        const pointsData = await pointsRes.json()
        console.log(`[${tag}] 积分接口响应码: ${pointsData?.code ?? '无'}`)
        if (pointsData?.code !== 0) {
          throw new Error(
            `获取积分失败: ${pointsData?.message || '未知错误'} (code=${pointsData?.code})`
          )
        }
        currentPoints = Number(pointsData?.points) || 0
        console.log(`[${tag}] 💰 当前积分: ${currentPoints} 点`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): ${currentPoints} 点`)
      } catch (pointsErr) {
        console.warn(`[${tag}] ⚠️ 积分查询失败: ${pointsErr.message}`)
        pointsSummary.push(`账号${accountNo}(${account.envName}): 查询失败`)
      }

      // ========== 4. 积分自动兑换（满500积分自动消耗500积分兑换100天） ==========
      // 开关：AUTO_EXCHANGE，默认开启；设为 false 可关闭
      // 阈值：EXCHANGE_THRESHOLD，默认 500
      const autoExchange = String(process.env.AUTO_EXCHANGE || 'true').toLowerCase() !== 'false'
      const exchangeThreshold = Number(process.env.EXCHANGE_THRESHOLD || 500)
      if (autoExchange && currentPoints != null && currentPoints >= exchangeThreshold) {
        try {
          console.log(`[${tag}] 积分 ${currentPoints} ≥ ${exchangeThreshold}，自动兑换 100 天...`)
          const exRes = await fetch(`https://${domain}/api/user/exchange`, {
            method: 'POST',
            headers: { ...common, 'content-type': 'application/json' },
            body: JSON.stringify({ planType: 'plan500' }),
          })
          if (!exRes.ok) {
            throw new Error(`兑换接口HTTP错误: ${exRes.status} ${exRes.statusText}`)
          }
          const ex = await exRes.json()
          console.log(`[${tag}] 兑换接口响应码: ${ex?.code ?? '无'}`)
          if (ex?.code !== 0) {
            throw new Error(`${ex?.message || '兑换失败'} (code=${ex?.code})`)
          }
          const remain = Number(ex?.points) || 0
          console.log(`[${tag}] ✅ 自动兑换成功，消耗500积分，剩余积分: ${remain}`)
          notice.push(
            `【账号${accountNo}】自动兑换成功`,
            `兑换结果: ${ex?.message || '消耗500积分兑换100天'}`,
            `剩余积分: ${remain}`
          )
        } catch (exErr) {
          // 兑换异常不影响签到结果，单独记录
          console.error(`[${tag}] ⚠️ 自动兑换异常（不影响签到结果）`)
          console.error(`[${tag}] 错误详情: ${exErr.message}`)
          notice.push(`【账号${accountNo}】自动兑换失败`, `错误: ${exErr.message}`)
        }
      } else if (autoExchange) {
        console.log(
          `[${tag}] 积分 ${currentPoints ?? '未知'} 未达到 ${exchangeThreshold}，本次不兑换`
        )
      }
      // ========== 新增部分结束 ==========

      console.log(`[${tag}] ✅ ${alreadyCheckedIn ? '今日已签到过' : '签到成功'}`)
      console.log(`[${tag}] 返回消息: ${action?.message || (alreadyCheckedIn ? '今日已签到过' : '')}`)
      console.log(`[${tag}] 剩余天数: ${leftDays} 天`)
      console.log(`[${tag}] 当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}`)
      notice.push(
        `【账号${accountNo}】签到成功`,
        `${alreadyCheckedIn ? '今日已签到过（无新增积分）' : action?.message}`,
        `剩余天数: ${leftDays} 天`,
        `当前积分: ${currentPoints != null ? currentPoints + ' 点' : '查询失败'}`
      )
      successCount++
    } catch (error) {
      console.error(`[${tag}] ❌ 签到失败`)
      console.error(`[${tag}] 错误详情: ${error.message}`)

      notice.push(
        `【账号${accountNo}】签到失败`,
        `错误: ${error.message}`,
        `仓库地址: <${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
      )
      failCount++
    }
  }
  // 汇总统计
  console.log('\n========== 各账号当前积分 ==========')
  if (pointsSummary.length) {
    pointsSummary.forEach((line) => console.log(`📊 ${line}`))
  } else {
    console.log('📊 无账号积分数据')
  }
  console.log('===================================')
  console.log('\n========== 签到任务处理完成 ==========')
  console.log(`📊 统计结果：成功 ${successCount} 个 | 失败 ${failCount} 个`)
  return notice
}

// ========== 通知推送模块 ==========
const notify = async (notice) => {
  console.log('\n========== 通知推送模块开始 ==========')
  if (!process.env.NOTIFY) {
    console.log('⚠️  未配置 NOTIFY 环境变量，跳过推送通知')
    return
  }
  if (!notice || notice.length === 0) {
    console.log('⚠️  无通知内容，跳过推送')
    return
  }
  const options = String(process.env.NOTIFY).split('\n').filter(Boolean)
  console.log(`📋 共配置 ${options.length} 个通知渠道`)
  for (const [idx, option] of options.entries()) {
    const channelNo = idx + 1
    let channelType = '默认(pushplus)'
    try {
      if (option.startsWith('console:')) {
        channelType = '控制台输出'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)
        console.log('———————— 通知内容 ————————')
        notice.forEach((line) => console.log(line))
        console.log('————————————————————————')
        console.log(`[通知 ${channelNo}] ✅ 控制台输出完成`)
      } else if (option.startsWith('wxpusher:')) {
        channelType = 'WxPusher'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)

        const parts = option.split(':')
        const appToken = parts[1]
        const uids = parts.slice(2)

        console.log(`[通知 ${channelNo}] appToken: ${mask(appToken)}`)
        console.log(`[通知 ${channelNo}] 推送UID数量: ${uids.length}`)
        const res = await fetch(`https://wxpusher.zjiecode.com/api/send/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appToken: appToken,
            summary: notice[0],
            content: notice.join('<br>'),
            contentType: 3,
            uids: uids,
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 1000) {
          throw new Error(`${result.msg} (code=${result.code})`)
        }
        console.log(`[通知 ${channelNo}] ✅ WxPusher 推送成功`)
      } else if (option.startsWith('pushplus:')) {
        channelType = 'PushPlus'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)

        const token = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Token: ${mask(token)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: token,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) {
          throw new Error(`${result.msg} (code=${result.code})`)
        }
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      } else if (option.startsWith('bark:')) {
        channelType = 'Bark'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)

        const barkKey = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Bark密钥: ${mask(barkKey)}`)
        const res = await fetch(`https://api.day.app/${barkKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: notice[0],
            body: notice.slice(1).join('\n'),
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) {
          throw new Error(`${result.message} (code=${result.code})`)
        }
        console.log(`[通知 ${channelNo}] ✅ Bark 推送成功`)
      } else if (option.startsWith('qyweixin:')) {
        channelType = '企业微信Webhook'
        console.log(`\n[通知 ${channelNo}] 正在推送至 ${channelType}`)

        const qyToken = option.split(':')[1]
        console.log(`[通知 ${channelNo}] Webhook Key: ${mask(qyToken)}`)
        const qyweixinNotifyRebotUrl =
          'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + qyToken
        const res = await fetch(qyweixinNotifyRebotUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: {
              content: notice.join('<br>'),
            },
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.errcode !== 0) {
          throw new Error(`${result.errmsg} (errcode=${result.errcode})`)
        }
        console.log(`[通知 ${channelNo}] ✅ 企业微信推送成功`)
      } else {
        // 兼容旧格式：无前缀默认走 pushplus
        channelType = '默认PushPlus(兼容旧格式)'
        console.log(`\n[通知 ${channelNo}] 未识别渠道前缀，使用 ${channelType}`)
        console.log(`[通知 ${channelNo}] Token: ${mask(option)}`)
        const res = await fetch(`https://www.pushplus.plus/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: option,
            title: notice[0],
            content: notice.join('<br>'),
            template: 'markdown',
          }),
        })
        const result = await res.json()
        console.log(`[通知 ${channelNo}] 接口完整响应: ${JSON.stringify(result)}`)
        if (result.code !== 200) {
          throw new Error(`${result.msg} (code=${result.code})`)
        }
        console.log(`[通知 ${channelNo}] ✅ PushPlus 推送成功`)
      }
    } catch (error) {
      console.error(`[通知 ${channelNo}] ❌ ${channelType} 推送失败`)
      console.error(`[通知 ${channelNo}] 错误详情: ${error.message}`)
      // 单个渠道失败不中断其他渠道推送
    }
  }
  console.log('\n========== 通知推送模块结束 ==========')
}

// ========== 主入口 ==========
const main = async () => {
  const notice = await glados()
  await notify(notice)
  console.log('\n🎉 全部任务执行完毕')
}

// 全局错误捕获，避免程序静默失败
main().catch((err) => {
  console.error('❌ 全局未捕获错误:', err)
  process.exit(1)
})
