var dsh_connect_sensenova_token_plan_client = (function() {

//#region \0rolldown/runtime.js
	var __esmMin = (fn, res, err) => () => {
		if (err) throw err[0];
		try {
			return fn && (res = fn(fn = 0)), res;
		} catch (e) {
			throw err = [e], e;
		}
	};
	var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);

//#endregion
//#region src/client/const.ts
	var NS, PANEL_ID, SNAPSHOT_PATH, ACCOUNT_PATH, API_KEY_PATH, PROVIDER_PATH, MODELS_PATH, DRAW_PATH, RACCOON_PATH, SENSENOVA_SIGNUP_URL, RACCOON_SITE_URL;
	var init_const = __esmMin((() => {
		NS = "dsh-connect-sensenova-token-plan";
		PANEL_ID = NS;
		SNAPSHOT_PATH = `/api/${NS}/snapshot`;
		ACCOUNT_PATH = `/api/${NS}/account`;
		API_KEY_PATH = `/api/${NS}/api-key`;
		PROVIDER_PATH = `/api/${NS}/provider`;
		MODELS_PATH = `/api/${NS}/models`;
		DRAW_PATH = `/api/${NS}/draw`;
		RACCOON_PATH = `/api/${NS}/raccoon`;
		SENSENOVA_SIGNUP_URL = "https://www.sensenova.cn/token-plan";
		RACCOON_SITE_URL = "https://xiaohuanxiong.com/";
	}));

//#endregion
//#region src/client/i18n.ts
	var zh, en;
	var init_i18n = __esmMin((() => {
		zh = {
			"panel.title": "商汤 Token Plan 接入全家桶",
			"panel.back": "返回会话",
			"panel.refresh": "刷新",
			"panel.updated": "更新于 {time}",
			"panel.loading": "加载中…",
			"panel.error": "读取失败：{error}",
			"panel.jwtMissing": "还没有配置控制台账号。",
			"panel.jwtExpired": "控制台令牌已失效，且无法用已保存的 refresh_token 续期。请重新登录一次。",
			"panel.configError": "插件配置有误：{error}",
			"panel.consoleTransient": "商汤控制台暂时无法读取，通常下一次自动刷新即可恢复；若持续出现，请检查网络后稍再重试。",
			"panel.shapeDrift": "上游返回的结构可能有变：{detail}",
			"auth.title": "连接商汤控制台",
			"auth.registerHint": "还没有账号？前往官网注册，免费开通 Token Plan 额度 →",
			"auth.portalHint": "前往官网管理额度 / 获取 API Key →",
			"auth.username": "账号",
			"auth.password": "密码",
			"auth.show": "显示",
			"auth.hide": "隐藏",
			"auth.placeholderUser": "登录 platform.sensenova.cn 的账号",
			"auth.submit": "登录",
			"auth.submitting": "登录中…",
			"auth.working": "已保存并登录，正在读取额度…",
			"auth.forget": "清除已保存的账号",
			"auth.forgotten": "已清除账号（当前令牌仍可用）",
			"auth.saved": "账号与登录令牌已保存在 DSH 凭据中；密码不落盘，refresh 令牌失效后需重新输入一次。",
			"auth.ephemeral": "注意：当前 Host 没有凭据服务，账号只保存在内存中，重启后需要重新登录。",
			"auth.autoRecoverOn": "账号与登录令牌已保存在 DSH 凭据中；自动恢复已开启（环境已备密码 SENSENOVA_PASSWORD），令牌失效后会自动重登，无需手动输入。",
			"auth.badCredentials": "账号或密码不正确",
			"auth.locked": "账号已被锁定，请在商汤控制台用手机号验证或联系客服解锁。",
			"auth.retryAfter": "平台要求等待约 {minutes} 分钟后再试；等待期间面板不会自动重试，避免再次触发锁定。",
			"auth.rateLimited": "尝试过于频繁，请稍后再试。",
			"auth.verification": "需要额外验证（短信/图形验证码），自动化登录无法完成，请先在浏览器登录一次。",
			"auth.failed": "登录未完成：{reason}",
			"auth.empty": "请填写账号和密码",
			"auth.network": "无法连接本机 Host",
			"section.pools": "积分池",
			"pool.window5h": "5 小时",
			"pool.window7d": "每周",
			"pool.used": "已用",
			"pool.remaining": "剩余",
			"pool.exhausted": "已耗尽",
			"pool.exhaustedNotice": "部分积分池已耗尽（剩余 0），最早于 {time} 重置；所属模型在额度恢复前暂不可选。",
			"pool.reset": "重置 {time}",
			"pool.grant": "返赠余额 {balance}",
			"pool.grantExpiry": "最近返赠到期 {time}（{balance} 分）",
			"pool.models": "模型",
			"pool.dedicated": "专属池",
			"pool.default": "通用池",
			"pool.callable": "可调用",
			"pool.details": "模型与返赠详情",
			"pool.locked": "需开通 +{count} 个",
			"pool.uncounted": "不计入积分池：{models}",
			"pool.vision": "可看图：{models}",
			"pool.visionInferred": "（按模型名推断，平台未声明）",
			"shape.api": "接口",
			"shape.missing": "缺少字段",
			"section.trend": "每模型消耗（近 {hours} 小时 · 缓存 {cache} 秒）",
			"section.collapse": "收起",
			"section.expand": "展开",
			"trend.model": "模型",
			"trend.credits": "积分",
			"trend.none": "该区间内没有消耗记录。",
			"trend.legend": "柱长按最高消耗相对显示，非占总额度比例；消耗不足最高值 1% 的行不画柱。",
			"trend.multiplierLegend": "×N 为插件配置的自定义倍率（非官方数据），仅供跨模型对比；未标注的模型没有配置倍率。",
			"llm.contextBadge": "{ctx} 上下文",
			"auth.selfRenew": "令牌自动续期中",
			"auth.needsLogin": "需要重新登录",
			"llm.title": "API Key",
			"llm.providerTitle": "语言模型",
			"llm.keyField": "API Key",
			"llm.keyEditor": "更换 / 清除 API Key",
			"llm.placeholder": "粘贴 sk- 开头的 API Key",
			"llm.save": "保存 API Key",
			"llm.saving": "保存中…",
			"llm.forget": "清除已保存的 API Key",
			"llm.saved": "API Key 已保存在 DSH 凭据中；下次轮询自动拉取模型目录。",
			"llm.forgotten": "已清除面板保存的 API Key（环境变量 SENSENOVA_API_KEY 不受影响）。",
			"llm.empty": "请输入 sk- 开头的 API Key",
			"llm.footnote": "Key 只保存在 DSH 凭据中，不会写入插件目录或日志；请求时按次读取。",
			"llm.keyRegisterHint": "还没有 API Key？前往官网免费获取 →",
			"llm.keyManageHint": "前往官网管理额度 →",
			"llm.ephemeral": "注意：当前 Host 没有凭据服务，Key 只保存在内存中，重启后失效。",
			"llm.keyPresent": "已配置（来源：{source}）",
			"llm.noKey": "尚未配置——在上方粘贴 sk- Key 并保存。",
			"llm.src.credentials": "DSH 凭据",
			"llm.src.env": "环境变量 SENSENOVA_API_KEY",
			"llm.src.memory": "本机内存",
			"llm.off": "未向 DSH 注册——勾选上方开关即可开启（id：{id}）。",
			"llm.registeredPending": "开关已开但注册尚未生效（id：{id}）——等待下一次自动刷新；若持续未注册，检查 Host 日志。",
			"llm.registered": "已注册 {id}：{models} 个模型，{vision} 个支持图片输入。",
			"llm.noService": "registerProvider 已开启，但当前 Host 没有提供 LLM 注册服务。",
			"llm.error": "提供方注册失败：{error}",
			"llm.id": "提供方 ID：{id}（勾选开关后生效）",
			"llm.switch": "向 DSH 注册",
			"llm.switchTitle": "开启后立刻向 DSH 注册 SenseNova 提供方（无需重启）；关闭则从模型下拉框移除，已保存的设置保留。",
			"llm.switchBusy": "切换中…",
			"llm.switchError": "切换失败：{error}",
			"llm.roster": "推送到 DSH 的模型",
			"llm.rosterHint": "勾选决定哪些模型推送进 DSH 模型列表；目录新增的模型默认不推送。",
			"llm.rosterEmpty": "还没有可推送的模型——先在「API Key」卡片保存一次 Key 再回来。",
			"llm.rosterSearchPlaceholder": "搜索模型名或 ID",
			"llm.rosterCount": "已勾选 {selected} / 共 {total}",
			"llm.rosterAll": "全部勾选",
			"llm.rosterNone": "全部取消",
			"llm.rosterSave": "保存",
			"llm.rosterSaving": "保存中…",
			"llm.rosterDiscard": "撤销",
			"llm.rosterSaved": "已保存，模型列表已更新。",
			"llm.rosterUnsaved": "有未保存的改动",
			"llm.rosterError": "保存失败：{error}",
			"llm.rosterNoMatch": "没有匹配的模型。",
			"llm.rosterVision": "可看图",
			"llm.rosterExhausted": "额度耗尽",
			"llm.rosterRateTitle": "积分消耗伪倍率（自定义对比用，非官方）",
			"llm.metaOutput": "最大输出 {out}",
			"llm.metaLevels": "思考 {levels}",
			"llm.rosterThinkingDefault": "思考强度默认 {level}",
			"llm.level.off": "关闭",
			"llm.level.minimal": "微量",
			"llm.level.low": "低",
			"llm.level.medium": "中",
			"llm.level.high": "高",
			"llm.level.xhigh": "极高",
			"llm.level.max": "最高",
			"draw.title": "出图工具",
			"draw.switch": "注册出图工具",
			"draw.switchTitle": "开启后 Host 给 agent 注册 sensenova_draw_image 工具。开关值立即生效，但工具的实际挂载/缺席发生在下一次 Host 启动。",
			"draw.switchBusy": "切换中…",
			"draw.switchError": "切换失败：{error}",
			"draw.on": "agent 可用{model}生成图片。",
			"draw.onList": "agent 出图将使用以下模型：",
			"draw.badge": "出图",
			"draw.badgeNone": "暂无可选模型",
			"draw.badgeAuto": "{badge} · 自动选择",
			"draw.badgePinned": "{badge} · 配置已指定",
			"draw.candidates": "共 {count} 个出图模型",
			"draw.autoOption": "自动选择（目录第一个出图模型）",
			"draw.effective": "当前生效",
			"draw.off": "未注册——勾选上方开关即可开启。",
			"draw.noTools": "drawEnabled 已开启，但当前 Host 没有提供 agent tools 注册服务，工具静默缺席。",
			"draw.noToolsPeer": "drawEnabled 已开启，但 agent tools 插件包加载失败，出图工具缺席（Host 问题，非配置）。",
			"draw.noToolsRefused": "drawEnabled 已开启，但工具注册被 Host 拒绝，出图工具缺席（Host 问题，非配置）。",
			"draw.needsKey": "尚未配置 API Key；保存后即可出图。",
			"draw.noCandidates": "当前 API Key 目录里暂无出图模型；出图不可用。",
			"draw.modelFallback": "第一个可用模型",
			"tab.quota": "积分额度",
			"tab.api": "接入 API",
			"tab.raccoon": "小浣熊",
			"raccoon.title": "小浣熊（商汤）",
			"raccoon.desc": "接入 xiaohuanxiong.com 网关：微信扫码登录，模型经 DSH 提供方注册后可对话。与积分池相互独立。",
			"raccoon.clientLink": "下载商汤小浣熊客户端，领取限时积分 →",
			"raccoon.switch": "启用小浣熊提供方",
			"raccoon.switchTitle": "开启后向 DSH 注册小浣熊的模型；关闭则从模型下拉框移除，登录与勾选设置都保留，重新开启即恢复。",
			"raccoon.webSearch": "启用联网搜索（小浣熊）",
			"raccoon.webSearchTitle": "开启后 DSH 的联网搜索工具改用小浣熊凭据搜索，不需要你再给搜索端点配 key；前提是小浣熊已登录。",
			"raccoon.switchBusy": "切换中…",
			"raccoon.switchError": "切换失败：{error}",
			"raccoon.webSearchError": "联网搜索开关失败：{error}",
			"raccoon.login": "微信扫码登录",
			"raccoon.loggingIn": "等待扫码确认…",
			"raccoon.logout": "退出登录",
			"raccoon.loggedIn": "已登录：{nick}",
			"raccoon.loggedInPlain": "已登录",
			"raccoon.expired": "登录已过期：{nick}——凭据已失效，请重新扫码登录。",
			"raccoon.expiredPlain": "登录已过期——凭据已失效，请重新扫码登录。",
			"raccoon.reLogin": "重新登录",
			"raccoon.notLogged": "未登录——请先微信扫码。",
			"raccoon.balance": "积分余额 {balance}",
			"raccoon.balanceUnknown": "积分余额 未知",
			"raccoon.balanceUnknownDetail": "积分余额 未知——{detail}",
			"raccoon.partNameDaily": "每日",
			"raccoon.partNameReward": "奖励",
			"raccoon.partNameMonthly": "月度",
			"raccoon.partNameTopup": "充值",
			"raccoon.expiresAt": "凭据有效至 {date}",
			"raccoon.refreshUntil": "续期至 {date}",
			"raccoon.refreshTip": "{days} 天内免重扫",
			"raccoon.models": "模型（{count}）",
			"raccoon.modelsFallback": "网关目录暂不可读——以下为内置备用模型",
			"raccoon.modelsEmpty": "网关当前没有开放可见模型——以下为内置备用模型",
			"raccoon.pushHint": "勾选决定哪些模型推送进 DSH 模型列表，改动即时生效",
			"raccoon.registeredChip": "已注册",
			"raccoon.unregisteredChip": "未注册",
			"raccoon.modelsSaved": "已保存",
			"raccoon.modelsError": "保存失败：{error}",
			"raccoon.free": "free",
			"raccoon.rateTitle": "网关目录声明的积分倍率（0 为免费）",
			"raccoon.limitedFree": "限时免费",
			"raccoon.discount": "限时折扣",
			"raccoon.promoRateTitle": "当前 {effective}（原价 {original}）{note}",
			"raccoon.unregistered": "未注册——勾选上方开关即可开启。",
			"raccoon.awaitingLogin": "已启用——登录后即可注册模型。",
			"raccoon.loginTimeout": "扫码超时（未在时限内确认）——请重新点击登录。",
			"raccoon.loginCanceled": "扫码已取消——请重新点击登录。",
			"raccoon.loginFailed": "登录未能保存：{error}",
			"raccoon.error": "小浣熊操作失败：{error}"
		};
		en = {
			"panel.title": "SenseNova Token Plan Connect",
			"panel.back": "Back to conversation",
			"panel.refresh": "Refresh",
			"panel.updated": "Updated {time}",
			"panel.loading": "Loading…",
			"panel.error": "Could not read: {error}",
			"panel.jwtMissing": "No SenseNova console account is configured yet.",
			"panel.jwtExpired": "The console token is no longer valid and could not be renewed from the stored refresh_token. Sign in again.",
			"panel.configError": "The plugin is misconfigured: {error}",
			"panel.consoleTransient": "The SenseNova console could not be read just now. This usually clears on the next automatic refresh; if it persists, check your network and try again shortly.",
			"panel.shapeDrift": "The upstream payload shape may have changed: {detail}",
			"auth.title": "Connect the SenseNova console",
			"auth.registerHint": "No account yet? Register on the official site for a free Token Plan quota →",
			"auth.portalHint": "Manage quota / get API keys on the official site →",
			"auth.username": "Username",
			"auth.password": "Password",
			"auth.show": "Show",
			"auth.hide": "Hide",
			"auth.placeholderUser": "Your platform.sensenova.cn account",
			"auth.submit": "Sign in",
			"auth.submitting": "Signing in…",
			"auth.working": "Saved and signed in; reading quota…",
			"auth.forget": "Forget the saved account",
			"auth.forgotten": "Account cleared (the current token still works)",
			"auth.saved": "Account and login token stored in the DSH credentials; the password is never written to disk — you'll be asked to sign in again once the refresh token dies.",
			"auth.ephemeral": "Note: this Host has no credentials service, so the account lives in memory only and must be entered again after a restart.",
			"auth.autoRecoverOn": "Account and login token saved in DSH credentials; auto-recovery is on (an environment password SENSENOVA_PASSWORD is present), so a dead token re-signs in automatically.",
			"auth.badCredentials": "That username or password is not right",
			"auth.locked": "This account is locked. Verify by phone in the SenseNova console or contact support to unlock it.",
			"auth.retryAfter": "The platform asks to wait about {minutes} more minutes. The panel will not retry on its own during that window, so the lock is not extended.",
			"auth.rateLimited": "Too many attempts. Wait a moment and try again.",
			"auth.verification": "This sign-in needs an extra step (SMS or captcha) that automation cannot complete. Sign in once in a browser first.",
			"auth.failed": "Sign-in did not complete: {reason}",
			"auth.empty": "Enter a username and a password",
			"auth.network": "Could not reach the local Host",
			"section.pools": "Credit pools",
			"pool.window5h": "5 hours",
			"pool.window7d": "Weekly",
			"pool.used": "Used",
			"pool.remaining": "Remaining",
			"pool.exhausted": "Exhausted",
			"pool.exhaustedNotice": "Some credit pools are exhausted (0 remaining); the earliest resets at {time}. Models in those pools are unavailable until quota recovers.",
			"pool.reset": "resets {time}",
			"pool.grant": "Grant balance {balance}",
			"pool.grantExpiry": "Next grant expiry {time} ({balance} cr)",
			"pool.models": "Models",
			"pool.dedicated": "dedicated",
			"pool.default": "default",
			"pool.callable": "Callable",
			"pool.details": "Models & grant details",
			"pool.locked": "+{count} need activation",
			"pool.uncounted": "Not billed to credit pools: {models}",
			"pool.vision": "Vision-capable: {models}",
			"pool.visionInferred": "(inferred from model names; not declared by the platform)",
			"shape.api": "endpoint",
			"shape.missing": "missing field",
			"section.trend": "Per-model consumption (last {hours} h · cached {cache} s)",
			"section.collapse": "Collapse",
			"section.expand": "Expand",
			"trend.model": "Model",
			"trend.credits": "Credits",
			"trend.none": "No consumption in this range.",
			"trend.legend": "Bars are scaled relative to the top consumer, not to the total quota; rows below 1% of the top figure draw no bar.",
			"trend.multiplierLegend": "×N marks a custom multiplier configured in the plugin (not official data), for cross-model comparison only; unlabelled models have no configured multiplier.",
			"llm.contextBadge": "{ctx} context",
			"auth.selfRenew": "Token renews itself",
			"auth.needsLogin": "Sign-in required",
			"llm.title": "API key",
			"llm.providerTitle": "Language models",
			"llm.keyField": "API key",
			"llm.keyEditor": "Change / clear the API key",
			"llm.placeholder": "Paste your sk- API key",
			"llm.save": "Save API key",
			"llm.saving": "Saving…",
			"llm.forget": "Forget the saved API key",
			"llm.saved": "API key stored in the DSH credentials; the next poll fetches the model catalog.",
			"llm.forgotten": "Panel-saved API key cleared (an SENSENOVA_API_KEY environment value is left untouched).",
			"llm.empty": "Enter an API key starting with sk-",
			"llm.footnote": "The key is kept only in the DSH credentials, never in this plugin's folder or logs; it is read per request.",
			"llm.keyRegisterHint": "No API key yet? Get a free one on the official site →",
			"llm.keyManageHint": "Manage quota on the official site →",
			"llm.ephemeral": "Note: this Host has no credentials service, so the key lives in memory only and is lost on restart.",
			"llm.keyPresent": "Configured (source: {source})",
			"llm.noKey": "Not configured — paste an sk- key above and save.",
			"llm.src.credentials": "DSH credentials",
			"llm.src.env": "environment SENSENOVA_API_KEY",
			"llm.src.memory": "memory",
			"llm.off": "Not registered with DSH — tick the switch above (id: {id}).",
			"llm.registeredPending": "Switch is on but registration has not landed yet (id: {id}) — wait for the next automatic refresh; if it persists, check the Host logs.",
			"llm.registered": "Registered {id}: {models} model(s), {vision} with image input.",
			"llm.noService": "registerProvider is on, but this Host exposes no LLM registration service.",
			"llm.error": "Provider registration failed: {error}",
			"llm.id": "Provider id: {id} (takes effect once the switch is ticked)",
			"llm.switch": "Register with DSH",
			"llm.switchTitle": "On registers the SenseNova provider with DSH at once (no restart); off removes it from the model picker while saved settings stay.",
			"llm.switchBusy": "Switching…",
			"llm.switchError": "Switch failed: {error}",
			"llm.roster": "Models pushed to DSH",
			"llm.rosterHint": "Ticking decides which models are pushed into DSH's model list; models the catalogue gains later are not pushed by default.",
			"llm.rosterEmpty": "No models to push yet - save a key in the API key card first.",
			"llm.rosterSearchPlaceholder": "Search a model name or id",
			"llm.rosterCount": "{selected} ticked / {total} total",
			"llm.rosterAll": "Tick all",
			"llm.rosterNone": "Untick all",
			"llm.rosterSave": "Save",
			"llm.rosterSaving": "Saving…",
			"llm.rosterDiscard": "Discard",
			"llm.rosterSaved": "Saved - the model list has been updated.",
			"llm.rosterUnsaved": "Unsaved changes",
			"llm.rosterError": "Save failed: {error}",
			"llm.rosterNoMatch": "No model matches.",
			"llm.rosterVision": "vision",
			"llm.rosterExhausted": "quota exhausted",
			"llm.rosterRateTitle": "Pseudo credit multiplier (custom comparison aid, not official)",
			"llm.metaOutput": "max output {out}",
			"llm.metaLevels": "thinking {levels}",
			"llm.rosterThinkingDefault": "thinking default {level}",
			"llm.level.off": "off",
			"llm.level.minimal": "minimal",
			"llm.level.low": "low",
			"llm.level.medium": "medium",
			"llm.level.high": "high",
			"llm.level.xhigh": "xhigh",
			"llm.level.max": "max",
			"draw.title": "Draw tool",
			"draw.switch": "Register the draw tool",
			"draw.switchTitle": "On registers sensenova_draw_image for the agent. The switch value takes effect at once, but the tool mounts/absents at the next Host start.",
			"draw.switchBusy": "Switching…",
			"draw.switchError": "Switch failed: {error}",
			"draw.on": "The agent can generate images with {model}.",
			"draw.onList": "Draw calls will use the model below:",
			"draw.badge": "image",
			"draw.badgeNone": "no model available yet",
			"draw.badgeAuto": "{badge} · auto-picked",
			"draw.badgePinned": "{badge} · pinned in config",
			"draw.candidates": "{count} image-capable model(s)",
			"draw.autoOption": "Auto — first image-capable model in the catalogue",
			"draw.effective": "active",
			"draw.off": "Not registered — tick the switch above.",
			"draw.noTools": "drawEnabled is on, but this Host exposes no agent tools service; the tool is silently absent.",
			"draw.noToolsPeer": "drawEnabled is on, but the agent tools peer module failed to load; the draw tool is absent (a Host fault, not config).",
			"draw.noToolsRefused": "drawEnabled is on, but the Host refused the tool registration; the draw tool is absent (a Host fault, not config).",
			"draw.needsKey": "No API key yet; save one to start generating images.",
			"draw.noCandidates": "This API key's catalogue has no image model; drawing is unavailable.",
			"draw.modelFallback": "the first available model",
			"tab.quota": "Quota & Usage",
			"tab.api": "API Integration",
			"tab.raccoon": "Raccoon",
			"raccoon.title": "Raccoon (SenseNova)",
			"raccoon.desc": "Connects the xiaohuanxiong.com gateway: WeChat QR sign-in, models registered with DSH. Independent of the credit pools.",
			"raccoon.clientLink": "Download the SenseNova Raccoon client for limited-time credits →",
			"raccoon.switch": "Enable Raccoon provider",
			"raccoon.switchTitle": "On registers the Raccoon models with DSH; off removes them from the model picker while sign-in and curation stay, so re-enabling restores them.",
			"raccoon.webSearch": "Enable web search (Raccoon)",
			"raccoon.webSearchTitle": "On makes DSH's web search tool search through the Raccoon credential, so you no longer need a key for the search endpoint; Raccoon must be signed in.",
			"raccoon.webSearchError": "Web search switch failed: {error}",
			"raccoon.switchBusy": "Switching…",
			"raccoon.switchError": "Switch failed: {error}",
			"raccoon.login": "Sign in with WeChat QR",
			"raccoon.loggingIn": "Waiting for QR confirmation…",
			"raccoon.logout": "Sign out",
			"raccoon.loggedIn": "Signed in: {nick}",
			"raccoon.loggedInPlain": "Signed in",
			"raccoon.expired": "Session expired: {nick} — the credential is dead, scan the QR code again.",
			"raccoon.expiredPlain": "Session expired — the credential is dead, scan the QR code again.",
			"raccoon.reLogin": "Sign in again",
			"raccoon.notLogged": "Not signed in — scan the QR code first.",
			"raccoon.balance": "Balance {balance}",
			"raccoon.balanceUnknown": "Balance unknown",
			"raccoon.balanceUnknownDetail": "Balance unknown — {detail}",
			"raccoon.partNameDaily": "Daily",
			"raccoon.partNameReward": "Reward",
			"raccoon.partNameMonthly": "Monthly",
			"raccoon.partNameTopup": "Top-up",
			"raccoon.expiresAt": "Credential valid until {date}",
			"raccoon.refreshUntil": "Refresh until {date}",
			"raccoon.refreshTip": "No re-scan for {days} days",
			"raccoon.models": "Models ({count})",
			"raccoon.modelsFallback": "Live catalogue unreadable — showing the built-in roster",
			"raccoon.modelsEmpty": "The gateway offers no visible models right now — showing the built-in roster",
			"raccoon.pushHint": "Ticks decide which models are pushed into DSH's model list; changes apply immediately",
			"raccoon.registeredChip": "Registered",
			"raccoon.unregisteredChip": "Not registered",
			"raccoon.modelsSaved": "Saved",
			"raccoon.modelsError": "Save failed: {error}",
			"raccoon.free": "free",
			"raccoon.rateTitle": "Credit multiplier as declared by the gateway catalogue (0 = free)",
			"raccoon.limitedFree": "Free (limited time)",
			"raccoon.discount": "Discount (limited time)",
			"raccoon.promoRateTitle": "Current {effective} (list {original}){note}",
			"raccoon.unregistered": "Not registered — tick the switch above.",
			"raccoon.awaitingLogin": "Enabled — log in to register the models.",
			"raccoon.loginTimeout": "The scan timed out (no confirmation within the deadline) — start it again.",
			"raccoon.loginCanceled": "The scan was canceled — start it again.",
			"raccoon.loginFailed": "Sign-in could not be saved: {error}",
			"raccoon.error": "Raccoon operation failed: {error}"
		};
	}));

//#endregion
//#region src/client/format.ts
/** Time and number formatters. */
	/**
	* A Host-STATED cadence in seconds, as the milliseconds `setInterval` wants,
	* or `fallbackMs` when the answer carried no usable number.
	*
	* The stated value is passed through as-is once it is a usable number: the
	* Host owns the number, it knows the gateway budget behind it (its own scan
	* poll is 2 s) and it knows its cache windows, so a second opinion here would
	* be the very drift this helper exists to prevent. The one shape kept away
	* from the timer is a value that would become a busy loop or a nonsense
	* interval — a non-number (`NaN`, a string, a missing or non-positive field)
	* falls back, and a sub-second value rounds up to a whole 1 s rather than
	* flooring to `0` (which `setInterval` reads as "as fast as possible").
	*/
	function statedCadenceMs(seconds, fallbackMs) {
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
		return Math.max(1, Math.floor(seconds)) * 1e3;
	}
	/** `HH:MM` for one epoch second. */
	function clock(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/** `MM-DD HH:mm` for one epoch second. */
	function clockLong(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	/**
	* A date-aware reset clock: `HH:MM` when the instant lands on today's local
	* date, `MM-DD HH:mm` once it crosses into another day.
	*
	* Why this exists: `clock` was the one shared formatter, so the weekly
	* (`window_7d`) reset — an absolute instant days away — read as "重置 18:10"
	* and looked like it fired later TODAY. A bare time is honest only for the
	* 5-hour window; a reset that crosses midnight must carry its day.
	*/
	function when(epoch) {
		if (typeof epoch !== "number" || !Number.isFinite(epoch) || epoch <= 0) return "—";
		const date = /* @__PURE__ */ new Date(epoch * 1e3);
		const now = /* @__PURE__ */ new Date();
		return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate() ? clock(epoch) : clockLong(epoch);
	}
	/**
	* A credit figure as text: 2-decimal precision under 10 000, whole with
	* thousands separators at or above it. The switch is deliberate — a pool
	* limit of 60 000 reads as "60,000", a live balance of 47.5 as "47.5".
	*/
	function count(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
		if (number >= 1e4) return Math.round(number).toLocaleString();
		return String(Math.round(number * 100) / 100);
	}
	/** Fill a `{token}` template from a dictionary entry. */
	function format(template, vars) {
		let text = template;
		for (const [key, value] of Object.entries(vars || {})) text = text.split(`{${key}}`).join(String(value));
		return text;
	}
	/**
	* A caught value as the one error string the panel shows.
	*
	* Every mutation surface (`ModelPicker`, `ProviderControls`, `RaccoonTab`)
	* ends a `catch` with the same `why instanceof Error ? why.message : String(why)`
	* template, and there were eight copies of it. That is the same drift the HTTP
	* seam in `http.ts` was extracted to stop: a copy that handles a thrown string
	* but not a rejected `{code}` object prints `[object Object]` in the panel's
	* one error line, and no test catches it because each copy is trivial. One
	* definition, so a fix lands everywhere at once.
	* @param why - whatever the `catch` received.
	* @returns {string} the Error's message, the string itself, or a JSON-ish
	*   rendering of a thrown object (never `[object Object]`).
	*/
	function errorText(why) {
		if (why instanceof Error) return why.message;
		if (typeof why === "string") return why;
		if (why === null || why === void 0) return String(why);
		try {
			return JSON.stringify(why) ?? String(why);
		} catch {
			return String(why);
		}
	}
	/**
	* A token count the way the platform names it: 1048576 → "1M", 65536 → "64K",
	* 128000 → "128K". Returns "" for a figure that is not a positive number, so
	* an unknown value draws no segment instead of a zero.
	*
	* Why two bases: the catalogue mixes them — windows and ceilings arrive as
	* powers of two (1048576), while the plugin's own 128k fallback is the round
	* decimal 128 000. A flat /1000 rounding once printed "1049k" for the 1M
	* window and it read like a placeholder bug; so figures divisible by 1000 keep
	* the decimal reading they were written with, binary-only figures (262144 →
	* 256K, 65536 → 64K) get the binary one, and anything ≥ 1M goes to M.
	*/
	function tokenSize(value) {
		const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
		if (number <= 0) return "";
		if (number >= 1e6) return `${Math.round(number / 1e5) / 10}M`;
		if (number % 1e3 === 0) return `${number / 1e3}K`;
		if (number % 1024 === 0) return `${number / 1024}K`;
		return `${Math.round(number / 1e3)}K`;
	}
	var init_format = __esmMin((() => {}));

//#endregion
//#region src/client/http.ts
/** One POST with the panel's fixed request shape; the parsed body or null. */
	async function postRaw(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json"
			},
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		return {
			status: response.status,
			body
		};
	}
	/** POST and return the parsed body, or null when the response is not JSON. */
	function postJson(path, payload) {
		return postRaw(path, payload).then(({ body }) => body);
	}
	/** POST and demand `ok:true`; refuse by throwing the Host's own wording. */
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postRaw(path, payload);
		if (body === null || body.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
		return body;
	}
	var init_http = __esmMin((() => {}));

//#endregion
//#region src/client/runtime.ts
/**
	* A dictionary key built from a HOST-enumerated value.
	*
	* The families this builds (`llm.level.…`, `llm.src.…`) cannot be listed in
	* `zh` — the Host enumerates them — so the lookup has to widen past
	* compile-time sight. This is the ONE place that does it, so the escape is a
	* named helper rather than three scattered `as DictionaryKey` casts, and any
	* new family the Host adds has one obvious place to extend.
	*/
	function dictKey(family, value) {
		return `${family}.${value}`;
	}
	/** Hand the loader-provided React to the rest of the client. One-shot. */
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) throw new Error("client: the loader did not hand over a react module");
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	var api, h, useState, useEffect, useCallback, useMemo, useRef;
	var init_runtime = __esmMin((() => {
		api = null;
		h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
		useState = (initial) => reactApi().useState(initial);
		useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
		useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
		useMemo = (factory, deps) => reactApi().useMemo(factory, deps);
		useRef = (initial) => reactApi().useRef(initial);
	}));

//#endregion
//#region src/client/snapshot.ts
/**
	* Read one snapshot response into the (data, error) pair the panel renders.
	*
	* The Host answers HTTP 200 for every expected outcome and signals the
	* difference in the body: `ok:true` carries the numbers, `ok:false` carries
	* a code and — crucially — the `auth` block, so a panel that cannot reach
	* the console can still say whether its token will renew by itself.
	*
	* A named function at module scope, not inline branching, so the
	* Node-side tests can drive the panel's REAL reading of a response by
	* loading this bundle as a module (`client-surface.js`) — instead of a
	* hand-written copy that would drift the moment either side is edited.
	*/
	function interpretSnapshot(body) {
		const payload = body;
		if (payload && payload.ok === false) return {
			data: null,
			error: {
				message: payload.error || "unexpected payload",
				code: payload.code,
				auth: payload.auth ?? null
			}
		};
		if (!payload || payload.ok !== true) return {
			data: null,
			error: "unexpected payload"
		};
		return {
			data: payload,
			error: null
		};
	}
	/**
	* The failure a non-2xx snapshot response becomes.
	*
	* A non-2xx carries no body, so the status is the only clue. 401/403 mean
	* the token is gone — the same story as the Host's own `jwt_expired`, and
	* the only reading that keeps the sign-in form on screen instead of leaving
	* the reader with a bare status code. Anything else is a plain transport
	* string, which keeps the form reachable too.
	*
	* Named and module-scoped for the same reason as `interpretSnapshot`: the
	* Node-side tests drive this mapping instead of a copy of it.
	*/
	function errorOfStatus(status) {
		if (status === 401 || status === 403) return {
			message: `HTTP ${status}`,
			code: "jwt_expired",
			auth: null
		};
		return `HTTP ${status}`;
	}
	/**
	* The panel's decision: what this snapshot means for what to show.
	*
	* Deliberately a module-scope pure function in `(data, error, tt)`.
	* `PanelPage` calls it in the browser, and the Node-side tests call the
	* very same function after loading this bundle as a module (see
	* `client-surface.js`): no source text is copied or scraped, so the
	* tested logic and the running logic cannot drift apart.
	*/
	function viewOf(data, error, tt) {
		const failure = error === null || error === void 0 ? null : typeof error === "string" ? {
			message: error,
			code: null,
			auth: null
		} : error;
		const auth = data?.auth ?? failure?.auth ?? null;
		const needsSetup = data === null && !FORM_EXCLUDED_CODES.has(failure?.code ?? null);
		const guidanceKey = failure === null ? null : GUIDANCE_BY_CODE[failure.code] ?? null;
		return {
			failure,
			auth,
			needsSetup,
			guidanceKey,
			guidance: guidanceKey === null ? null : guidanceKey === "panel.configError" ? format(tt(guidanceKey), { error: failure?.message }) : tt(guidanceKey),
			shapeWarnings: Array.isArray(data?.shapeWarnings) ? data.shapeWarnings : []
		};
	}
	var GUIDANCE_BY_CODE, FORM_EXCLUDED_CODES, REFUSAL_TEXT;
	var init_snapshot = __esmMin((() => {
		init_format();
		GUIDANCE_BY_CODE = Object.freeze({
			auth_error: "panel.jwtExpired",
			jwt_expired: "panel.jwtExpired",
			not_configured: "panel.jwtMissing",
			config_error: "panel.configError",
			console_error: "panel.consoleTransient"
		});
		FORM_EXCLUDED_CODES = Object.freeze(/* @__PURE__ */ new Set(["config_error", "console_error"]));
		REFUSAL_TEXT = Object.freeze({
			login_rejected: "auth.badCredentials",
			account_locked: "auth.locked",
			rate_limited: "auth.rateLimited",
			verification_required: "auth.verification",
			login_failed: "auth.failed"
		});
	}));

//#endregion
//#region src/client/styles.ts
	var BRAND, BUTTON, S;
	var init_styles = __esmMin((() => {
		BRAND = "var(--sensenova-brand, #6C5CE7)";
		BUTTON = {
			height: 30,
			padding: "0 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			cursor: "pointer"
		};
		S = {
			page: {
				flex: "1 1 auto",
				height: "100%",
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 14,
				lineHeight: "22px"
			},
			headerBar: {
				flex: "none",
				background: "var(--dsw-alias-bg-base)",
				position: "relative",
				zIndex: 1
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "16px 0 12px"
			},
			scroll: {
				flex: 1,
				minHeight: 0,
				overflowY: "auto",
				overflowX: "hidden"
			},
			content: { padding: "6px 0 56px" },
			tabBar: {
				display: "flex",
				gap: 4,
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				marginBottom: 4
			},
			tab: {
				appearance: "none",
				background: "none",
				border: "none",
				borderBottom: "2px solid transparent",
				padding: "8px 12px",
				fontSize: 13,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				outline: "none"
			},
			tabActive: {
				color: "var(--dsw-alias-label-primary)",
				fontWeight: 600,
				borderBottom: `2px solid ${BRAND}`
			},
			title: {
				margin: 0,
				fontSize: 20,
				fontWeight: 600,
				lineHeight: "28px"
			},
			updated: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12
			},
			spacer: { flex: 1 },
			cluster: {
				display: "inline-flex",
				alignItems: "center",
				gap: 12,
				flexWrap: "wrap",
				justifyContent: "flex-end"
			},
			button: BUTTON,
			sectionTitle: {
				margin: "22px 0 10px",
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-secondary)"
			},
			sectionCard: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden",
				marginTop: 22
			},
			sectionHead: {
				display: "flex",
				alignItems: "center",
				gap: 12,
				width: "100%",
				padding: "12px 16px",
				background: "none",
				border: "none",
				cursor: "pointer",
				textAlign: "left"
			},
			sectionHeadTitle: {
				flex: 1,
				minWidth: 0,
				fontSize: 15,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)"
			},
			chevron: {
				display: "inline-flex",
				flex: "none",
				transition: "transform 0.15s ease",
				color: "var(--dsw-alias-label-secondary)"
			},
			chevronOpen: { transform: "rotate(180deg)" },
			sectionBody: {
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				margin: "0 16px",
				padding: "12px 0 16px"
			},
			card: {
				background: "var(--dsw-alias-bg-layer-1)",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				padding: 16
			},
			poolsGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
				gap: 12,
				alignItems: "start"
			},
			cardHead: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flexWrap: "wrap"
			},
			poolName: {
				fontSize: 15,
				fontWeight: 600
			},
			chip: {
				display: "inline-flex",
				alignItems: "center",
				height: 22,
				padding: "0 8px",
				borderRadius: 999,
				fontSize: 12,
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			grantChip: {
				display: "inline-flex",
				alignItems: "center",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				fontVariantNumeric: "tabular-nums"
			},
			quotas: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
				gap: 10,
				marginTop: 14
			},
			quota: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				minWidth: 0,
				padding: "12px 14px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			quotaTop: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				flexWrap: "wrap"
			},
			quotaLabel: {
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)"
			},
			statHeadline: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			statCaption: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			statError: { color: "var(--dsw-alias-state-error-primary)" },
			statGrid: {
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 110px), 1fr))",
				gap: 10,
				marginTop: 12
			},
			statCard: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				minWidth: 0,
				padding: "10px 12px",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			statValue: {
				fontSize: 16,
				fontWeight: 600,
				lineHeight: "20px",
				fontVariantNumeric: "tabular-nums"
			},
			quotaReset: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)"
			},
			quotaRemaining: {
				fontSize: 18,
				lineHeight: "22px",
				fontWeight: 650,
				letterSpacing: "-0.02em",
				fontVariantNumeric: "tabular-nums"
			},
			quotaUsed: {
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			bar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-1)",
				overflow: "hidden"
			},
			barFill: {
				height: "100%",
				borderRadius: 3,
				background: BRAND
			},
			barFillWarn: { background: "var(--dsw-alias-state-warn-primary)" },
			barFillError: { background: "var(--dsw-alias-state-error-primary)" },
			details: {
				marginTop: 12,
				paddingTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l1)"
			},
			detailsSummary: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				userSelect: "none"
			},
			detailsBody: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				marginTop: 10
			},
			grant: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			models: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6
			},
			modelTag: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 11,
				padding: "2px 6px",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-2)",
				border: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				paddingBottom: 6,
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendHeadLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontWeight: 500
			},
			trendRow: {
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: "10px 0",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			trendRowHead: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: 12,
				minWidth: 0
			},
			trendModel: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			trendCredits: {
				fontSize: 13,
				fontWeight: 600,
				fontVariantNumeric: "tabular-nums"
			},
			trendBar: {
				height: 6,
				borderRadius: 3,
				background: "var(--dsw-alias-bg-layer-2)",
				overflow: "hidden"
			},
			trendLegend: {
				marginTop: 10,
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary)"
			},
			muted: { color: "var(--dsw-alias-label-secondary)" },
			error: { color: "var(--dsw-alias-state-error-primary)" },
			empty: {
				color: "var(--dsw-alias-label-secondary)",
				padding: "18px 0"
			},
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				marginBottom: 12
			},
			fieldLabel: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			input: {
				height: 32,
				padding: "0 10px",
				borderRadius: 8,
				fontSize: 13,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				color: "var(--dsw-alias-label-primary)"
			},
			/** Real shell tokens — replaces the color-mix hack that faked "on-primary". */
			primary: {
				height: 32,
				padding: "0 16px",
				borderRadius: 8,
				fontSize: 13,
				fontWeight: 500,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-primary-fill)",
				color: "var(--dsw-alias-label-primary-foreground)",
				cursor: "pointer"
			},
			primaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
			primaryBusy: {
				opacity: .6,
				cursor: "default"
			},
			formError: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			formNote: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 12,
				margin: "10px 0 0"
			},
			rosterTools: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap",
				marginBottom: 10
			},
			rosterCount: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums",
				marginLeft: "auto"
			},
			rosterBulk: {
				...BUTTON,
				height: 32
			},
			modelList: {
				display: "flex",
				flexDirection: "column",
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			modelRow: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 4px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			modelRowHead: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			modelRowLabel: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				flex: "1 1 auto",
				minWidth: 0
			},
			modelRowOff: { opacity: .55 },
			externalLink: {
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				marginTop: 10,
				display: "inline-block",
				textDecoration: "underline",
				cursor: "pointer"
			},
			modelCheck: {
				flex: "none",
				width: 15,
				height: 15,
				cursor: "pointer",
				accentColor: BRAND,
				margin: 0
			},
			modelName: {
				flex: "0 1 auto",
				minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				fontSize: 12,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			modelRate: {
				flex: "none",
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary)",
				fontVariantNumeric: "tabular-nums"
			},
			modelBadge: {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-secondary)"
			},
			modelMeta: {
				paddingLeft: 25,
				fontSize: 11,
				lineHeight: "15px",
				color: "var(--dsw-alias-label-secondary)"
			},
			rosterFoot: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginTop: 10
			},
			modelPanel: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-1)",
				padding: "12px 14px"
			}
		};
	}));

