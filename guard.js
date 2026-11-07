// ============================================================================
// GLaDOS 签到协议一致性检查（Protocol Guard）
// ----------------------------------------------------------------------------
// 目的：在签到之前确认服务端前端仍在用同一套 challenge/proof 协议。
// 一旦官方改动，本脚本会比"签到失败"更早发现，避免静默丢分。
//
// 监控项：
//   1. proof 盐（前端以字符码数组混淆存放，解码后应与基线一致）
//   2. 签到相关端点（/user/checkin、/user/checkin/challenge）
//   3. 协议关键字段（nonce / proof / challenge / device-mismatch）
//   4. 是否新引入第三方人机验证（hCaptcha / reCAPTCHA / Turnstile / Geetest）
//
// 用法：
//   node guard.js            # 严格模式，发现变化退出码 1
//   node guard.js --soft     # 宽松模式，只告警不阻断（供 run.yml 签到前调用）
//   node guard.js --update   # 重写基线（确认变化属正常后使用）
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DOMAIN = process.env.DOMAIN || 'glados.cloud'
const BASELINE_PATH = '.github/guard-baseline.json'
const SOFT = process.argv.includes('--soft')
const UPDATE = process.argv.includes('--update')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// 前端在计算 proof 时会引用这些标识，用于给候选盐排序（越靠近越可能是真盐）
const ANCHORS = ['checkinProof', '/user/checkin/challenge', 'checkin/challenge']

// 字符码解码时排除的 JS 常见词，避免把框架代码里的字符串当盐
const NOISE = new Set([
  'constructor',
  'prototype',
  '__esModule',
  '__proto__',
  'undefined',
  'function',
  'document',
  'window',
  'default',
  'return',
  'length',
  'object',
  'string',
  'number',
  'boolean',
])

const log = (...args) => console.log(...args)

