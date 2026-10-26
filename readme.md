# Checkin

GitHub Actions 实现 [GLaDOS][glados] 自动签到

([GLaDOS][glados] 可用邀请码: `MW4DK-O0RSF-C7AOU-EN1MP`, 双方都有奖励天数)

## 使用说明

1. Fork 这个仓库

1. 登录 [GLaDOS][glados] 获取 Cookie

1. 添加 Cookie 到 Secret `GLADOS`,cookie格式 gld:sess.sig=对应的值; gld:sess=对应的值; koa:sess.sig=对应的值; koa:sess=对应的值
   
1. cookie获取，浏览器按f12存储里面就是，四个都要带上

1. 添加同一浏览器的浏览器代理到 Secret `GLADOS_UA` (浏览器控制台执行 `navigator.userAgent` 获取)

    - GLaDOS 签到会校验当前浏览器是否与登录时一致, UA 不一致会返回 `没有权限`
    - 浏览器大版本更新后 UA 会变化, 如再次报错需重新登录并同时更新 `GLADOS` 与 `GLADOS_UA`

1. 启用 Actions, 每天北京时间 00:10 自动签到
1. 添加了workflow控制台显示每个账号当前积分的功能和当前积分通知推送(积分兑换时可能显示原天数，第二次签到就显示已经兑换的新天数)
1. 已实现自定义签到域名，在环境机密中加入 DOMAIN railgun.info
1. 添加了满500积分自动兑换天数，默认是500积分自动兑换，需要调整可以新增Action环境变量机密，参数为下

| 变量 | 默认值 | 说明 |
| ---- | ---- | ---- |
| AUTO_EXCHANGE | false | 自动兑换开关，false=关闭自动兑换 |
| EXCHANGE_THRESHOLD | 500 | 兑换触发阈值 |



## 高级功能

1. 如有多个帐号, 可以写为多行 Secret `GLADOS`, 每行写一个 Cookie; `GLADOS_UA` 可同样按行对应, 只写一行则所有帐号共用

1. 如需修改时间, 可以修改文件 [run.yml](.github/workflows/run.yml#L7) 中的 `cron` 参数, 格式可参考 [crontab]

1. 如需其他域名, 可配置 Secret `DOMAIN`, 可填写: `railgun.info`

1. 如需推送通知, 可配置 Secret `NOTIFY`, 已支持:
    1. [WxPusher][wxpusher]: 格式 `wxpusher:{token}:{uid}`
    1. [PushPlus][pushplus]: 格式 `pushplus:{token}`
    1. [Bark][finbbark]: 格式 `bark:{key}`
    1. [企业微信][qyweixin]: 格式 `qyweixin:{key}`
    1. Console: 格式 `console:log`, 作为日志输出, 一般用于调试
    1. 如需配置多个, 可以写为多行, 每行写一个

1. 注意: Cookie 以及接口输出数据, 包含帐号敏感信息, 因此不要随意公开

---

[glados]: https://github.com/glados-network/GLaDOS
[crontab]: https://crontab.guru/
[pushplus]: https://www.pushplus.plus/
[wxpusher]: https://wxpusher.zjiecode.com/
[finbbark]: https://github.com/Finb/Bark
[qyweixin]: https://developer.work.weixin.qq.com/document/path/91770