//#endregion
//#region src/client/account-form.ts
	function AccountForm({ auth, onDone, tt, bare, snapshotAt }) {
		const [username, setUsername] = useState("");
		const [password, setPassword] = useState("");
		const [showPassword, setShowPassword] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [formDetail, setFormDetail] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const outcomeAt = useRef(0);
		const [cooldownUntil, setCooldownUntil] = useState(0);
		const [now, setNow] = useState(() => Date.now());
		useEffect(() => {
			if (cooldownUntil <= Date.now()) return void 0;
			const timer = setInterval(() => {
				setNow(Date.now());
				if (Date.now() >= cooldownUntil) clearInterval(timer);
			}, 1e3);
			return () => clearInterval(timer);
		}, [cooldownUntil]);
		useEffect(() => {
			if (typeof snapshotAt === "number" && snapshotAt > outcomeAt.current) {
				setSaved(false);
				setForgotten(false);
			}
		}, [snapshotAt]);
		const cooling = now < cooldownUntil;
		const coolingMinutes = Math.max(1, Math.ceil((cooldownUntil - now) / 6e4));
		const setCooldown = useCallback((ms) => {
			setCooldownUntil(Date.now() + ms);
			setNow(Date.now());
		}, []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
			if (cooling) return;
			if (username.trim() === "" || password === "") {
				setFormError(tt("auth.empty"));
				return;
			}
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await postJson(ACCOUNT_PATH, {
					username: username.trim(),
					password
				});
				if (body && body.ok === true) {
					setPassword("");
					setSaved(true);
					setForgotten(false);
					outcomeAt.current = Date.now();
					onDone?.();
					return;
				}
				const code = body?.code;
				const waitMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : null;
				if (waitMs !== null && waitMs > 0) {
					setCooldown(waitMs);
					setFormError(tt(REFUSAL_TEXT[typeof code === "string" ? code : ""] ?? "auth.rateLimited"));
					return;
				}
				if (typeof code === "string" && typeof REFUSAL_TEXT[code] === "string") {
					const refusalKey = REFUSAL_TEXT[code];
					setFormError(refusalKey.includes("{") ? format(tt(refusalKey), { reason: body?.error ?? "" }) : tt(refusalKey));
					setFormDetail(typeof body?.detail === "string" && body.detail !== "" ? body.detail : null);
					return;
				}
				setFormError(body?.error ?? tt("auth.network"));
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			username,
			password,
			onDone,
			tt,
			cooling,
			setCooldown
		]);
		const forget = useCallback(async () => {
			setBusy(true);
			setFormError(null);
			setFormDetail(null);
			try {
				const body = await postJson(ACCOUNT_PATH, { forget: true });
				if (body?.ok !== true) {
					setFormError(body?.error ?? tt("auth.network"));
					return;
				}
				setForgotten(true);
				setSaved(false);
				setUsername("");
				setPassword("");
				outcomeAt.current = Date.now();
				onDone?.();
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [onDone, tt]);
		return h("div", { style: bare ? {} : {
			...S.card,
			maxWidth: 420
		} }, bare ? null : h("div", { style: S.sectionTitle }, tt("auth.title")), h("a", {
			href: SENSENOVA_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt(auth?.hasAccount ? "auth.portalHint" : "auth.registerHint")), h("form", { onSubmit: submit }, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.username")), h("input", {
			style: S.input,
			value: username,
			autoComplete: "username",
			placeholder: tt("auth.placeholderUser"),
			disabled: busy,
			onChange: (event) => setUsername(event.target.value)
		})), h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("auth.password")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showPassword ? "text" : "password",
			value: password,
			autoComplete: "current-password",
			disabled: busy,
			onChange: (event) => setPassword(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowPassword((shown) => !shown)
		}, showPassword ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy || cooling ? S.primaryBusy : {}
			},
			disabled: busy || cooling
		}, busy ? tt("auth.submitting") : tt("auth.submit")), auth?.hasAccount ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("auth.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("auth.working")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, formError && formDetail ? h("p", { style: S.formNote }, formDetail) : null, cooling ? h("p", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, format(tt("auth.retryAfter"), { minutes: coolingMinutes })) : null, h("p", { style: S.formNote }, auth?.ephemeral === true ? tt("auth.ephemeral") : auth?.autoRecoverArmed === true ? tt("auth.autoRecoverOn") : tt("auth.saved"))));
	}
	var init_account_form = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_runtime();
		init_snapshot();
		init_styles();
	}));

