window.__ModuleLoader__.load({ id: "zdsh-autopilot", factory: function (require, module, exports) {

Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

//#region src/shared-client/locales.ts
/**
* Console locale dictionaries (shared between host console wiring and the
* browser fiber). zh is the source of truth for the KEY SET; en must satisfy
* the same keys (CI-checked by tests/console/locale parity spec).
*/
const NS = "autopilot";
const zh = {
	"tab.label": "AutoPilot 自动领航",
	"tab.description": "断线续跑 · 沙箱优先自动审批 · 二模型复核",
	"global.paused": "暂停全部自动化",
	"global.statsPersistence": "统计持久化（跨重启）",
	"module.continue": "续跑（断线自愈）",
	"module.guard": "守卫（沙箱优先自动审批）",
	"module.review": "复核（二模型审批）",
	"module.enabled": "启用",
	"stats.today": "今日",
	"stats.all": "累计",
	"stats.sent": "已续发",
	"stats.skipped": "已跳过",
	"stats.allowed": "已放行",
	"stats.denied": "已拦截",
	"stats.reviewed": "已复核",
	"panel.title": "AutoPilot",
	"panel.recent": "最近动作",
	"panel.approve": "批准最近拒绝",
	"panel.pause1h": "暂停 1 小时",
	"cmd.status.enabled": "运行中",
	"cmd.status.disabled": "已停用",
	"cmd.status.circuitOpen": "复核熔断开启",
	"cmd.pause.done": "已暂停 {duration}。",
	"cmd.resume.done": "已恢复。",
	"cmd.approve.none": "没有可批准的最近拒绝。",
	"cmd.approve.done": "已授权下一次 {tool} 复核携带人类语境。",
	"cmd.preset.done": "已应用预设：{preset}。",
	"notify.resumed.title": "已自动续跑",
	"notify.resumed.body": "{session} 第 {attempt} 次续跑已发送。",
	"notify.skipped.title": "续跑被跳过",
	"notify.denied.title": "操作已被复核驳回"
};
const en = {
	"tab.label": "AutoPilot",
	"tab.description": "Auto-resume · sandbox-first approvals · second-model review",
	"global.paused": "Pause all automation",
	"global.statsPersistence": "Persistent stats (across restarts)",
	"module.continue": "Resume (interruption self-heal)",
	"module.guard": "Guard (sandbox-first auto approval)",
	"module.review": "Review (second-model)",
	"module.enabled": "Enabled",
	"stats.today": "Today",
	"stats.all": "All time",
	"stats.sent": "Resumed",
	"stats.skipped": "Skipped",
	"stats.allowed": "Allowed",
	"stats.denied": "Denied",
	"stats.reviewed": "Reviewed",
	"panel.title": "AutoPilot",
	"panel.recent": "Recent actions",
	"panel.approve": "Approve latest denial",
	"panel.pause1h": "Pause 1 hour",
	"cmd.status.enabled": "running",
	"cmd.status.disabled": "disabled",
	"cmd.status.circuitOpen": "review circuit open",
	"cmd.pause.done": "Paused for {duration}.",
	"cmd.resume.done": "Resumed.",
	"cmd.approve.none": "No recent denial to approve.",
	"cmd.approve.done": "Next {tool} review will carry human context.",
	"cmd.preset.done": "Preset applied: {preset}.",
	"notify.resumed.title": "Auto-resumed",
	"notify.resumed.body": "Attempt {attempt} sent for {session}.",
	"notify.skipped.title": "Resume skipped",
	"notify.denied.title": "Action denied by reviewer"
};

//#endregion
//#region src/client/index.ts
/**
* Browser console fiber — official slots only, zero DOM scraping.
*
* Registers: locale dictionary, a keyed settings card (per-plugin item slot),
* and a session-header actions panel fed by the status bridge. The panel is
* deliberately small: state lights, today counters, pause/resume and
* approve-latest buttons.
*/
const name = "@deepseek-ai/dsh-autopilot";
const inject = [
	"slots",
	"locale",
	"settingsScope"
];
function createConsoleFiber(adapters) {
	let locale;
	function lookup(dict, key) {
		return dict[key];
	}
	function t(key, params) {
		const template = lookup(zh, key) ?? lookup(en, key) ?? key;
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
	}
	async function refreshStatus() {
		return safeParse(await adapters.fetchText("/api/autopilot-bridge"));
	}
	async function performAction(action) {
		const token = adapters.actionToken();
		const body = JSON.stringify({
			...action,
			token
		});
		const raw = await adapters.fetchText("/api/autopilot-action", {
			method: "POST",
			body
		});
		try {
			return JSON.parse(raw);
		} catch {
			return { ok: false };
		}
	}
	return {
		disposable: true,
		name,
		/** Host client fiber entry: register dictionaries + slots. */
		apply(ctx) {
			ctx.locale?.register(NS, {
				zh,
				en
			});
			locale = ctx.locale?.bind(NS);
			ctx.slots?.inject("settings.plugin.item", () => ({
				name: NS,
				key: NS,
				title: t("tab.label"),
				description: t("tab.description")
			}));
			ctx.slots?.inject("conversation.session.header.actions", () => ({
				id: NS,
				order: 40,
				render: () => ({
					title: t("panel.title"),
					buttons: [{
						label: t("panel.pause1h"),
						action: () => void performAction({ action: "pause1h" })
					}, {
						label: t("panel.approve"),
						action: () => void performAction({ action: "approve-latest" })
					}]
				})
			}));
			ctx.effect?.(() => {
				refreshStatus();
			}, "autopilot-initial-status");
		},
		t,
		refreshStatus,
		performAction,
		setLocaleResolver(fn) {
			locale = fn;
		},
		getLocaleText() {
			return locale?.("panel.title") ?? t("panel.title");
		}
	};
}
function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}

//#endregion
exports.createConsoleFiber = createConsoleFiber;
exports.inject = inject;
exports.name = name;

} });