// ============ 网络 ============
const fetchText = async (url, timeoutMs = 25000) => {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

// 限并发下载，避免一次打满连接
const pool = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// ============ 提取器 ============
const decodeCharCodes = (codes) => {
  if (!Array.isArray(codes) || codes.length < 6 || codes.length > 200) return null
  if (codes.some((c) => !Number.isInteger(c) || c < 9 || c > 126)) return null
  try {
    return String.fromCharCode(...codes)
  } catch {
    return null
  }
}

const collectSalts = (sources) => {
  const candidates = []

  const push = (value, srcIndex, position) => {
    if (!value) return
    if (value.length < 6 || value.length > 64) return
    if (!/^[\x20-\x7e]+$/.test(value)) return
    if (NOISE.has(value)) return
    if (!/[a-z]/i.test(value)) return
    candidates.push({ value, srcIndex, position })
  }

  sources.forEach((src, srcIndex) => {
    // 形式一：[103,108,...].map(function(e){return String.fromCharCode(e)}).join("")
    const arrRe = /\[(\d{1,3}(?:\s*,\s*\d{1,3}){5,})\]/g
    let m
    while ((m = arrRe.exec(src)) !== null) {
      const tail = src.slice(m.index, m.index + m[0].length + 240)
      if (!/fromCharCode/i.test(tail)) continue
      const codes = m[1].split(',').map((x) => Number(x.trim()))
      push(decodeCharCodes(codes), srcIndex, m.index)
    }

    // 形式二：String.fromCharCode(103,108,...)
    const callRe = /String\.fromCharCode\(\s*(\d{1,3}(?:\s*,\s*\d{1,3}){5,})\s*\)/g
    while ((m = callRe.exec(src)) !== null) {
      const codes = m[1].split(',').map((x) => Number(x.trim()))
      push(decodeCharCodes(codes), srcIndex, m.index)
    }

    // 形式三：明文字面量（官方若去掉混淆，直接命中文案式盐）
    const litRe = /["'`]([a-z0-9]+(?:[-_.][a-z0-9]+){1,6})["'`]/gi
    while ((m = litRe.exec(src)) !== null) {
      const v = m[1]
      if (!/glados|observe|checkin|proof|sign|check/i.test(v)) continue
      if (NOISE.has(v)) continue
      push(v, srcIndex, m.index)
    }
  })

  return candidates
}

// 越靠近 proof 计算锚点、越像"短横线分隔的短语"，越可能是真盐
const pickSalt = (candidates, sources) => {
  if (!candidates.length) return null

  const anchorPositions = []
  sources.forEach((src, srcIndex) => {
    for (const anchor of ANCHORS) {
      let from = 0
      for (;;) {
        const at = src.indexOf(anchor, from)
        if (at === -1) break
        anchorPositions.push({ srcIndex, position: at })
        from = at + anchor.length
      }
    }
  })

  const nearest = (c) => {
    let best = Infinity
    for (const a of anchorPositions) {
      if (a.srcIndex !== c.srcIndex) continue
      best = Math.min(best, Math.abs(a.position - c.position))
    }
    return best
  }

  const score = (c) => {
    const distance = nearest(c)
    let s = 0
    if (distance <= 3000) s += 100
    else if (distance <= 10000) s += 50
    if (/observe/i.test(c.value)) s += 40
    if (/glados/i.test(c.value)) s += 30
    if (/-/.test(c.value)) s += 15
    s += Math.min(c.value.length, 40) / 10
    return s
  }

  return candidates.sort((a, b) => score(b) - score(a))[0].value
}

const collectEndpoints = (sources) => {
  const set = new Set()
  for (const src of sources) {
    const re = /["'`](\/user\/[a-z0-9/-]+)["'`]/gi
    let m
    while ((m = re.exec(src)) !== null) {
      const p = m[1]
      if (/\/user\/checkin/i.test(p)) set.add(p)
    }
  }
  return [...set].sort()
}

const REQUIRED_TOKENS = ['nonce', 'proof', 'challenge', 'device-mismatch']

const checkTokens = (sources) => {
  const joined = sources.join('\n')
  return REQUIRED_TOKENS.filter((token) => !joined.toLowerCase().includes(token.toLowerCase()))
}

// 只匹配第三方验证服务的真实域名，避免把普通变量名 captcha 误判
const CAPTCHA_DOMAINS = [
  'hcaptcha.com',
  'google.com/recaptcha',
  'recaptcha.net',
  'challenges.cloudflare.com',
  'geetest.com',
  'challenge-platform',
]

// 验证 token 的请求字段名：出现即说明该页面向后端提交了人机验证结果
const CAPTCHA_FIELDS = [
  'turnstiletoken',
  'captchatoken',
  'cf-turnstile-response',
  'h-captcha-response',
  'g-recaptcha-response',
]

const detectCaptcha = (sources) => {
  const joined = sources.join('\n').toLowerCase()
  return {
    domains: CAPTCHA_DOMAINS.filter((d) => joined.includes(d)),
    fields: CAPTCHA_FIELDS.filter((f) => joined.includes(f)),
  }
}

// ============ 主流程 ============
const analyze = async () => {
  log(`=== GLaDOS 协议一致性检查 (${DOMAIN}) ===`)

  const pageHtml = await fetchText(`https://${DOMAIN}/console/checkin`)
  log(`页面获取成功: ${pageHtml.length} 字符`)

  const chunkPaths = [...new Set(pageHtml.match(/\/static\/js\/[A-Za-z0-9~._-]+\.chunk\.js/g) || [])]
  if (!chunkPaths.length) throw new Error('未在页面中找到任何 chunk，页面结构可能已变化')
  log(`发现 ${chunkPaths.length} 个 chunk，开始下载`)

  const sources = await pool(chunkPaths, 6, async (path) => {
    try {
      return await fetchText(`https://${DOMAIN}${path}`, 30000)
    } catch (err) {
      log(`  ! ${path} 下载失败: ${err.message}`)
      return ''
    }
  })

  const downloaded = sources.filter(Boolean)
  log(`成功下载 ${downloaded.length}/${chunkPaths.length} 个 chunk`)

  const salt = pickSalt(collectSalts(downloaded), downloaded)
  const endpoints = collectEndpoints(downloaded)
  const missingTokens = checkTokens(downloaded)
  const captcha = detectCaptcha(downloaded)

  return { salt, endpoints, missingTokens, captcha, chunkCount: chunkPaths.length }
}

const loadBaseline = () => {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    return null
  }
}

const saveBaseline = (data) => {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true })
  const payload = { ...data, checkedAt: new Date().toISOString() }
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  log(`基线已写入: ${BASELINE_PATH}`)
}

const writeSummary = (lines) => {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  try {
    writeFileSync(target, lines.join('\n') + '\n', { flag: 'a' })
  } catch {
    /* 非 Actions 环境忽略 */
  }
}

const sameSet = (a, b) => {
  const x = [...a].sort().join('|')
  const y = [...b].sort().join('|')
  return x === y
}

const diffSet = (oldArr, newArr) => ({
  added: newArr.filter((v) => !oldArr.includes(v)),
  removed: oldArr.filter((v) => !newArr.includes(v)),
})