//#endregion
//#region src/client/toggle-switch.ts
/**
	* A sliding toggle with a short label and a tooltip.
	* @param props - see {@link ToggleSwitchProps}.
	* @returns the `<label>` tree wrapping the real checkbox input.
	*/
	function ToggleSwitch({ checked, onChange, label, busyLabel, busy = false, title }) {
		const on = checked === true;
		const text = busy && busyLabel !== void 0 ? busyLabel : label;
		return h("label", {
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 8,
				position: "relative",
				cursor: busy ? "wait" : "pointer",
				opacity: busy ? .55 : 1,
				verticalAlign: "middle"
			},
			...title !== void 0 && title !== "" ? { title } : {}
		}, h("span", { style: {
			position: "relative",
			display: "inline-block",
			width: TRACK_W,
			height: TRACK_H,
			flex: "none"
		} }, h("input", {
			type: "checkbox",
			checked: on,
			disabled: busy,
			onChange,
			style: {
				position: "absolute",
				inset: 0,
				width: TRACK_W,
				height: TRACK_H,
				margin: 0,
				opacity: 0,
				cursor: busy ? "wait" : "pointer"
			}
		}), h("span", {
			"aria-hidden": "true",
			style: {
				position: "absolute",
				inset: 0,
				borderRadius: 999,
				pointerEvents: "none",
				border: `1px solid ${on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-border-l2, #36373b)"}`,
				background: on ? "var(--sensenova-brand, #6C5CE7)" : "var(--dsw-alias-bg-layer-2, #2a2b31)",
				transition: "background .15s, border-color .15s"
			}
		}, h("span", { style: {
			position: "absolute",
			top: 1.5,
			left: 1.5,
			width: THUMB,
			height: THUMB,
			borderRadius: "50%",
			background: on ? "#fff" : "var(--dsw-alias-label-tertiary, #999)",
			transform: on ? `translateX(${TRAVEL}px)` : "translateX(0)",
			transition: "transform .15s, background .15s"
		} }))), h("span", { style: {
			fontSize: 13,
			color: "var(--dsw-alias-label-primary, #e6e6e6)"
		} }, text));
	}
	var TRACK_W, TRACK_H, THUMB, TRAVEL;
	var init_toggle_switch = __esmMin((() => {
		init_runtime();
		TRACK_W = 30;
		TRACK_H = 17;
		THUMB = 12;
		TRAVEL = 13;
	}));

