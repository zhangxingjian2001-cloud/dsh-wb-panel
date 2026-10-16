# dsh-wb-panel

WorkBuddyAPI 网关面板桥接插件（DeepSeek Harness / DSH）。

把本机 WorkBuddyAPI 网关（`wb2api.exe`，默认 `http://127.0.0.1:7863`）的账号池能力带进 DSH：
Agent 在对话里即可查看账号、暂停/恢复选号、手动签到，不用另开网关网页。

## 工具

| 工具 | 作用 |
|---|---|
| `wb_accounts` | 列出全部账号（区域、昵称、uid、积分/总额、最早到期、暂停/冷却/禁用、在途）+ 账号池健康摘要。只读 |
| `wb_account_ctl` | 对单个账号执行 `pause`（暂停选号，签到照常）/ `resume`（恢复）/ `checkin`（立即签到） |

## 安装

```bash
dsh plugin --profile <profile> add D:/AI-Space/DSH-Plugins/dsh-wb-panel
```

安装后重启对应 DSH 界面。插件只注册两个工具，不改 provider、不改默认模型、不碰其他插件配置。

## 配置

插件 config 字段（写在 profile 的 `cordis.patch.yml`，`wb-panel` 条目下）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:7863` | 网关地址 |
| `apiKey` | 空 | 网关 API key；留空则按下面的顺序自动找 |
| `gatewayConfigPath` | `D:/AI-Space/WorkBuddyAPI/wb2api-panel/config.json` | 兜底读取 key 的网关配置文件 |
| `timeoutMs` | `8000` | 单次请求超时 |

API key 解析顺序：config `apiKey` → 环境变量 `WB_PANEL_API_KEY` → 网关 `config.json` 的 `api_key`。

## 边界

- 插件是网关面板 API 的 HTTP 客户端，**不**启动/停止网关进程，**不**读取 `auths/`，**不**管理账号 OAuth（添加账号仍走网关面板）。
- 网关是个人自用工具，请勿用于分发/转售；`auths/` 含明文凭证，注意保管。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-wb-panel
```

插件不向 profile 写入其他配置，卸载即净。