const run = async () => {
  const current = await analyze()
  const baseline = loadBaseline()

  log('')
  log(`盐: ${current.salt ?? '未提取到'}`)
  log(`端点数: ${current.endpoints.length} -> ${current.endpoints.join(', ') || '无'}`)
  log(`缺失关键字段: ${current.missingTokens.length ? current.missingTokens.join(', ') : '无'}`)
  log(`第三方验证域名: ${current.captcha.domains.join(', ') || '未发现'}`)
  log(`验证 token 字段: ${current.captcha.fields.join(', ') || '未发现'}`)

  if (UPDATE || !baseline) {
    saveBaseline({
      salt: current.salt,
      endpoints: current.endpoints,
      captcha: current.captcha,
    })
    log(UPDATE ? '已按当前状态更新基线' : '未找到基线，已自动创建初始基线')
    writeSummary([
      '## 协议检查：已建立基线',
      '',
      `- 盐：\`${current.salt}\``,
      `- 端点：\`${current.endpoints.join(', ')}\``,
      `- 验证域名：${current.captcha.domains.join(', ') || '无'}`,
      `- 验证字段：${current.captcha.fields.join(', ') || '无'}`,
    ])
    return 0
  }

  const issues = []

  if (current.salt !== baseline.salt) {
    issues.push({
      level: 'critical',
      text: `proof 盐变更：\`${baseline.salt}\` → \`${current.salt}\``,
      action: '签到必然失败，需重新逆向 proof 算法',
    })
  }

  const epDiff = diffSet(baseline.endpoints || [], current.endpoints)
  if (epDiff.added.length || epDiff.removed.length) {
    issues.push({
      level: 'critical',
      text: `签到端点变更：移除 [${epDiff.removed.join(', ') || '无'}] 新增 [${epDiff.added.join(', ') || '无'}]`,
      action: '检查请求路径是否需要调整',
    })
  }

  if (current.missingTokens.length) {
    issues.push({
      level: 'warning',
      text: `协议字段消失：${current.missingTokens.join(', ')}`,
      action: '字段可能被重命名，提交体需要同步修改',
    })
  }

  const baseCaptcha = Array.isArray(baseline.captcha)
    ? { domains: baseline.captcha, fields: [] }
    : baseline.captcha || { domains: [], fields: [] }

  const newDomains = current.captcha.domains.filter((d) => !baseCaptcha.domains.includes(d))
  const newFields = current.captcha.fields.filter((f) => !(baseCaptcha.fields || []).includes(f))
  if (newDomains.length || newFields.length) {
    issues.push({
      level: 'critical',
      text: `新增人机验证：域名 [${newDomains.join(', ') || '无'}] 字段 [${newFields.join(', ') || '无'}]`,
      action: '签到可能需要附带验证 token，纯脚本方案可能失效',
    })
  }

  if (current.salt == null) {
    issues.push({
      level: 'warning',
      text: '未能从 bundle 中提取到盐（可能整体改为服务端下发）',
      action: '人工确认前端实现是否改变',
    })
  }

  log('')
  if (!issues.length) {
    log('结论: PASS —— 协议与基线一致')
    writeSummary([
      '## 协议检查：通过',
      '',
      `- 盐：\`${current.salt}\``,
      `- 端点：${current.endpoints.length} 个，与基线一致`,
      `- 人机验证：无新增`,
      `- 检查时间：${new Date().toISOString()}`,
    ])
    return 0
  }

  log(`结论: ${issues.filter((i) => i.level === 'critical').length ? 'FAIL' : 'WARN'} —— 发现 ${issues.length} 项变化`)
  for (const issue of issues) {
    log(`  [${issue.level.toUpperCase()}] ${issue.text}`)
    log(`    处理建议: ${issue.action}`)
  }

  writeSummary([
    `## 协议检查：发现 ${issues.length} 项变化`,
    '',
    '| 级别 | 变化 | 处理建议 |',
    '|---|---|---|',
    ...issues.map((i) => `| ${i.level} | ${i.text} | ${i.action} |`),
    '',
    `检查时间：${new Date().toISOString()}`,
  ])

  const hasCritical = issues.some((i) => i.level === 'critical')
  if (SOFT) {
    log('宽松模式：不阻断后续签到，仅告警')
    return 0
  }
  return hasCritical ? 1 : 0
}

run()
  .then((code) => {
    if (code !== 0) {
      console.error('\n协议已变化，签到逻辑需要更新。')
    }
    process.exit(code)
  })
  .catch((err) => {
    console.error(`协议检查执行失败: ${err.message}`)
    if (SOFT) {
      console.log('宽松模式：检查本身失败不阻断签到')
      process.exit(0)
    }
    process.exit(1)
  })