//#endregion
//#region src/client/provider-controls.ts
/**
	* The API-key card's status: ONLY key provenance (+ the ephemeral-host
	* warning). Registration state lives in `ProviderRegStatus` on the
	* provider card — after the panel split into one card per concern, a
	* line about registration inside the key card was information flying
	* across card boundaries, repeating what the provider card's own switch
	* and status already say.
	*
	* Hook-free on purpose: like the pool cards, it is exercised by the Node
	* render suite, so a reworded or dropped status line fails a check. It
	* renders ONLY from the snapshot's `llm` block, which never carries the
	* key itself — booleans and a source tag.
	*/
	function ProviderStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		const rows = [];
		const sourceText = llm.hasApiKey === true ? format(tt("llm.keyPresent"), { source: tt(dictKey("llm.src", String(llm.keySource ?? ""))) || String(llm.keySource ?? "") }) : tt("llm.noKey");
		rows.push(h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, sourceText));
		if (llm.ephemeral === true) rows.push(h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.ephemeral")));
		return h("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			marginBottom: 12
		} }, ...rows);
	}
	/**
	* The provider card's registration status, hook-free like `ProviderStatus`
	* so the render suite pins every branch. The card title and the switch
	* below say "registration" already, so this is pure state + counts: the
	* id rides inside whichever line is showing, never as its own row.
	*/
	function ProviderRegStatus({ llm, tt }) {
		if (!llm || typeof llm !== "object") return null;
		if (llm.registerProvider === true && llm.providerRegistered === true) return h("div", {
			style: {
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)"
			},
			role: "status"
		}, format(tt("llm.registered"), {
			id: String(llm.providerId ?? ""),
			models: count(llm.modelCount),
			vision: count(llm.visionCount)
		}));
		if (llm.registerProvider === true && typeof llm.providerError === "string" && llm.providerError !== "") return h("div", {
			style: S.formError,
			role: "alert"
		}, format(tt("llm.error"), { error: llm.providerError }));
		if (llm.registerProvider === true && llm.llmAvailable !== true) return h("div", { style: {
			...S.formNote,
			color: "var(--dsw-alias-state-warn-primary)"
		} }, tt("llm.noService"));
		if (llm.registerProvider === true) return h("div", {
			style: {
				...S.muted,
				fontSize: 12
			},
			role: "status"
		}, format(tt("llm.registeredPending"), { id: String(llm.providerId ?? "") }));
		return h("div", { style: {
			...S.muted,
			fontSize: 12
		} }, format(tt("llm.off"), { id: String(llm.providerId ?? "") }));
	}
	/**
	* The live provider-registration switch (docs/PROVIDER-HOT-RELOAD.md).
	*
	* Posts `{ enabled }` to the plugin's own `/provider` route; the Host
	* persists the value in its state file and republishes the adapter pair
	* on the same request, so the flip lands without a config edit or a
	* restart. Hook-based like `ApiKeyForm`, so the render suite (which
	* cannot mount hooks) exercises the secret-free status lines instead;
	* the route itself is covered by `routes.test.mjs`. The state shown is
	* the SNAPSHOT's effective value, never local optimism — the poll after
	* `onDone` repaints whatever the Host actually reports.
	*/
	function ProviderSwitch({ llm, onDone, tt }) {
		const [busy, setBusy] = useState(false);
		const [switchError, setSwitchError] = useState(null);
		const enabled = llm?.registerProvider === true;
		const toggle = useCallback(async () => {
			setBusy(true);
			setSwitchError(null);
			try {
				await postJsonOrThrow(PROVIDER_PATH, { enabled: !enabled });
				onDone?.();
			} catch (error) {
				setSwitchError(format(tt("llm.switchError"), { error: errorText(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			enabled,
			onDone,
			tt
		]);
		return h("div", { style: {
			display: "flex",
			gap: 10,
			alignItems: "center",
			margin: "0 0 12px",
			flexWrap: "wrap"
		} }, h(ToggleSwitch, {
			checked: enabled,
			onChange: toggle,
			busy,
			label: tt("llm.switch"),
			busyLabel: tt("llm.switchBusy"),
			title: tt("llm.switchTitle")
		}), switchError ? h("span", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	/** The i18n key for a reason, or null when there is no reason to state. */
	function drawAbsentKey(reason) {
		if (reason === void 0) return null;
		return DRAW_ABSENT_KEY[reason] ?? "draw.noTools";
	}
	/**
	* The live draw-tool switch (docs/PROVIDER-HOT-RELOAD.md, same discipline
	* as `ProviderSwitch`). Posts `{ enabled }` to the plugin's own `/draw`
	* route; the Host persists the value in its state file. The draw tool
	* itself is mounted at `apply` time (lifecycle.ts), so a panel flip only
	* becomes visible after the NEXT Host (re)mount — but the switch state,
	* the source, and the snapshot's `llm.drawEnabled` are all live, so the
	* panel shows the effective value immediately. Hook-based like
	* `ProviderSwitch`; the route is covered by `routes.test.mjs`. The component
	* IS mountable (the stand-in React returns `useState`'s initial value and
	* passes `useCallback` straight through), so `render.test.mjs` also pins the
	* picker's row markup — the `modelRowHead` wrap below is that contract.
	*/
	function DrawSwitch({ llm, onDone, tt }) {
		const [busy, setBusy] = useState(false);
		const [switchError, setSwitchError] = useState(null);
		const enabled = llm?.drawEnabled === true;
		const toggle = useCallback(async () => {
			setBusy(true);
			setSwitchError(null);
			try {
				await postJsonOrThrow(DRAW_PATH, { enabled: !enabled });
				onDone?.();
			} catch (error) {
				setSwitchError(format(tt("draw.switchError"), { error: errorText(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			enabled,
			onDone,
			tt
		]);
		const hasKey = llm?.hasApiKey === true;
		const candidates = Array.isArray(llm?.drawCandidateIds) ? llm.drawCandidateIds.map((id) => String(id)) : [];
		const preferred = llm?.drawPreferredModel != null ? String(llm.drawPreferredModel) : null;
		const effective = String(llm?.drawModel ?? "");
		const absentKey = drawAbsentKey(llm?.drawToolNote);
		const statusText = enabled ? absentKey ? tt(absentKey) : hasKey ? tt("draw.onList") : tt("draw.needsKey") : tt("draw.off");
		const saveModel = useCallback(async (id) => {
			setBusy(true);
			setSwitchError(null);
			try {
				await postJsonOrThrow(DRAW_PATH, { drawModelId: id });
				onDone?.();
			} catch (error) {
				setSwitchError(format(tt("draw.switchError"), { error: errorText(error) }));
			} finally {
				setBusy(false);
			}
		}, [onDone, tt]);
		const pickerRows = hasKey && candidates.length > 0 ? h("div", { style: S.modelPanel }, h("ul", {
			style: S.modelList,
			role: "radiogroup",
			"aria-label": tt("draw.title")
		}, h("li", {
			style: enabled ? S.modelRow : {
				...S.modelRow,
				...S.modelRowOff
			},
			key: "auto"
		}, h("div", { style: S.modelRowHead }, h("label", { style: busy ? {
			...S.modelRowLabel,
			cursor: "default"
		} : {
			...S.modelRowLabel,
			cursor: "pointer"
		} }, h("input", {
			type: "radio",
			name: "draw-model",
			checked: preferred === null && enabled,
			disabled: busy || !enabled,
			onChange: () => void saveModel(null),
			style: S.modelCheck
		}), h("span", { style: S.modelName }, tt("draw.autoOption"))), h("span", { style: S.modelBadge }, effective !== "" ? `${tt("draw.badge")} · ${effective}` : `${tt("draw.badge")} · ${tt("draw.badgeNone")}`))), ...candidates.map((id) => h("li", {
			style: enabled ? S.modelRow : {
				...S.modelRow,
				...S.modelRowOff
			},
			key: id
		}, h("div", { style: S.modelRowHead }, h("label", { style: busy ? {
			...S.modelRowLabel,
			cursor: "default"
		} : {
			...S.modelRowLabel,
			cursor: "pointer"
		} }, h("input", {
			type: "radio",
			name: "draw-model",
			checked: preferred === id && enabled,
			disabled: busy || !enabled,
			onChange: () => void saveModel(id),
			style: S.modelCheck
		}), h("span", {
			style: S.modelName,
			title: id
		}, id)), h("span", { style: S.modelBadge }, effective === id && enabled ? `${tt("draw.badge")} · ${tt("draw.effective")}` : tt("draw.badge"))))))) : null;
		const noListHint = hasKey && candidates.length === 0 ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 4
		} }, tt("draw.noCandidates")) : null;
		return h("div", { style: { marginBottom: 12 } }, h(ToggleSwitch, {
			checked: enabled,
			onChange: toggle,
			busy,
			label: tt("draw.switch"),
			busyLabel: tt("draw.switchBusy"),
			title: tt("draw.switchTitle")
		}), h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 4
		} }, statusText), pickerRows, noListHint, switchError ? h("div", {
			style: S.formError,
			role: "alert"
		}, switchError) : null);
	}
	var DRAW_ABSENT_KEY;
	var init_provider_controls = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_runtime();
		init_styles();
		init_toggle_switch();
		DRAW_ABSENT_KEY = {
			"no-tools-service": "draw.noTools",
			"peer-load-failed": "draw.noToolsPeer",
			"registry-refused": "draw.noToolsRefused"
		};
	}));

//#endregion
//#region src/client/model-row.ts
/**
	* One row of a model roster.
	* @param {object} props - the row's content, already decided by the caller.
	* @param {string} props.id - the model id; also the name's hover title.
	* @param {string} props.label - the name on screen (falls back to the id).
	* @param {boolean} props.on - whether the model is pushed; off dims the row.
	* @param {boolean} [props.busy] - disables the checkbox while a save or the
	*   login walk is in flight, and drops the pointer cursor to match.
	* @param {string|null} [props.rateText] - the rate chip's text (`×0.75`, or a
	*   provider-specific "free"); `null`/absent draws no chip.
	* @param {string} [props.rateTitle] - the chip's tooltip. It is the caller's
	*   because the two rates are NOT the same fact (see the module note).
	* @param {unknown[]} [props.badges] - badge nodes for the head line's right
	*   edge; the caller decides which states are worth quoting.
	* @param {string|null} [props.meta] - the parameter line's text; empty/absent
	*   draws no line rather than an empty one.
	* @param {(id: string) => void} [props.onToggle] - absent (render suite), the
	*   checkbox is display-only.
	* @returns {unknown} the `<li>` for this row.
	*/
	function ModelRow({ id, label, on, busy, rateText, rateTitle, badges, meta, onToggle }) {
		const badgeList = Array.isArray(badges) ? badges.filter((badge) => badge !== null && badge !== void 0) : [];
		return h("li", { style: {
			...S.modelRow,
			...on ? {} : S.modelRowOff
		} }, h("div", { style: S.modelRowHead }, h("label", { style: busy ? {
			...S.modelRowLabel,
			cursor: "default"
		} : {
			...S.modelRowLabel,
			cursor: "pointer"
		} }, h("input", {
			type: "checkbox",
			checked: on,
			disabled: busy === true,
			style: S.modelCheck,
			"aria-label": label,
			onChange: onToggle ? () => onToggle(id) : void 0
		}), h("span", {
			style: S.modelName,
			title: id
		}, label), rateText === null || rateText === void 0 ? null : h("span", {
			style: S.modelRate,
			title: rateTitle
		}, rateText)), ...badgeList), meta === null || meta === void 0 || meta === "" ? null : h("div", { style: S.modelMeta }, meta));
	}
	var init_model_row = __esmMin((() => {
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/models.ts
/** The model ids a roster advertises, junk entries dropped. */
	function rosterIds(roster) {
		return (Array.isArray(roster) ? roster : []).filter((model) => typeof model === "string" && model !== "");
	}
	/**
	* Whether one model id is offered by an allow-list.
	*
	* Mirrors the Host's `filterByEnabled`: an empty list offers everything,
	* a non-empty one is a strict allow-list, and `HIDE_ALL_MODELS` alone
	* offers nothing.
	*/
	function modelIsOn(enabledIds, id) {
		const list = Array.isArray(enabledIds) ? enabledIds : [];
		return list.length === 0 ? true : list.includes(id);
	}
	/**
	* The allow-list that offers exactly the ids in `on`.
	*
	* Every mutation funnels through here, so the two extreme spellings are
	* emitted consistently: an empty list (nothing curated, every model
	* offered) and `HIDE_ALL_MODELS` alone (nothing offered). No caller can
	* post a list the Host would read differently than the picker shows.
	*/
	function allowListFor(on, roster) {
		const all = rosterIds(roster);
		const kept = all.filter((model) => on.has(model));
		if (kept.length === 0) return [HIDE_ALL_MODELS];
		if (kept.length === all.length) return [];
		return kept;
	}
	/**
	* The next allow-list after ticking or unticking one model.
	*
	* The result is computed against the WHOLE roster, not the current
	* list: the saved value is a complete allow-list rather than a diff, so
	* a curated catalogue stays curated when the catalogue later grows —
	* new models start unticked instead of slipping into DSH on their own.
	*/
	function toggleModelIn(enabledIds, roster, id) {
		const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
		if (on.has(id)) on.delete(id);
		else on.add(id);
		return allowListFor(on, roster);
	}
	/** The allow-list for a bulk "tick all" / "untick all". */
	function setAllModelsIn(roster, allOn) {
		return allowListFor(new Set(allOn ? rosterIds(roster) : []), roster);
	}
	/**
	* The next allow-list after a bulk "tick all" / "untick all" over one set
	* of targets, computed against the WHOLE roster.
	*
	* The targets are the ids the reader is looking at right now (a filtered
	* view); the rows outside them keep whatever the Host already offers, so
	* the result stays a complete allow-list rather than a diff. Both id lists
	* must be STRINGS — `rosterIds` drops anything that is not one, so a roster
	* of `{id}` rows would filter to nothing and the whole call would collapse
	* to the hide-all sentinel no matter which way the button was pressed.
	*/
	function bulkModelsIn(enabledIds, roster, targets, allOn) {
		const on = new Set(rosterIds(roster).filter((model) => modelIsOn(enabledIds, model)));
		for (const id of targets) if (allOn) on.add(id);
		else on.delete(id);
		return allowListFor(on, roster);
	}
	/**
	* Whether one model id is offered by the RACCOON curation.
	*
	* Mirrors the gateway route's reading: an array is a strict allow-list
	* (`[]` offers nothing), anything else — `null`, absent — offers everything.
	*/
	function raccoonModelIsOn(enabledIds, id) {
		return Array.isArray(enabledIds) ? enabledIds.includes(id) : true;
	}
	/**
	* The next curation after ticking or unticking one model, in that dialect.
	*
	* Deliberately the mirror of {@link toggleModelIn} minus the hide-all
	* sentinel: an empty array already spells "nothing pushes" here, so a second
	* spelling would be a second way to say it.
	*
	* The result is a COMPLETE, roster-ordered list rather than a diff, and an
	* all-on toggle deliberately does NOT collapse back to `null`: `null` keeps
	* its one meaning ("the panel never curated"), so a curation the reader made
	* stays made — a model the gateway adds later starts unticked instead of
	* slipping into DSH on its own, which is the same policy the Token Plan side
	* spells with `allowListFor`.
	*/
	function toggleRaccoonModelIn(enabledIds, roster, id) {
		const all = rosterIds(roster);
		const on = new Set(all.filter((model) => raccoonModelIsOn(enabledIds, model)));
		if (on.has(id)) on.delete(id);
		else on.add(id);
		return all.filter((model) => on.has(model));
	}
	var HIDE_ALL_MODELS;
	var init_models = __esmMin((() => {
		HIDE_ALL_MODELS = "__hide_all__";
	}));

//#endregion
//#region src/client/model-picker.ts
/**
	* The model picker's row list - hook-free, so the Node render suite
	* drives the very rows the browser draws.
	*
	* This component owns only what is SPECIFIC to the Token Plan catalogue; the
	* two-line row itself is drawn by {@link ModelRow}, shared with the Raccoon
	* roster (see that module for why the skeleton has one definition). What is
	* specific here: the allow-list decides `on` (`modelIsOn` — an id absent from
	* the list is OFF), the pseudo rate is always rendered `×N` because the Host
	* matched it through the operator's own config, and the parameter line quotes
	* window, output ceiling, and the thinking levels DSH's selector will really
	* offer for THIS model.
	*
	* A provider-wide constant (the default effort) never repeats per row - it is
	* stated once in the header, because a fact that never varies between rows is
	* noise, not information. The rows come only from the Host's roster, so a
	* curated id that no longer exists can never become a checkbox: curation is a
	* filter over the catalogue, never a catalogue of its own. A default ("text
	* only") earns no badge, and a figure the catalogue does not declare draws no
	* segment - the list quotes facts, never guesses.
	*/
	function ModelRoster({ models, enabledIds, busy, tt, onToggle }) {
		const list = Array.isArray(models) ? models : [];
		return h("ul", {
			style: S.modelList,
			role: "list"
		}, list.map((model) => {
			const id = String(model?.id ?? "");
			const label = String(model?.name ?? id);
			const on = modelIsOn(enabledIds, id);
			const meta = [
				typeof model?.contextWindow === "number" && model.contextWindow > 0 ? format(tt("llm.contextBadge"), { ctx: tokenSize(model.contextWindow) }) : null,
				typeof model?.maxOutputLength === "number" && model.maxOutputLength > 0 ? format(tt("llm.metaOutput"), { out: tokenSize(model.maxOutputLength) }) : null,
				Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length > 0 ? format(tt("llm.metaLevels"), { levels: model.thinkingLevels.map((level) => tt(dictKey("llm.level", level))).join("/") }) : null
			].filter(Boolean).join(" · ");
			const rate = typeof model?.multiplier === "number" ? model.multiplier : null;
			return h(ModelRow, {
				key: id,
				id,
				label,
				on,
				busy,
				rateText: rate === null ? null : `×${rate}`,
				rateTitle: tt("llm.rosterRateTitle"),
				badges: [model?.vision === true ? h("span", {
					key: "vision",
					style: S.modelBadge
				}, tt("llm.rosterVision")) : null, model?.quotaExhausted === true ? h("span", {
					key: "exhausted",
					style: {
						...S.modelBadge,
						color: "var(--dsw-alias-state-error-primary)"
					}
				}, tt("llm.rosterExhausted")) : null],
				meta,
				onToggle
			});
		}));
	}
	/**
	* The curated model allow-list: which of this key's models get pushed to
	* DSH's model list.
	*
	* Hook-based like `ApiKeyForm`, so the render suite exercises the secret-
	* free half it draws - `ModelRoster` and the counts - instead of this
	* state machine. The edit is local until saved: the picker holds a draft
	* of the allow-list, the "unsaved" state is DERIVED by comparing it with
	* the Host's current value, and the "saved" state is the same comparison
	* after a poll echoes the write. Both therefore cannot lie: a save that
	* never reached the Host keeps showing the edits, and an edit that ends
	* up identical to the Host's value shows neither button.
	*/
	function ModelPicker({ llm, onDone, tt }) {
		const models = Array.isArray(llm?.models) ? llm.models : NO_MODELS;
		const hostIds = Array.isArray(llm?.enabledModelIds) ? llm.enabledModelIds : NO_IDS;
		const [ids, setIds] = useState(() => hostIds.slice());
		const [busy, setBusy] = useState(false);
		const [query, setQuery] = useState("");
		const [savedKey, setSavedKey] = useState(null);
		const [notice, setNotice] = useState(null);
		const touchedRef = useRef(false);
		const hostKey = useMemo(() => JSON.stringify(hostIds), [hostIds]);
		const dirty = useMemo(() => JSON.stringify(ids), [ids]) !== hostKey;
		const justSaved = savedKey !== null && savedKey === hostKey;
		useEffect(() => {
			if (!touchedRef.current) setIds(hostIds);
		}, [hostKey]);
		useEffect(() => {
			if (dirty === true) setSavedKey(null);
		}, [dirty]);
		const save = useCallback(async () => {
			if (busy) return;
			setBusy(true);
			setNotice(null);
			const posted = JSON.stringify(ids);
			try {
				await postJsonOrThrow(MODELS_PATH, { enabledModelIds: ids });
				touchedRef.current = false;
				setSavedKey(posted);
				onDone?.();
			} catch (error) {
				setNotice(format(tt("llm.rosterError"), { error: errorText(error) }));
			} finally {
				setBusy(false);
			}
		}, [
			busy,
			ids,
			onDone,
			tt
		]);
		const needle = query.trim().toLowerCase();
		const visible = useMemo(() => models.filter((model) => {
			if (needle === "") return true;
			return String(model?.id ?? "").toLowerCase().includes(needle) || String(model?.name ?? "").toLowerCase().includes(needle);
		}), [needle, models]);
		const tickedCount = visible.filter((model) => modelIsOn(ids, String(model?.id ?? ""))).length;
		/** Apply "tick all" / "untick all" to the VISIBLE rows only. */
		const bulk = useCallback((allOn) => {
			const roster = models.map((model) => String(model?.id ?? ""));
			const targets = visible.map((model) => String(model?.id ?? ""));
			touchedRef.current = true;
			setIds(bulkModelsIn(ids, roster, targets, allOn));
			setNotice(null);
		}, [
			models,
			visible,
			ids
		]);
		return h("div", { style: { marginBottom: 14 } }, h("p", { style: { margin: "0 0 10px" } }, h("span", { style: S.sectionTitle }, tt("llm.roster")), typeof llm?.thinkingDefault === "string" && llm.thinkingDefault !== "" ? h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, ` — ${format(tt("llm.rosterThinkingDefault"), { level: tt(dictKey("llm.level", llm.thinkingDefault)) })}`) : null), models.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterEmpty")) : h("div", null, h("div", { style: S.rosterTools }, h("input", {
			type: "search",
			style: {
				...S.input,
				flex: "1 1 200px",
				width: "auto"
			},
			value: query,
			placeholder: tt("llm.rosterSearchPlaceholder"),
			"aria-label": tt("llm.rosterSearchPlaceholder"),
			disabled: busy,
			onChange: (event) => setQuery(event.target.value)
		}), h("span", {
			style: S.rosterCount,
			title: format(tt("llm.rosterCount"), {
				selected: tickedCount,
				total: visible.length
			})
		}, format(tt("llm.rosterCount"), {
			selected: tickedCount,
			total: visible.length
		})), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(true)
		}, tt("llm.rosterAll")), h("button", {
			type: "button",
			style: S.rosterBulk,
			disabled: busy === true || visible.length === 0,
			onClick: () => bulk(false)
		}, tt("llm.rosterNone"))), visible.length === 0 ? h("p", { style: S.empty }, tt("llm.rosterNoMatch")) : h("div", { style: S.modelPanel }, h(ModelRoster, {
			models: visible,
			enabledIds: ids,
			busy,
			tt,
			onToggle: (id) => {
				touchedRef.current = true;
				setIds(toggleModelIn(ids, models.map((model) => String(model?.id ?? "")), id));
				setNotice(null);
			}
		})), dirty ? h("div", { style: S.rosterFoot }, h("button", {
			type: "button",
			style: S.primary,
			disabled: busy === true,
			onClick: () => void save()
		}, busy ? tt("llm.rosterSaving") : tt("llm.rosterSave")), h("button", {
			type: "button",
			style: S.button,
			disabled: busy === true,
			onClick: () => {
				touchedRef.current = false;
				setIds(hostIds);
				setNotice(null);
			}
		}, tt("llm.rosterDiscard")), h("span", { style: {
			...S.muted,
			fontSize: 12
		} }, tt("llm.rosterUnsaved"))) : justSaved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.rosterSaved")) : null, h("p", { style: {
			...S.trendLegend,
			marginTop: 10
		} }, tt("llm.rosterHint")), notice !== null ? h("p", {
			style: S.formError,
			role: "alert"
		}, notice) : null));
	}
	var NO_MODELS, NO_IDS;
	var init_model_picker = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_model_row();
		init_models();
		init_runtime();
		init_styles();
		NO_MODELS = [];
		NO_IDS = [];
	}));

//#endregion
//#region src/client/api-key-form.ts
	function ApiKeyForm({ llm, onDone, tt }) {
		const [apiKey, setApiKey] = useState("");
		const [showKey, setShowKey] = useState(false);
		const [busy, setBusy] = useState(false);
		const [formError, setFormError] = useState(null);
		const [saved, setSaved] = useState(false);
		const [forgotten, setForgotten] = useState(false);
		const post = useCallback((payload) => postJson(API_KEY_PATH, payload), []);
		const submit = useCallback(async (event) => {
			event?.preventDefault?.();
			if (apiKey.trim() === "") {
				setFormError(tt("llm.empty"));
				return;
			}
			setBusy(true);
			setFormError(null);
			try {
				const body = await post({ apiKey });
				if (body && body.ok === true) {
					setApiKey("");
					setSaved(true);
					setForgotten(false);
					onDone?.();
					return;
				}
				setFormError(body?.error ?? tt("auth.network"));
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			apiKey,
			post,
			onDone,
			tt
		]);
		const forget = useCallback(async () => {
			setBusy(true);
			setFormError(null);
			try {
				const body = await post({ forget: true });
				if (body?.ok !== true) {
					setFormError(body?.error ?? tt("auth.network"));
					return;
				}
				setForgotten(true);
				setSaved(false);
				setApiKey("");
				onDone?.();
			} catch {
				setFormError(tt("auth.network"));
			} finally {
				setBusy(false);
			}
		}, [
			post,
			onDone,
			tt
		]);
		const canForget = llm?.hasApiKey === true && llm?.keySource === "credentials";
		const keyEditor = h("div", null, h("label", { style: S.field }, h("span", { style: S.fieldLabel }, tt("llm.keyField")), h("div", { style: {
			display: "flex",
			gap: 6,
			alignItems: "center"
		} }, h("input", {
			style: {
				...S.input,
				flex: 1
			},
			type: showKey ? "text" : "password",
			value: apiKey,
			autoComplete: "off",
			placeholder: tt("llm.placeholder"),
			disabled: busy,
			onChange: (event) => setApiKey(event.target.value)
		}), h("button", {
			type: "button",
			style: {
				...S.button,
				flex: "none"
			},
			disabled: busy,
			onClick: () => setShowKey((shown) => !shown)
		}, showKey ? tt("auth.hide") : tt("auth.show")))), h("div", { style: {
			display: "flex",
			gap: 8,
			alignItems: "center",
			marginTop: 4
		} }, h("button", {
			type: "submit",
			style: {
				...S.primary,
				...busy ? S.primaryBusy : {}
			},
			disabled: busy
		}, busy ? tt("llm.saving") : tt("llm.save")), canForget ? h("button", {
			type: "button",
			style: S.button,
			disabled: busy,
			onClick: forget
		}, tt("llm.forget")) : null), forgotten ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.forgotten")) : saved ? h("p", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-success-primary)"
			},
			role: "status"
		}, tt("llm.saved")) : null, formError ? h("p", {
			style: S.formError,
			role: "alert"
		}, formError) : null, h("p", { style: S.formNote }, tt("llm.footnote")), h("a", {
			href: SENSENOVA_SIGNUP_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt(llm?.hasApiKey === true ? "llm.keyManageHint" : "llm.keyRegisterHint")));
		return h("form", { onSubmit: submit }, keyEditor, h(ProviderStatus, {
			llm,
			tt
		}));
	}
	/**
	* The provider-registration half — the live switch plus its "which models
	* get pushed" roster — as ONE card body. Split from `ApiKeyForm` when the
	* panel grew one SectionCard per concern: key, provider+push, draw are
	* three different functions and no longer share a card.
	*/
	function ProviderForm({ llm, onDone, tt }) {
		return h("div", null, h(ProviderSwitch, {
			llm,
			onDone,
			tt
		}), h(ModelPicker, {
			llm,
			onDone,
			tt
		}), h(ProviderRegStatus, {
			llm,
			tt
		}));
	}
	var init_api_key_form = __esmMin((() => {
		init_const();
		init_http();
		init_runtime();
		init_provider_controls();
		init_model_picker();
		init_styles();
	}));

//#endregion
//#region src/client/use-polling-interval.ts
/**
	* Run `run()` on an interval that stops while the page is hidden, and slows
	* down while `failed` is true.
	*
	* @param run - the poll body; must be stable (wrap it in `useCallback`), since
	*   it is an effect dependency and a fresh identity would restart the loop on
	*   every render.
	* @param intervalMs - the healthy cadence, in milliseconds.
	* @param options - loop control.
	* @param options.failed - when true the loop backs off to
	*   {@link ERROR_BACKOFF_MS}, never faster than `intervalMs`.
	*/
	function usePollingInterval(run, intervalMs, options = {}) {
		const { failed = false } = options;
		const healthy = Math.max(1, Math.floor(intervalMs));
		const effective = failed ? Math.max(healthy, ERROR_BACKOFF_MS) : healthy;
		const runRef = useRef(run);
		runRef.current = run;
		useEffect(() => {
			let alive = true;
			let timer = null;
			const fire = () => {
				if (alive) runRef.current();
			};
			const start = () => {
				if (timer === null) timer = setInterval(fire, effective);
			};
			const stop = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};
			const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
			if (!hidden()) {
				fire();
				start();
			}
			const onVisibility = () => {
				if (!alive) return;
				if (hidden()) stop();
				else {
					fire();
					start();
				}
			};
			if (typeof document !== "undefined" && "addEventListener" in document) document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				if (typeof document !== "undefined" && "addEventListener" in document) document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [effective]);
	}
	var ERROR_BACKOFF_MS;
	var init_use_polling_interval = __esmMin((() => {
		init_runtime();
		ERROR_BACKOFF_MS = 6e4;
	}));

//#endregion
//#region src/client/use-snapshot-polling.ts
/**
	* Poll the Host snapshot, following its stated cadence and pausing when hidden.
	* @param {number} [defaultCadenceMs] - poll interval before the first answer arrives.
	* @returns {{ data: SnapshotData | null, error: SnapshotFailure | string | null, loadedOnce: boolean, updatedAt: number, cadenceMs: number, load: () => Promise<void> }}
	*   `data`/`error` are the latest interpreted snapshot; `loadedOnce` gates the
	*   first-frame "loading" vs "needs setup" decision; `updatedAt` stamps the
	*   last successful read; `cadenceMs` is the live poll interval; `load` is the
	*   manual refresher (also wired to the header's 刷新 button).
	*/
	function useSnapshotPolling(defaultCadenceMs = 3e4) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [cadenceMs, setCadenceMs] = useState(defaultCadenceMs);
		const generation = useRef(0);
		const inFlight = useRef(null);
		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const response = await fetch(SNAPSHOT_PATH, {
					headers: { accept: "application/json" },
					cache: "no-store",
					...controller ? { signal: controller.signal } : {}
				});
				if (!isCurrent()) return;
				if (!response.ok) {
					setError(errorOfStatus(response.status));
					return;
				}
				const body = await response.json();
				if (!isCurrent()) return;
				const read = interpretSnapshot(body);
				if (read.data === null) {
					setData(null);
					setError(read.error);
					return;
				}
				setData(read.data);
				setError(null);
				setUpdatedAt(Date.now());
				const stated = read.data?.pollSeconds;
				if (typeof stated === "number" && Number.isFinite(stated)) setCadenceMs(statedCadenceMs(stated, cadenceMs));
			} catch (reason) {
				if (!isCurrent()) return;
				setError(errorText(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, [cadenceMs]);
		usePollingInterval(load, cadenceMs, { failed: error !== null });
		useEffect(() => () => {
			generation.current += 1;
			inFlight.current?.abort?.();
		}, []);
		return {
			data,
			error,
			loadedOnce,
			updatedAt,
			cadenceMs,
			load
		};
	}
	var init_use_snapshot_polling = __esmMin((() => {
		init_runtime();
		init_snapshot();
		init_format();
		init_use_polling_interval();
		init_const();
	}));

//#endregion
//#region src/client/cards.ts
/** The bar fill and figure tone for a usage percentage: 70 warn / 90 danger. */
	function usageTone(pct) {
		if (pct >= 90) return {
			fill: S.barFillError,
			color: "var(--dsw-alias-state-error-primary)"
		};
		if (pct >= 70) return {
			fill: S.barFillWarn,
			color: "var(--dsw-alias-state-warn-primary)"
		};
		return {
			fill: S.barFill,
			color: "var(--dsw-alias-label-secondary)"
		};
	}
	/**
	* One quota window as a compact sub-card. The headline and the bar point the
	* SAME way — both read "已用", from 0 to 100 — so a filled bar and a big
	* percentage can never contradict each other the way the old "remaining %"
	* headline over a usage bar did (100.0% remaining next to a full-looking bar
	* read as "drained"). The product semantics: a free-tier quota FILLS as you
	* spend (encouragement), and the warn/error tones ride that same usage
	* percentage (70 warn / 90 error). The only absolute figures left are the
	* used/limit caption under the bar.
	*
	* A window that is not an object at all (a pool row the Host flagged as
	* shape-drifted, or a window field simply absent) renders NOTHING instead
	* of throwing: one malformed pool must not blank the whole panel — the
	* shape warning above already says what is wrong.
	*/
	function QuotaCard({ label, window, tt }) {
		if (window === null || typeof window !== "object") return null;
		const { limit = 0, used = 0, remaining, resetAt } = window;
		const pct = limit > 0 ? Math.min(100, used / limit * 100) : null;
		const tone = usageTone(pct ?? 0);
		const pctColor = tone.color;
		const headline = pct === null ? "—" : `${pct.toFixed(1)}%`;
		return h("div", { style: S.quota }, h("div", { style: S.quotaTop }, h("span", { style: S.quotaLabel }, label), typeof remaining === "number" && remaining <= 0 ? h("span", { style: {
			...S.chip,
			color: "var(--dsw-alias-state-error-primary)",
			borderColor: "var(--dsw-alias-state-error-primary)"
		} }, tt("pool.exhausted")) : null), h("div", { style: {
			...S.quotaRemaining,
			color: pctColor
		} }, headline), h("div", {
			style: S.bar,
			role: "progressbar",
			"aria-label": `${label} ${tt("pool.used")} ${pct === null ? "—" : `${pct.toFixed(1)}%`}`,
			"aria-valuenow": pct === null ? 0 : pct.toFixed(1),
			"aria-valuemin": 0,
			"aria-valuemax": 100
		}, h("div", { style: {
			...tone.fill,
			width: `${pct ?? 0}%`
		} })), h("div", { style: S.quotaTop }, h("span", { style: S.quotaUsed }, `${tt("pool.used")} ${count(used)} / ${count(limit)}`), typeof remaining === "number" && remaining > 0 && resetAt ? h("span", { style: S.quotaReset }, format(tt("pool.reset"), { time: when(resetAt) })) : null));
	}
	/**
	* One pool card. The open state is intentionally tiny: name, type chip,
	* spendable grant balance, and the twin quota sub-cards. Everything
	* explanatory (grant expiry, the model coverage lists) folds into one
	* `<details>` row so the deck stays scannable on wide screens.
	*/
	function PoolCard({ pool, tt }) {
		const callable = pool.callableModels || pool.modelIds || [];
		const locked = pool.lockedModels || [];
		const hasDetails = pool.nearestGrantExpiry || callable.length > 0 || locked.length > 0;
		return h("div", { style: S.card }, h("div", { style: S.cardHead }, h("span", { style: S.poolName }, pool.name), h("span", { style: S.chip }, pool.poolType === "dedicated" ? tt("pool.dedicated") : tt("pool.default")), h("span", { style: S.spacer }), (pool.grantBalance ?? 0) > 0 ? h("span", {
			style: S.grantChip,
			title: format(tt("pool.grant"), { balance: count(pool.grantBalance) })
		}, format(tt("pool.grant"), { balance: count(pool.grantBalance) })) : null), h("div", { style: S.quotas }, h(QuotaCard, {
			label: tt("pool.window5h"),
			window: pool.window5h,
			tt
		}), h(QuotaCard, {
			label: tt("pool.window7d"),
			window: pool.window7d,
			tt
		})), hasDetails ? h("details", { style: S.details }, h("summary", { style: S.detailsSummary }, tt("pool.details")), h("div", { style: S.detailsBody }, pool.nearestGrantExpiry ? h("div", { style: S.grant }, format(tt("pool.grantExpiry"), {
			time: clockLong(pool.nearestGrantExpiry),
			balance: count(pool.nearestGrantExpiringBalance)
		})) : null, callable.length > 0 ? h("div", { style: S.models }, h("span", { style: {
			...S.muted,
			fontSize: 12,
			marginRight: 2
		} }, `${tt("pool.callable")}:`), callable.map((model) => h("span", {
			key: model,
			style: S.modelTag
		}, model))) : null, locked.length > 0 ? h("div", {
			style: {
				...S.models,
				...S.muted
			},
			title: locked.join(", ")
		}, h("span", { style: {
			fontSize: 12,
			marginRight: 2
		} }, format(tt("pool.locked"), { count: locked.length }))) : null)) : null);
	}
	/**
	* A top-of-section notice for the "transient exhaustion" case: when one or
	* more credit pools have hit zero, the picker (host side) drops those pools'
	* models, so the reader sees models vanish with no explanation. This line
	* says WHY they vanished and WHEN they are expected back — the earliest
	* `resetAt` among the exhausted windows — so a zeroed pool reads as
	* "recovers at HH:MM", never as a mystery.
	*
	* Hook-free: it only reads the snapshot's `pools` array, so the render suite
	* drives the exact component the browser draws. Returns null when nothing is
	* exhausted (the common case stays silent). It does not guess whether a zero
	* came from a true quota drain or a rate-limit blip — the panel never sees
	* the 429 class — it only reports the pool's own reset clock, which is the
	* one honest recovery signal available here.
	*/
	function PoolExhaustionNotice({ pools, tt }) {
		const list = Array.isArray(pools?.pools) ? pools.pools : [];
		let earliest = 0;
		let anyExhausted = false;
		for (const pool of list) for (const key of ["window5h", "window7d"]) {
			const win = pool?.[key];
			if (win && Number(win.remaining) <= 0) {
				anyExhausted = true;
				const reset = Number(win.resetAt) || 0;
				if (reset > 0 && (earliest === 0 || reset < earliest)) earliest = reset;
			}
		}
		if (!anyExhausted) return null;
		const time = earliest > 0 ? when(earliest) : "—";
		return h("div", {
			style: {
				...S.formNote,
				color: "var(--dsw-alias-state-error-primary)",
				marginTop: 4,
				marginBottom: 10
			},
			role: "status"
		}, format(tt("pool.exhaustedNotice"), { time }));
	}
	/**
	* Per-model credit consumption, drawn as a mini bar chart so the eye
	* lands on WHICH model is burning credits: each row carries a bar
	* relative to the largest consumer (the top model fills the track), with
	* the absolute number right-aligned beside the model name. The whole
	* block sits in a card like the quota cards instead of floating as a
	* bare table.
	*/
	function TrendTable({ trend, tt }) {
		if (!trend || !Array.isArray(trend.models) || trend.models.length === 0) return h("div", { style: S.card }, h("div", { style: S.empty }, tt("trend.none")));
		const max = Math.max(0, ...trend.models.map((row) => Math.max(0, Number(row.credits) || 0)));
		const anyMultiplier = trend.models.some((row) => typeof row.multiplier === "number");
		return h("div", { style: S.card }, h("div", { style: S.trendHead }, h("span", { style: S.trendHeadLabel }, tt("trend.model")), h("span", { style: {
			...S.trendHeadLabel,
			textAlign: "right"
		} }, tt("trend.credits"))), trend.models.map((row) => {
			const credits = Math.max(0, Number(row.credits) || 0);
			const pct = max > 0 ? credits / max * 100 : 0;
			const drawsBar = pct >= 1;
			return h("div", {
				key: row.model,
				style: S.trendRow
			}, h("div", { style: S.trendRowHead }, h("span", {
				style: S.trendModel,
				title: row.model
			}, row.model, typeof row.multiplier === "number" && row.multiplier !== 1 ? h("span", {
				style: S.chip,
				title: tt("trend.multiplierLegend")
			}, `×${row.multiplier}`) : null), h("span", { style: S.trendCredits }, count(credits))), drawsBar ? h("div", {
				style: S.trendBar,
				role: "progressbar",
				"aria-label": `${row.model} ${Math.round(pct)}%`,
				"aria-valuenow": Math.round(pct),
				"aria-valuemin": 0,
				"aria-valuemax": 100
			}, h("div", { style: {
				...S.barFill,
				width: `${pct}%`
			} })) : null);
		}), h("div", { style: S.trendLegend }, tt("trend.legend")), anyMultiplier ? h("div", { style: S.trendLegend }, tt("trend.multiplierLegend")) : null);
	}
	/**
	* One content section as a workbuddy-style collapsible card: a full-width
	* header button (title + rotating chevron) over a bordered card body.
	* Auto-expanded by default in `PanelPage`; the reader can tuck a section
	* away to focus on the other. Hook-free on purpose — `open` and `onToggle`
	* arrive as props, so the render tests exercise the toggle without faking
	* React state (children travel as a regular `children` prop, as in React).
	*/
	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard }, h("button", {
			type: "button",
			style: S.sectionHead,
			"aria-expanded": open,
			"aria-label": `${tt(open ? "section.collapse" : "section.expand")}: ${title}`,
			onClick: onToggle
		}, h("span", { style: S.sectionHeadTitle }, title), h("svg", {
			viewBox: "0 0 16 16",
			width: 14,
			height: 14,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.5",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			style: open ? {
				...S.chevron,
				...S.chevronOpen
			} : S.chevron
		}, h("path", { d: "M3 6l5 5 5-5" }))), h("div", {
			style: S.sectionBody,
			hidden: !open
		}, open ? children : null));
	}
	var init_cards = __esmMin((() => {
		init_format();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/qr.ts
	function gfMul(a, b) {
		if (a === 0 || b === 0) return 0;
		return GF_EXP[GF_LOG[a] + GF_LOG[b]];
	}
	function polyMul(a, b) {
		const result = new Array(a.length + b.length - 1).fill(0);
		for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) result[i + j] ^= gfMul(a[i], b[j]);
		return result;
	}
	function rsGeneratorPoly(degree) {
		let poly = [1];
		for (let i = 0; i < degree; i++) poly = polyMul(poly, [1, GF_EXP[i]]);
		return poly;
	}
	/** The Reed–Solomon remainder for one data stream. */
	function rsEncode(data, ecCount) {
		const generator = rsGeneratorPoly(ecCount);
		const buffer = data.concat(new Array(ecCount).fill(0));
		for (let i = 0; i < data.length; i++) {
			const coefficient = buffer[i];
			if (coefficient === 0) continue;
			for (let j = 0; j < generator.length; j++) buffer[i + j] ^= gfMul(generator[j], coefficient);
		}
		return buffer.slice(data.length);
	}
	/**
	* The alignment-pattern centre coordinates per version.
	* v1 has none; v2–6 use `[6, size-7]`; v7–v10 follow the ISO table.
	*/
	function alignmentCentres(version) {
		if (version <= 1) return [];
		return [
			null,
			null,
			[6, 18],
			[6, 22],
			[6, 26],
			[6, 30],
			[6, 34],
			[
				6,
				22,
				38
			],
			[
				6,
				24,
				42
			],
			[
				6,
				26,
				46
			],
			[
				6,
				28,
				50
			]
		][version] ?? [];
	}
	/** Pick the smallest version (1–10) that holds `byteLength` bytes, or -1. */
	function pickVersion(byteLength) {
		for (let version = 1; version <= 10; version++) {
			const capacityBits = DATA_CODEWORDS[version] * 8;
			if (4 + (version <= 9 ? 8 : 16) + byteLength * 8 <= capacityBits) return version;
		}
		return -1;
	}
	/** Encode the payload bytes as the bit stream the codeword interleave consumes. */
	function buildCodewords(bytes, version) {
		const capacityBits = DATA_CODEWORDS[version] * 8;
		const bits = [];
		const pushBits = (value, length) => {
			for (let i = length - 1; i >= 0; i--) bits.push(value >> i & 1);
		};
		pushBits(4, 4);
		pushBits(bytes.length, version <= 9 ? 8 : 16);
		for (const byte of bytes) pushBits(byte, 8);
		pushBits(0, Math.min(4, capacityBits - bits.length));
		while (bits.length % 8 !== 0) bits.push(0);
		for (let i = 0; bits.length < capacityBits; i++) pushBits(i % 2 === 0 ? 236 : 17, 8);
		const dataCodewords = [];
		for (let i = 0; i < bits.length; i += 8) {
			let byte = 0;
			for (let j = 0; j < 8; j++) byte = byte << 1 | bits[i + j];
			dataCodewords.push(byte);
		}
		const blocks = EC_BLOCKS_M[version - 1];
		const dataBlocks = [];
		const ecBlocks = [];
		let offset = 0;
		for (const [count, dataPerBlock] of blocks.groups) for (let b = 0; b < count; b++) {
			const block = dataCodewords.slice(offset, offset + dataPerBlock);
			offset += dataPerBlock;
			dataBlocks.push(block);
			ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
		}
		const result = [];
		const maxDataLen = Math.max(...dataBlocks.map((block) => block.length));
		for (let i = 0; i < maxDataLen; i++) for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
		for (let i = 0; i < blocks.ecPerBlock; i++) for (const block of ecBlocks) if (i < block.length) result.push(block[i]);
		return result;
	}
	/**
	* The QR module grid before masking: the finder / alignment / timing / dark
	* module / format-placeholder cells are placed, and the codewords fill the
	* remaining cells in the ISO zig-zag. `isFunction` records which cells a mask
	* (or the final format write) must never touch.
	*/
	function buildMatrix(size, codewords, version) {
		const modules = [];
		const isFunction = [];
		for (let row = 0; row < size; row++) {
			modules.push(new Array(size).fill(false));
			isFunction.push(new Array(size).fill(false));
		}
		const set = (row, col, dark) => {
			modules[row][col] = dark;
			isFunction[row][col] = true;
		};
		for (let i = 0; i < size; i++) {
			set(6, i, i % 2 === 0);
			set(i, 6, i % 2 === 0);
		}
		const finder = (cx, cy) => {
			for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
				const xx = cx + dx;
				const yy = cy + dy;
				if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				set(yy, xx, dist !== 2 && dist !== 4);
			}
		};
		finder(3, 3);
		finder(size - 4, 3);
		finder(3, size - 4);
		const centres = alignmentCentres(version);
		for (const row of centres) for (const col of centres) {
			if (row === 6 && col === 6 || row === 6 && col === size - 7 || row === size - 7 && col === 6) continue;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
		set(size - 8, 8, true);
		const reserveFormat = (row, col) => {
			if (row >= 0 && row < size && col >= 0 && col < size) {
				modules[row][col] = false;
				isFunction[row][col] = true;
			}
		};
		for (let i = 0; i <= 8; i++) {
			reserveFormat(i, 8);
			reserveFormat(8, i);
		}
		for (let i = 0; i < 8; i++) {
			reserveFormat(size - 1 - i, 8);
			reserveFormat(8, size - 1 - i);
		}
		if (version >= 7) for (let i = 0; i < 18; i++) {
			const a = size - 11 + i % 3;
			const b = Math.floor(i / 3);
			reserveFormat(b, a);
			reserveFormat(a, b);
		}
		let bitIndex = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			const upward = (right + 1 & 2) === 0;
			for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
				const col = right - j;
				const row = upward ? size - 1 - vert : vert;
				if (isFunction[row][col]) continue;
				if (bitIndex < codewords.length * 8) {
					const byte = codewords[bitIndex >> 3];
					modules[row][col] = (byte >> 7 - (bitIndex & 7) & 1) === 1;
					bitIndex++;
				}
			}
		}
		return {
			modules,
			isFunction
		};
	}
	/** The ISO mask functions; mask 7 is the default case. */
	function maskInvert(row, col, mask) {
		switch (mask) {
			case 0: return (row + col) % 2 === 0;
			case 1: return row % 2 === 0;
			case 2: return col % 3 === 0;
			case 3: return (row + col) % 3 === 0;
			case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
			case 5: return row * col % 2 + row * col % 3 === 0;
			case 6: return (row * col % 2 + row * col % 3) % 2 === 0;
			default: return ((row + col) % 2 + row * col % 3) % 2 === 0;
		}
	}
	/**
	* Toggle every data cell the given mask selects.
	*
	* The single home of "apply a mask" — masking the candidate, rolling it back,
	* and finalising the winner used to be the same twin loops copy-pasted three
	* times (jscpd's only clone in the tree). XOR is its own inverse, so applying
	* a mask twice returns to the pre-mask state; the caller relies on that for
	* the rollback step.
	*
	* The loops walk exactly the size×size grid `buildMatrix` produced, so every
	* cell below exists; the assertions state that invariant.
	*/
	function applyMask(modules, isFunction, mask) {
		const size = modules.length;
		for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
			if (isFunction[row][col]) continue;
			if (maskInvert(row, col, mask)) modules[row][col] = !modules[row][col];
		}
	}
	/** The 15-bit format information for one mask at EC level M. */
	function formatBits(mask) {
		const data = 0 | mask & 7;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = rem << 1 ^ (rem >>> 9) * 1335;
		return (data << 10 | rem) ^ 21522;
	}
	/**
	* Write the format bits, in both copies, marking them function cells so the
	* mask never disturbs them. The bit indices are the ISO ordering:
	*
	*   copy 1: bit i → (col 8, row i) for i ≤ 5; bit 6 → (8,7); bit 7 → (8,8);
	*           bit 8 → (7,8); bit i → (row 14-i, col 8) for i = 9..14.
	*   copy 2: bit i → (row size-1-i, col 8) for i ≤ 7; bit i → (row 8,
	*           col size-7+i-8) for i = 8..14.
	*/
	function writeFormat(modules, isFunction, mask) {
		const size = modules.length;
		const bits = formatBits(mask);
		const bit = (i) => (bits >>> i & 1) === 1;
		const set = (row, col, dark) => {
			modules[row][col] = dark;
			isFunction[row][col] = true;
		};
		for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
		set(7, 8, bit(6));
		set(8, 8, bit(7));
		set(8, 7, bit(8));
		for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
		for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i));
		for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i));
		set(size - 8, 8, true);
	}
	/** The 18-bit version block (v7+), placed above the bottom-left finder. */
	function writeVersion(modules, isFunction, version) {
		const size = modules.length;
		let rem = version;
		for (let i = 0; i < 12; i++) rem = rem << 1 ^ (rem >>> 11) * 7973;
		const bits = version << 12 | rem;
		const set = (row, col, dark) => {
			modules[row][col] = dark;
			isFunction[row][col] = true;
		};
		for (let i = 0; i < 18; i++) {
			const dark = (bits >> i & 1) === 1;
			const a = size - 11 + i % 3;
			const b = Math.floor(i / 3);
			set(b, a, dark);
			set(a, b, dark);
		}
	}
	/**
	* The four ISO penalty rules (lower = better mask): N1 same-colour runs, N2
	* 2×2 blocks, N3 finder-like patterns, N4 the dark-fraction balance.
	*/
	function penaltyScore(modules) {
		const size = modules.length;
		let score = 0;
		const linePenalty = (line) => {
			let result = 0;
			let runLength = 1;
			for (let i = 1; i < line.length; i++) if (line[i] === line[i - 1]) runLength++;
			else {
				if (runLength >= 5) result += 3 + (runLength - 5);
				runLength = 1;
			}
			if (runLength >= 5) result += 3 + (runLength - 5);
			const PATTERN_A = [
				true,
				false,
				true,
				true,
				true,
				false,
				true,
				false,
				false,
				false,
				false
			];
			const PATTERN_B = [
				false,
				false,
				false,
				false,
				true,
				false,
				true,
				true,
				true,
				false,
				true
			];
			for (let i = 0; i + 11 <= line.length; i++) {
				let matchA = true;
				let matchB = true;
				for (let j = 0; j < 11; j++) {
					if (line[i + j] !== PATTERN_A[j]) matchA = false;
					if (line[i + j] !== PATTERN_B[j]) matchB = false;
					if (!matchA && !matchB) break;
				}
				if (matchA) result += 40;
				if (matchB) result += 40;
			}
			return result;
		};
		for (let row = 0; row < size; row++) score += linePenalty(modules[row]);
		for (let col = 0; col < size; col++) {
			const column = [];
			for (let row = 0; row < size; row++) column.push(modules[row][col]);
			score += linePenalty(column);
		}
		for (let row = 0; row < size - 1; row++) for (let col = 0; col < size - 1; col++) {
			const value = modules[row][col];
			if (value === modules[row][col + 1] && value === modules[row + 1][col] && value === modules[row + 1][col + 1]) score += 3;
		}
		let dark = 0;
		for (const row of modules) for (const cell of row) if (cell) dark++;
		const total = size * size;
		const k = Math.floor(Math.abs(dark * 20 - total * 10) / total + 1) - 1;
		score += Math.max(0, k) * 10;
		return score;
	}
	/**
	* Build the matrix for one payload: encode, place, mask (the lowest-penalty
	* of the eight), write the format bits, and the version block for v7+.
	* @throws {Error} when the payload does not fit versions 1–10 at level M.
	*/
	function buildQrMatrix(text) {
		const bytes = Array.from(new TextEncoder().encode(text));
		const version = pickVersion(bytes.length);
		if (version < 1) throw new Error(`qr: payload of ${bytes.length} bytes exceeds the v1–10/M capacity`);
		const size = 17 + version * 4;
		const { modules, isFunction } = buildMatrix(size, buildCodewords(bytes, version), version);
		let bestMask = 0;
		let bestPenalty = Infinity;
		for (let mask = 0; mask < 8; mask++) {
			applyMask(modules, isFunction, mask);
			writeFormat(modules, isFunction, mask);
			if (version >= 7) writeVersion(modules, isFunction, version);
			const score = penaltyScore(modules);
			if (score < bestPenalty) {
				bestPenalty = score;
				bestMask = mask;
			}
			applyMask(modules, isFunction, mask);
		}
		applyMask(modules, isFunction, bestMask);
		writeFormat(modules, isFunction, bestMask);
		if (version >= 7) writeVersion(modules, isFunction, version);
		return {
			size,
			modules
		};
	}
	/**
	* Render a matrix as a compact SVG data-URL the panel can drop straight into
	* an `<img>` (no further client-side encoding logic is needed).
	* @param {string} text - the payload.
	* @param {object} [options]
	* @param {number} [options.size] - rendered pixel size (default 200).
	* @returns {string} `data:image/svg+xml;utf8,` + the URL-encoded SVG.
	*/
	function qrDataUrl(text, options = {}) {
		const { size, modules } = buildQrMatrix(text);
		const margin = 4;
		const dim = size + 8;
		const segments = [];
		for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (modules[row][col]) segments.push(`M${col + margin} ${row + margin}h1v1h-1z`);
		const px = options.size ?? 200;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${segments.join("")}" fill="#000"/></svg>`;
		return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
	}
	var DATA_CODEWORDS, EC_BLOCKS_M, GF_EXP, GF_LOG;
	var init_qr = __esmMin((() => {
		DATA_CODEWORDS = [
			0,
			16,
			28,
			44,
			64,
			86,
			108,
			124,
			154,
			182,
			216
		];
		EC_BLOCKS_M = [
			{
				ecPerBlock: 10,
				groups: [[1, 16]]
			},
			{
				ecPerBlock: 16,
				groups: [[1, 28]]
			},
			{
				ecPerBlock: 26,
				groups: [[1, 44]]
			},
			{
				ecPerBlock: 18,
				groups: [[2, 32]]
			},
			{
				ecPerBlock: 24,
				groups: [[2, 43]]
			},
			{
				ecPerBlock: 16,
				groups: [[4, 27]]
			},
			{
				ecPerBlock: 18,
				groups: [[4, 31]]
			},
			{
				ecPerBlock: 22,
				groups: [[2, 38], [2, 39]]
			},
			{
				ecPerBlock: 22,
				groups: [[3, 36], [2, 37]]
			},
			{
				ecPerBlock: 26,
				groups: [[4, 43], [1, 44]]
			}
		];
		GF_EXP = /* @__PURE__ */ new Uint8Array(512);
		GF_LOG = /* @__PURE__ */ new Uint8Array(256);
		{
			let x = 1;
			for (let i = 0; i < 255; i++) {
				GF_EXP[i] = x;
				GF_LOG[x] = i;
				x <<= 1;
				if ((x & 256) !== 0) x ^= 285;
			}
			for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
		}
	}));

//#endregion
//#region src/client/raccoon-roster.ts
/**
	* The model roster the Raccoon adapter offers.
	* @param {object} props
	* @param {RaccoonModel[]} props.models - the rows the route reported.
	* @param {Tt} props.tt - the dictionary.
	* @param {("live"|"empty"|"unreadable")?} [props.source] - which table these
	*   rows came from; a silent fallback is named so the panel cannot read the
	*   built-in table as the gateway's catalogue.
	* @param {string[]?} [props.enabledIds] - the saved pushed-model curation;
	*   `null`/absent reads as "the whole roster pushes".
	* @param {boolean} [props.busy] - disables the checkboxes while a save or the
	*   login walk is in flight.
	* @param {boolean} [props.registered] - whether the provider pair is
	*   currently registered; the header chip says so.
	* @param {(id: string) => void} [props.onToggle] - the per-row toggle; absent
	*   (render suite), the checkboxes are display-only.
	* @returns {unknown} the roster list element.
	*/
	function RaccoonRoster({ models, tt, source, enabledIds, busy, registered, onToggle }) {
		const rows = Array.isArray(models) ? models : [];
		const fallbackNote = source === "empty" ? tt("raccoon.modelsEmpty") : source === "unreadable" ? tt("raccoon.modelsFallback") : null;
		return h("div", { style: {
			...S.modelPanel,
			marginTop: 10
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap",
			marginBottom: 8
		} }, h("span", { style: {
			...S.muted,
			fontSize: 12,
			fontWeight: 600
		} }, format(tt("raccoon.models"), { count: count(rows.length) })), h("span", { style: S.spacer }), h("span", { style: {
			...S.modelBadge,
			...registered === true ? { color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))" } : {}
		} }, registered === true ? tt("raccoon.registeredChip") : tt("raccoon.unregisteredChip"))), h("ul", {
			style: S.modelList,
			role: "list"
		}, rows.map((row) => {
			const id = String(row?.id ?? "");
			const label = String(row?.name ?? id);
			const on = raccoonModelIsOn(enabledIds, id);
			const rate = typeof row?.multiplier === "number" ? row.multiplier : null;
			const promo = row?.billingStatus === "limited_free" || row?.billingStatus === "discount" ? row.billingStatus : null;
			const promoNote = typeof row?.billingStatusNote === "string" ? row.billingStatusNote.trim() : "";
			const promoOriginal = typeof row?.originalMultiplier === "number" ? row.originalMultiplier : null;
			const rateText = rate === null ? null : rate === 0 ? tt("raccoon.free") : `×${rate}`;
			const rateTitle = promo === null ? tt("raccoon.rateTitle") : format(tt("raccoon.promoRateTitle"), {
				effective: rateText ?? "?",
				original: promoOriginal === null ? "?" : `×${promoOriginal}`,
				note: promoNote === "" ? "" : ` ${promoNote}`
			});
			const meta = [typeof row?.contextWindow === "number" && row.contextWindow > 0 ? format(tt("llm.contextBadge"), { ctx: tokenSize(row.contextWindow) }) : null, typeof row?.maxOutputLength === "number" && row.maxOutputLength > 0 ? format(tt("llm.metaOutput"), { out: tokenSize(row.maxOutputLength) }) : null].filter(Boolean).join(" · ");
			return h(ModelRow, {
				key: id,
				id,
				label,
				on,
				busy,
				rateText,
				rateTitle,
				badges: [row?.vision === true ? h("span", {
					key: "vision",
					style: S.modelBadge
				}, tt("llm.rosterVision")) : null, promo === null ? null : h("span", {
					key: "promo",
					style: S.modelBadge,
					title: promoNote === "" ? void 0 : promoNote
				}, promo === "limited_free" ? tt("raccoon.limitedFree") : tt("raccoon.discount"))],
				meta,
				onToggle
			});
		})), h("div", { style: {
			...S.trendLegend,
			marginTop: 8
		} }, tt("raccoon.pushHint")), fallbackNote !== null ? h("div", { style: S.trendLegend }, fallbackNote) : null);
	}
	var init_raccoon_roster = __esmMin((() => {
		init_format();
		init_models();
		init_model_row();
		init_runtime();
		init_styles();
	}));

//#endregion
//#region src/client/raccoon-card.ts
/**
	* The QR image the login code encodes. The payload is the gateway's own
	* public login page URL (~144 bytes), which fits the v1–10/M capacity the
	* local encoder supports; `buildQrMatrix` throwing is the out-of-range
	* signal, and the tab then falls back to the plain URL text.
	* @param {string|null|undefined} scanUrl - the URL the route is waiting on.
	* @returns {unknown} an `<img>`, the URL as text, or null when there is none.
	*/
	function qrImageOf(scanUrl) {
		if (typeof scanUrl !== "string" || scanUrl === "") return null;
		try {
			return h("img", {
				src: qrDataUrl(scanUrl, { size: QR_SIZE }),
				alt: "WeChat QR",
				width: QR_SIZE,
				height: QR_SIZE,
				style: {
					display: "block",
					margin: "8px 0",
					borderRadius: 4
				}
			});
		} catch {
			return h("code", { style: {
				...S.muted,
				fontSize: 12,
				wordBreak: "break-all"
			} }, scanUrl);
		}
	}
	/**
	* The Raccoon tab's card tree.
	* @param {object} props
	* @param {RaccoonState|null} props.state - the route's last answer, or null
	*   before the first one lands.
	* @param {Tt} props.tt - the dictionary.
	* @param {boolean} props.loginBusy - the login POST is in flight (short: the
	*   route answers as soon as it has issued a scan).
	* @param {string|null} props.loginNote - a login/switch error or walk outcome.
	* @param {string|null} props.modelsNote - the pushed-model save's result.
	* @param {boolean} props.idsBusy - a pushed-model save is in flight.
	* @param {() => void} props.onLogin - start a scan.
	* @param {() => void} props.onLogout - forget the credential.
	* @param {(enabled: boolean) => void} props.onSwitch - flip the opt-in switch.
	* @param {(enabled: boolean) => void} props.onWebSearch - flip the web_search opt-in.
	* @param {(ids: string[]) => void} props.onIds - save the pushed-model list.
	* @returns {unknown} the tab's card tree.
	*/
	function RaccoonCard({ state, tt, loginBusy, loginNote, modelsNote, idsBusy, onLogin, onLogout, onSwitch, onIds, onWebSearch }) {
		const enabled = state?.enabled === true;
		const loggedIn = state?.loggedIn === true;
		const scanning = state?.loginStatus === "scanning";
		const waiting = loginBusy || scanning;
		const nick = String(state?.nickname ?? "");
		const models = Array.isArray(state?.models) ? state.models : [];
		const expiresAt = typeof state?.expiresAtMs === "number" ? state.expiresAtMs : null;
		const refreshAt = typeof state?.refreshExpiresAtMs === "number" ? state.refreshExpiresAtMs : null;
		const breakdown = state?.balanceBreakdown;
		const breakdownParts = [];
		if (breakdown?.daily !== void 0) breakdownParts.push({
			key: "daily",
			label: tt("raccoon.partNameDaily"),
			value: count(breakdown.daily)
		});
		if (breakdown?.reward !== void 0) breakdownParts.push({
			key: "reward",
			label: tt("raccoon.partNameReward"),
			value: count(breakdown.reward)
		});
		if (breakdown?.monthly !== void 0) breakdownParts.push({
			key: "monthly",
			label: tt("raccoon.partNameMonthly"),
			value: count(breakdown.monthly)
		});
		if (breakdown?.topup !== void 0) breakdownParts.push({
			key: "topup",
			label: tt("raccoon.partNameTopup"),
			value: count(breakdown.topup)
		});
		const balanceText = typeof state?.balance === "number" ? format(tt("raccoon.balance"), { balance: count(state.balance) }) : state?.balanceDetail !== void 0 && state?.balanceDetail !== "" ? format(tt("raccoon.balanceUnknownDetail"), { detail: state.balanceDetail }) : tt("raccoon.balanceUnknown");
		const balanceTone = typeof state?.balance === "number" && state.balance <= 0 ? S.statError : null;
		const clockParts = [];
		if (loggedIn) {
			if (expiresAt !== null) clockParts.push(h("span", { key: "exp" }, format(tt("raccoon.expiresAt"), { date: when(expiresAt / 1e3) })));
			if (refreshAt !== null) {
				const days = Math.max(1, Math.round((refreshAt - Date.now()) / DAY_MS));
				clockParts.push(h("span", {
					key: "refresh",
					title: format(tt("raccoon.refreshTip"), { days })
				}, ` · ${format(tt("raccoon.refreshUntil"), { date: when(refreshAt / 1e3) })}`));
			}
		}
		const loginStatus = loggedIn ? state?.credentialExpired === true ? {
			alert: true,
			text: nick === "" ? tt("raccoon.expiredPlain") : format(tt("raccoon.expired"), { nick })
		} : {
			alert: false,
			text: nick === "" ? tt("raccoon.loggedInPlain") : format(tt("raccoon.loggedIn"), { nick })
		} : {
			alert: false,
			text: tt("raccoon.notLogged")
		};
		const rosterVisible = loggedIn && models.length > 0;
		return h("div", null, h("div", { style: {
			...S.card,
			padding: "10px 14px"
		} }, h("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 12
		} }, h("div", {
			style: loginStatus.alert ? {
				...S.formError,
				margin: 0,
				fontSize: 13
			} : { fontSize: 13 },
			role: loginStatus.alert ? "alert" : "status"
		}, loginStatus.text), h("span", { style: S.spacer }), loggedIn ? state?.credentialExpired === true ? h("button", {
			type: "button",
			style: S.button,
			onClick: onLogin,
			disabled: waiting
		}, waiting ? tt("raccoon.loggingIn") : tt("raccoon.reLogin")) : h("button", {
			type: "button",
			style: S.button,
			onClick: onLogout
		}, tt("raccoon.logout")) : h("button", {
			type: "button",
			style: S.button,
			onClick: onLogin,
			disabled: waiting
		}, waiting ? tt("raccoon.loggingIn") : tt("raccoon.login"))), !loggedIn && state?.scanUrl !== void 0 && state?.scanUrl !== "" ? qrImageOf(state.scanUrl) : null, clockParts.length > 0 ? h("div", {
			style: {
				...S.statCaption,
				marginTop: 8
			},
			role: "status"
		}, ...clockParts) : null, h("div", { style: { marginTop: 8 } }, h(ToggleSwitch, {
			checked: enabled,
			onChange: () => onSwitch(!enabled),
			busy: waiting,
			label: tt("raccoon.switch"),
			title: tt("raccoon.switchTitle")
		})), h("div", { style: { marginTop: 8 } }, h(ToggleSwitch, {
			checked: state?.webSearchEnabled === true,
			onChange: () => onWebSearch(state?.webSearchEnabled !== true),
			busy: waiting,
			label: tt("raccoon.webSearch"),
			title: tt("raccoon.webSearchTitle")
		}))), loginNote !== null ? h("div", {
			style: {
				...S.formNote,
				fontSize: 12,
				marginTop: 8
			},
			role: "status"
		}, loginNote) : null, state !== null && state.providerError !== void 0 && state.providerError !== "" ? h("div", {
			style: S.formError,
			role: "alert"
		}, state.providerError) : null, loggedIn ? h("div", {
			style: { marginTop: 12 },
			role: "status"
		}, h("div", { style: {
			...S.statHeadline,
			...balanceTone ?? {}
		} }, balanceText), breakdownParts.length > 0 ? h("div", { style: S.statGrid }, breakdownParts.map((part) => h("div", {
			key: part.key,
			style: S.statCard
		}, h("span", { style: S.statCaption }, part.label), h("span", { style: {
			...S.statValue,
			...balanceTone ?? {}
		} }, part.value)))) : null) : null, modelsNote !== null ? h("div", {
			style: {
				...S.formNote,
				fontSize: 12,
				marginTop: 6
			},
			role: "status"
		}, modelsNote) : null, models.length > 0 ? h(RaccoonRoster, {
			models,
			tt,
			source: state?.modelsSource,
			enabledIds: Array.isArray(state?.enabledModelIds) ? state.enabledModelIds : null,
			busy: idsBusy || waiting,
			registered: state?.providerRegistered === true,
			onToggle: (id) => {
				onIds(toggleRaccoonModelIn(state?.enabledModelIds, models.map((row) => String(row?.id ?? "")), id));
			}
		}) : state !== null && !rosterVisible ? enabled && !loggedIn ? h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 10
		} }, tt("raccoon.awaitingLogin")) : h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 10
		} }, tt("raccoon.unregistered")) : null, h("div", { style: {
			...S.muted,
			fontSize: 12,
			marginTop: 14
		} }, tt("raccoon.desc")), h("a", {
			href: RACCOON_SITE_URL,
			target: "_blank",
			rel: "noreferrer",
			style: S.externalLink
		}, tt("raccoon.clientLink")));
	}
	var QR_SIZE, DAY_MS;
	var init_raccoon_card = __esmMin((() => {
		init_format();
		init_models();
		init_runtime();
		init_qr();
		init_raccoon_roster();
		init_const();
		init_toggle_switch();
		init_styles();
		QR_SIZE = 208;
		DAY_MS = 864e5;
	}));

//#endregion
//#region src/client/raccoon-tab.ts
/**
	* The Raccoon tab body.
	* @param {object} props
	* @param {Tt} props.tt - the dictionary.
	* @returns {unknown} the tab's card tree.
	*/
	function RaccoonTab({ tt, onReportStatus }) {
		const [state, setState] = useState(null);
		const [loginBusy, setLoginBusy] = useState(false);
		const [loginNote, setLoginNote] = useState(null);
		const [modelsNote, setModelsNote] = useState(null);
		const [idsBusy, setIdsBusy] = useState(false);
		/**
		* The last failed read, held as state so a failure ALWAYS re-renders.
		*
		* `lastError` (below) is the value the loop reads; this is the re-render
		* trigger that makes a ref-based read observable. Keeping them separate is
		* deliberate: the loop must not depend on a render it causes, yet a pure
		* failure with no `onReportStatus` produces no other state change. See the
		* note on `fail` and the H group in `test/render.test.mjs`.
		*/
		const [readFailure, setReadFailure] = useState(null);
		const alive = useRef(true);
		/**
		* Whether the last read failed — the shared loop's back-off input.
		*
		* A ref, and that is load-bearing rather than lazy: the shared loop reads it
		* DURING render to decide its cadence, so the back-off must not depend on the
		* render it causes. A ref change is picked up on the NEXT render, and `load`
		* guarantees one exists — every failure path calls `report(...)`, which calls
		* `setLoginNote(...)` unconditionally and therefore re-renders. The record is
		* written in exactly that one function, so it cannot drift from what the
		* header shows.
		*
		* The unconditional part is the whole trick. An earlier draft could strand
		* the back-off: with `onReportStatus` omitted there was no other state write
		* on a pure-failure path (nothing about the data changed), so a tab talking
		* to a dead Host kept polling at full speed. `setLoginNote` on every failure
		* is what makes the ref version correct, so do not "optimise" it away — the
		* H group in `test/render.test.mjs` drives this tab through a failing Host
		* with NO `onReportStatus` and asserts the cadence backs off.
		*/
		const lastError = useRef(null);
		/**
		* Which read is allowed to write.
		*
		* The loop's cadence changes (60 s → 2 s when a scan starts) and every change
		* rebuilds it with an immediate load, so two reads can be in flight at once
		* and the SLOWER one can land last — putting the older answer on screen and
		* making the balance, the roster and the login status all step backwards.
		* `alive` alone cannot catch that: it says nothing about supersession. The
		* quota tab has carried the same guard all along; this one now does too,
		* because the two loops answer to the same problem.
		*/
		const generation = useRef(0);
		/**
		* The request currently on the wire, so a superseded read can be ABORTED.
		*
		* The generation guard alone only stops a stale answer from being WRITTEN;
		* the superseded request keeps occupying a Host connection until it settles
		* on its own. The quota tab says so at the top of its `load`, and it matters
		* most here: a scan drops this loop to a 2 s cadence, so a slow read can be
		* superseded several times in a row and each one holds a connection open for
		* nothing. Cancelling is not just ignoring — it also keeps the Host from
		* serving a request the user has already navigated away from.
		*/
		const inFlight = useRef(null);
		/**
		* The time of the last SUCCESSFUL read — what the header's "更新于" shows.
		*
		* A failed read keeps it (the data is stale, not gone) but must still forward
		* the failure, so the header says so instead of presenting a stale timestamp
		* as if nothing were wrong.
		*/
		const lastGoodAt = useRef(0);
		/**
		* The latest `load`, for the header's refresh button.
		*
		* `report` is memoized on `onReportStatus` alone — it has to be, or every
		* render would rebuild the poll loop below — so reading `load` inside it
		* directly would capture the FIRST render's copy (and that render's `tt`)
		* forever.
		*/
		const loadRef = useRef(() => {});
		const report = useCallback((err) => {
			lastError.current = err;
			if (onReportStatus !== void 0 && alive.current) onReportStatus({
				updatedAt: lastGoodAt.current,
				error: err,
				onRefresh: () => void loadRef.current()
			});
		}, [onReportStatus]);
		const load = useCallback(async () => {
			const at = Date.now();
			const mine = generation.current += 1;
			const isCurrent = () => alive.current && generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			/**
			* Record a failed read: forward it to the header, the only place that
			* renders it, AND make sure a render happens.
			*
			* The second half is not decoration. The shared loop reads `lastError`
			* during render to decide its cadence, so a failure that changed no state
			* would never re-render — and with `onReportStatus` omitted (this tab
			* mounted without a header) nothing else on the failure path writes state
			* either: the data is unchanged, so there is genuinely nothing new to show.
			* The tab would then keep polling a dead Host at full speed, which is the
			* exact failure the back-off exists to prevent.
			*
			* `readFailure` is written on EVERY failure (even to the same string) so
			* React sees a real state change; the header still renders the message via
			* `report`, and this state only carries the same text for the tab's own
			* use as the loop's back-off trigger.
			*/
			const fail = (message) => {
				if (!isCurrent()) return;
				setReadFailure(message);
				report(message);
			};
			try {
				const response = await fetch(RACCOON_PATH, {
					headers: { accept: "application/json" },
					cache: "no-store",
					...controller ? { signal: controller.signal } : {}
				});
				if (!isCurrent()) return;
				if (!response.ok) {
					fail(`HTTP ${response.status}`);
					return;
				}
				const body = await response.json().catch(() => null);
				if (!isCurrent()) return;
				if (body === null || body.ok === false) {
					fail(typeof body?.error === "string" && body.error !== "" ? body.error : "no answer");
					return;
				}
				setState(body);
				setReadFailure(null);
				const outcome = typeof body.loginStatus === "string" ? body.loginStatus : null;
				if (outcome === "timeout") setLoginNote(tt("raccoon.loginTimeout"));
				else if (outcome === "canceled") setLoginNote(tt("raccoon.loginCanceled"));
				else if (outcome === "failed") setLoginNote(format(tt("raccoon.loginFailed"), { error: typeof body.loginError === "string" && body.loginError !== "" ? body.loginError : "unknown" }));
				else if (outcome === "logged_in") setLoginNote(null);
				lastGoodAt.current = at;
				report(null);
			} catch {
				fail("unable to reach the Host");
			} finally {
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, [report, tt]);
		loadRef.current = () => void load();
		const scanning = state?.loginStatus === "scanning";
		const pollMs = statedCadenceMs(state?.pollSeconds, RACCOON_POLL_MS);
		const scanPollMs = statedCadenceMs(state?.scanPollSeconds, RACCOON_SCAN_POLL_MS);
		const failed = readFailure !== null;
		const fire = useCallback(() => {
			alive.current = true;
			load();
		}, [load]);
		usePollingInterval(fire, scanning ? scanPollMs : pollMs, { failed });
		useEffect(() => () => {
			alive.current = false;
			generation.current += 1;
			inFlight.current?.abort?.();
		}, []);
		useEffect(() => {
			return () => {
				generation.current += 1;
				inFlight.current?.abort?.();
			};
		}, [
			load,
			onReportStatus,
			scanning,
			pollMs,
			scanPollMs
		]);
		const onReportStatusRef = useRef(onReportStatus);
		onReportStatusRef.current = onReportStatus;
		useEffect(() => () => {
			if (onReportStatusRef.current !== void 0) onReportStatusRef.current(null);
		}, []);
		const toggle = useCallback(async (enabled) => {
			setLoginNote(null);
			try {
				const body = await postJsonOrThrow(RACCOON_PATH, {
					action: "switch",
					enabled
				});
				if (alive.current) setState((current) => current ? {
					...current,
					enabled: body.enabled === true,
					providerRegistered: body.providerRegistered === true
				} : current);
			} catch (why) {
				if (alive.current) setLoginNote(format(tt("raccoon.switchError"), { error: errorText(why) }));
			}
		}, [tt]);
		const toggleWebSearch = useCallback(async (enabled) => {
			setLoginNote(null);
			try {
				const body = await postJsonOrThrow(RACCOON_PATH, {
					action: "webSearch",
					enabled
				});
				if (alive.current) setState((current) => current ? {
					...current,
					webSearchEnabled: body?.webSearchEnabled === true
				} : current);
			} catch (why) {
				if (alive.current) setLoginNote(format(tt("raccoon.webSearchError"), { error: errorText(why) }));
			}
		}, [tt]);
		const startLogin = useCallback(async () => {
			setLoginBusy(true);
			setLoginNote(null);
			try {
				const body = await postJson(RACCOON_PATH, { action: "login" });
				if (alive.current) {
					if (body?.ok === true) setState(body);
					else setLoginNote(body?.error ?? format(tt("raccoon.error"), { error: "login did not finish" }));
				}
			} catch (why) {
				if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: errorText(why) }));
			} finally {
				if (alive.current) setLoginBusy(false);
			}
		}, [tt]);
		const logout = useCallback(async () => {
			setLoginNote(null);
			try {
				await postJsonOrThrow(RACCOON_PATH, { action: "logout" });
				if (alive.current) load();
			} catch (why) {
				if (alive.current) setLoginNote(format(tt("raccoon.error"), { error: errorText(why) }));
			}
		}, [load, tt]);
		const saveIds = useCallback(async (ids) => {
			setModelsNote(null);
			setIdsBusy(true);
			try {
				const body = await postJsonOrThrow(RACCOON_PATH, {
					action: "models",
					enabledModelIds: ids
				});
				if (alive.current && body?.ok === false) {
					setModelsNote(format(tt("raccoon.modelsError"), { error: typeof body.error === "string" ? body.error : "unknown" }));
					return;
				}
				if (alive.current) {
					setState((current) => current ? {
						...current,
						enabledModelIds: ids,
						providerRegistered: body?.providerRegistered === true,
						...typeof body?.providerError === "string" ? { providerError: body.providerError } : {}
					} : current);
					setModelsNote(tt("raccoon.modelsSaved"));
				}
			} catch (why) {
				if (alive.current) setModelsNote(format(tt("raccoon.modelsError"), { error: errorText(why) }));
			} finally {
				if (alive.current) setIdsBusy(false);
			}
		}, [tt]);
		return h(RaccoonCard, {
			state,
			tt,
			loginBusy,
			loginNote,
			modelsNote,
			idsBusy,
			onLogin: () => void startLogin(),
			onLogout: () => void logout(),
			onSwitch: (enabled) => void toggle(enabled),
			onIds: (ids) => void saveIds(ids),
			onWebSearch: (enabled) => void toggleWebSearch(enabled)
		});
	}
	var RACCOON_POLL_MS, RACCOON_SCAN_POLL_MS;
	var init_raccoon_tab = __esmMin((() => {
		init_const();
		init_format();
		init_http();
		init_runtime();
		init_use_polling_interval();
		init_raccoon_card();
		RACCOON_POLL_MS = 6e4;
		RACCOON_SCAN_POLL_MS = 2e3;
	}));

//#endregion
//#region src/client/panel-page.ts
	function PanelPage({ onClose, tt, localeSubscribe }) {
		const { data, error, loadedOnce, updatedAt, load } = useSnapshotPolling();
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			pools: true,
			trend: true,
			account: false,
			provider: true,
			draw: true,
			llm: false,
			raccoon: true
		});
		const [activeTab, setActiveTab] = useState("quota");
		const [raccoonStatus, setRaccoonStatus] = useState(null);
		useEffect(() => {
			if (typeof localeSubscribe !== "function") return void 0;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);
		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({
				...current,
				[key]: !current[key]
			}));
		}, []);
		const pools = data?.pools;
		const trend = data?.trend;
		const { failure, auth, needsSetup, guidance, shapeWarnings } = viewOf(data, error, tt);
		const showSetupForm = needsSetup && loadedOnce;
		const authChip = auth === null ? null : auth.error || !auth.configured ? h("span", {
			style: S.chip,
			title: auth.error || guidance || ""
		}, tt("auth.needsLogin")) : h("span", { style: S.chip }, tt("auth.selfRenew"));
		const headerStatus = h(HeaderStatus, {
			activeTab,
			hasData: data !== null,
			updatedAt,
			failure,
			authChip,
			raccoonStatus,
			tt,
			onRefreshQuota: () => void load()
		});
		const authManage = auth !== null;
		const quotaError = data?.quotaError ?? null;
		const quotaGuidanceKey = quotaError?.code ? GUIDANCE_BY_CODE[String(quotaError.code)] ?? null : null;
		const quotaNotice = quotaError === null ? null : quotaGuidanceKey !== null ? h("div", {
			style: S.formNote,
			role: "status"
		}, tt(quotaGuidanceKey)) : typeof quotaError.message === "string" && quotaError.message !== "" ? h("div", {
			style: S.formNote,
			role: "status"
		}, quotaError.message) : null;
		const quotaLoginBlocked = quotaError !== null && LOGIN_BLOCKED_QUOTA_CODES.has(String(quotaError.code ?? ""));
		const quotaBody = () => {
			if (data === null) return showSetupForm ? h(AccountForm, {
				auth,
				onDone: () => void load(),
				tt,
				snapshotAt: updatedAt
			}) : h("div", { style: S.empty }, failure === null ? tt("panel.loading") : h("div", null, h("div", { role: "alert" }, guidance ?? format(tt("panel.error"), { error: failure.message }))));
			return h("div", null, quotaNotice, quotaLoginBlocked ? h(AccountForm, {
				auth: data?.auth ?? null,
				onDone: () => void load(),
				tt,
				snapshotAt: updatedAt
			}) : h("div", null, h(SectionCard, {
				title: tt("section.pools"),
				open: openSections.pools,
				onToggle: () => toggleSection("pools"),
				tt
			}, pools?.plan?.name ? h("div", { style: {
				...S.muted,
				fontSize: 12,
				marginBottom: 10
			} }, pools.plan.name) : null, h(PoolExhaustionNotice, {
				pools,
				tt
			}), h("div", { style: S.poolsGrid }, (pools?.pools || []).map((pool) => h(PoolCard, {
				key: pool.id,
				pool,
				tt
			}))), Array.isArray(data.uncountedModels) && data.uncountedModels.length > 0 ? h("div", { style: {
				...S.muted,
				fontSize: 12,
				marginTop: -4,
				marginBottom: 4
			} }, format(tt("pool.uncounted"), { models: data.uncountedModels.join(" · ") })) : null, Array.isArray(data.visionModels) && data.visionModels.length > 0 ? h("div", { style: {
				...S.muted,
				fontSize: 12,
				marginTop: -4,
				marginBottom: 4
			} }, format(tt("pool.vision"), { models: data.visionModels.map((entry) => entry.id).join(" · ") + (data.visionModels.every((entry) => entry.source === "name") ? tt("pool.visionInferred") : "") })) : null), h(SectionCard, {
				title: format(tt("section.trend"), {
					hours: trend?.hours ?? 24,
					cache: data?.cacheSeconds ?? 60
				}),
				open: openSections.trend,
				onToggle: () => toggleSection("trend"),
				tt
			}, h(TrendTable, {
				trend,
				tt
			})), authManage ? h(SectionCard, {
				title: tt("auth.title"),
				open: openSections.account,
				onToggle: () => toggleSection("account"),
				tt
			}, h(AccountForm, {
				auth,
				onDone: () => void load(),
				tt,
				bare: true,
				snapshotAt: updatedAt
			})) : null));
		};
		const apiBody = () => h("div", null, h(SectionCard, {
			title: tt("llm.providerTitle"),
			open: openSections.provider,
			onToggle: () => toggleSection("provider"),
			tt
		}, h(ProviderForm, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt
		})), h(SectionCard, {
			title: tt("draw.title"),
			open: openSections.draw,
			onToggle: () => toggleSection("draw"),
			tt
		}, h(DrawSwitch, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt
		})), h(SectionCard, {
			title: tt("llm.title"),
			open: openSections.llm,
			onToggle: () => toggleSection("llm"),
			tt
		}, h(ApiKeyForm, {
			llm: data?.llm ?? null,
			onDone: () => void load(),
			tt,
			bare: true
		})));
		const raccoonBody = () => h("div", { style: { marginTop: 22 } }, h(SectionCard, {
			title: tt("raccoon.title"),
			open: openSections.raccoon,
			onToggle: () => toggleSection("raccoon"),
			tt
		}, h(RaccoonTab, {
			tt,
			onReportStatus: setRaccoonStatus
		})));
		const body = h("div", null, h("div", {
			style: S.tabBar,
			role: "tablist"
		}, h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "quota",
			style: {
				...S.tab,
				...activeTab === "quota" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("quota")
		}, tt("tab.quota")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "api",
			style: {
				...S.tab,
				...activeTab === "api" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("api")
		}, tt("tab.api")), h("button", {
			type: "button",
			role: "tab",
			"aria-selected": activeTab === "raccoon",
			style: {
				...S.tab,
				...activeTab === "raccoon" ? S.tabActive : {}
			},
			onClick: () => setActiveTab("raccoon")
		}, tt("tab.raccoon"))), activeTab === "quota" && data && shapeWarnings.length > 0 ? h("div", {
			style: S.formError,
			role: "status"
		}, format(tt("panel.shapeDrift"), { detail: shapeWarnings.map((entry) => `${tt("shape.api")} ${entry.api} ${tt("shape.missing")} ${entry.missing}`).join("; ") })) : null, activeTab === "quota" ? quotaBody() : activeTab === "raccoon" ? raccoonBody() : apiBody());
		return h("div", {
			style: S.page,
			"data-dsh-plugin": PANEL_ID
		}, h("div", { style: S.headerBar }, h("div", { style: S.header }, h("h1", { style: S.title }, tt("panel.title")), h("span", { style: S.spacer }), headerStatus, onClose ? h("button", {
			type: "button",
			style: S.button,
			onClick: () => onClose()
		}, tt("panel.back")) : null)), h("div", { style: S.scroll }, h("div", { style: S.content }, body)));
	}
	/**
	* The right-hand cluster of the pinned header.
	*
	* The header is a SHELL: a plugin-identity title on the left, and this — the
	* ACTIVE tab's own status — on the right. Quota and api read the same Token
	* Plan snapshot, so both show its `updatedAt` and share the quota refresher;
	* only quota carries the renewal chip and the stale-data banner, because those
	* describe the console login token that the api (API key) and raccoon (a
	* separate gateway credential) tabs have nothing to say about. The raccoon tab
	* reports its OWN freshness + refresher through `raccoonStatus`, so the header
	* "刷新" finally refreshes it too (before, `load()` only re-fetched the quota
	* snapshot and the raccoon poll was separate — the button silently skipped the
	* third tab). Until the raccoon tab mounts, `raccoonStatus` is null and
	* nothing raccoon-specific renders.
	*
	* Hook-free on purpose: the render suite mounts it directly to pin the
	* invariant that quota-only copy (renewal chip, stale-data banner) never
	* appears for the api/raccoon tabs.
	*
	* Prop types are declared once, by the TypeScript annotation on the function
	* — an earlier `@param {TabId} props.activeTab` style JSDoc spelled the same
	* types a second time, where a change to one side could not fail the build.
	*/
	function HeaderStatus({ activeTab, hasData, updatedAt, failure, authChip, raccoonStatus, tt, onRefreshQuota }) {
		if (activeTab === "raccoon") {
			const status = raccoonStatus;
			if (status === null) return null;
			return h("span", { style: S.cluster }, status.updatedAt > 0 ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: when(status.updatedAt / 1e3) })) : null, status.error !== null ? h("span", {
				style: S.error,
				role: "status",
				title: status.error
			}, format(tt("panel.error"), { error: status.error })) : null, h("button", {
				type: "button",
				style: S.button,
				onClick: () => status.onRefresh()
			}, tt("panel.refresh")));
		}
		return h("span", { style: S.cluster }, hasData ? h("span", { style: S.updated }, format(tt("panel.updated"), { time: when(updatedAt / 1e3) })) : null, activeTab === "quota" ? authChip : null, activeTab === "quota" && failure !== null && hasData ? h("span", {
			style: S.error,
			role: "status",
			title: failure.message
		}, format(tt("panel.error"), { error: failure.message })) : null, h("button", {
			type: "button",
			style: S.button,
			onClick: () => onRefreshQuota()
		}, tt("panel.refresh")));
	}
	var LOGIN_BLOCKED_QUOTA_CODES;
	var init_panel_page = __esmMin((() => {
		init_account_form();
		init_api_key_form();
		init_const();
		init_format();
		init_snapshot();
		init_use_snapshot_polling();
		init_runtime();
		init_styles();
		init_cards();
		init_provider_controls();
		init_raccoon_tab();
		LOGIN_BLOCKED_QUOTA_CODES = new Set(Object.keys(GUIDANCE_BY_CODE).filter((code) => !FORM_EXCLUDED_CODES.has(code)));
	}));

//#endregion
//#region src/client/apply.ts
/**
	* Register the dictionaries and the plugin config card.
	*
	* The card is rendered inside the Plugins page by the Host's
	* `renderSlot("plugins.bundle.config", …)` call. No `onClose` is passed —
	* the Plugins page owns navigation; the card has no close button.
	*/
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, {
					zh,
					en
				});
			} catch {
				return () => {};
			}
		}, `${NS}: dictionaries`);
		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch {}
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};
		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn(`[${NS}] config card registration failed:`, error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try {
				dispose();
			} catch {}
		}, `${NS}: ui mounts`);
	}
	var inject;
	var init_apply = __esmMin((() => {
		init_const();
		init_i18n();
		init_panel_page();
		inject = ["slots", "locale"];
	}));

//#endregion
//#region src/client/index.ts
	var require_client = /* @__PURE__ */ __commonJSMin(((exports, module) => {
		init_apply();
		init_const();
		init_snapshot();
		init_models();
		init_format();
		init_runtime();
		init_i18n();
		init_styles();
		init_account_form();
		init_cards();
		init_provider_controls();
		init_toggle_switch();
		init_api_key_form();
		init_model_picker();
		init_panel_page();
		init_raccoon_card();
		init_raccoon_roster();
		init_raccoon_tab();
		init_qr();
		function clientFactory(loaderRequire) {
			provideClientReact(loaderRequire("react"));
			/**
			* The module's test surface.
			*
			* The Host only ever reads `inject`/`apply`; this object exists so the
			* Node-side suites can load the shipped bundle as a module and exercise
			* these REAL definitions — the decision, the dictionaries, the style
			* tokens, the components — instead of scraping the source text for them.
			* Everything here is what the browser itself uses; nothing is defined for
			* the tests' benefit.
			*/
			const panel = Object.freeze({
				interpretSnapshot,
				viewOf,
				errorOfStatus,
				dictionaries: Object.freeze({
					zh,
					en
				}),
				tables: Object.freeze({
					GUIDANCE_BY_CODE,
					FORM_EXCLUDED_CODES,
					REFUSAL_TEXT
				}),
				styles: S,
				helpers: Object.freeze({
					clock,
					clockLong,
					when,
					count,
					format,
					tokenSize,
					statedCadenceMs,
					RACCOON_POLL_MS,
					RACCOON_SCAN_POLL_MS,
					HIDE_ALL_MODELS,
					modelIsOn,
					allowListFor,
					toggleModelIn,
					setAllModelsIn,
					bulkModelsIn,
					raccoonModelIsOn,
					toggleRaccoonModelIn
				}),
				components: Object.freeze({
					QuotaCard,
					PoolCard,
					PoolExhaustionNotice,
					TrendTable,
					SectionCard,
					AccountForm,
					ApiKeyForm,
					ProviderForm,
					ProviderStatus,
					ProviderRegStatus,
					ProviderSwitch,
					DrawSwitch,
					ToggleSwitch,
					ModelRoster,
					ModelPicker,
					PanelPage,
					HeaderStatus,
					RaccoonTab,
					RaccoonCard,
					RaccoonRoster
				}),
				qr: Object.freeze({
					buildQrMatrix,
					qrDataUrl
				})
			});
			return {
				inject,
				apply,
				panel
			};
		}
		/** The registration the Host loads: id plus the factory the Host materializes. */
		const REGISTRATION = {
			id: NS,
			factory: clientFactory
		};
		if (typeof window !== "undefined") {
			const loader = window.__ModuleLoader__;
			if (loader !== void 0) loader.load(REGISTRATION);
		}
		if (typeof module !== "undefined" && module !== null && module.exports !== void 0) module.exports = REGISTRATION;
	}));

//#endregion
return require_client();

})();