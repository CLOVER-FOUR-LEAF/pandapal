# 测试用例与通过记录

> 运行时间：2026-10-03 00:50–01:00（北京时间）｜ 环境：macOS · Python 3 venv · Node（3D 熊猫模块测试）
> 原始输出逐字存于 [`tests/results/`](results/)，本文是汇总与场景说明。

## 一、总览

| 测试套件 | 类型 | 是否调用真实 LLM | 结果 | 原始记录 |
|---|---|---|---|---|
| `test_api.py` | 端到端：真实起服务、真实打接口 | ✅ 真实调用（DeepSeek `deepseek-flash`） | **21/21 通过** | [test_api.txt](results/test_api.txt) · [LLM 调用留痕](results/test_api_llm_calls.jsonl) |
| `test_offline.py` | 离线全链路（monkeypatch LLM，沙箱数据目录） | ❌ 不花 Key | **74/74 通过** | [test_offline.txt](results/test_offline.txt) |
| `test_memory.py` | 记忆层单元：注入预算、检索、归档、缓存 | ❌ | **43/43 通过** | [test_memory.txt](results/test_memory.txt) |
| `test_router.py` | 意图路由：续写指令、多任务纠偏 | ❌ | **20/20 通过** | [test_router.txt](results/test_router.txt) |
| `test_web_static.py` | 前端静态一致性：id/图标/括号/关键钩子 | ❌ | **29/29 通过** | [test_web_static.txt](results/test_web_static.txt) |
| `test_asr.py` | 语音识别：容器魔数、请求体契约、上游失败分类、`/api/asr` 鉴权/体积/限频 | ❌ | **10/10 通过** | [test_asr.txt](results/test_asr.txt) |
| `test_security.py`（pytest） | 安全回归 | ❌ | **5/5 通过** | [test_security.txt](results/test_security.txt) |
| `test_panda3d.mjs`（node:test） | 3D 熊猫模块 | ❌ | **4/4 通过** | [test_panda3d.txt](results/test_panda3d.txt) |
| `test_pause_layout.py` | 无头 Chrome 量暂停键布局 | ❌ | 本机未装 Chrome，自动跳过 | — |

**合计 196 条断言全部通过，0 失败。**

## 二、复现方式

```bash
# 离线套件（无需 Key，数据写临时沙箱，不碰真实 data/）
.venv/bin/python tests/test_offline.py
.venv/bin/python tests/test_memory.py
.venv/bin/python tests/test_router.py
.venv/bin/python tests/test_web_static.py
.venv/bin/python tests/test_asr.py
.venv/bin/python -m pytest tests/test_security.py -v
node tests/test_panda3d.mjs

# 语音识别真链路自检（需真 Key，会花一点额度）：TTS 念一句 → ASR 听回来
.venv/bin/python tests/test_asr_live.py

# 端到端（需 .env 配好 LLM Key）。本次记录用一份 data/ 的拷贝起服务，避免污染入库的演示档：
SB=$(mktemp -d) && cp -R data/. "$SB/" && rm -f "$SB/users.json" "$SB/tokens.json"
PANDA_DATA_DIR="$SB" PANDA_CHILD_PASSWORD=panda123 PANDA_PARENT_PASSWORD=mama123 \
  PANDA_ADMIN_PASSWORD=admin123 .venv/bin/uvicorn server.main:app --port 8765 &
.venv/bin/python tests/test_api.py --base http://127.0.0.1:8765
```

## 三、端到端场景（真实 LLM）

| # | 场景 | 输入 | 预期输出 | 实际结果 |
|---|---|---|---|---|
| 1 | 健康检查 | `GET /api/health` | `ok`，LLM 已配置 | ✅ `llm_configured=True` |
| 2 | 未登录拦截 | 不带 token 访问业务接口 | 401 | ✅ 401 |
| 3 | 三角色登录 | 小豆 / 豆豆妈 / admin | 返回对应 role | ✅ child / parent / admin |
| 4 | 错误密码 | 小豆 + 错误口令 | 401 | ✅ 401 |
| 5 | **记忆驱动问候** | 小豆登录后 `GET /api/greeting` | 问候里引用档案中的记忆 | ✅ "小豆，周六的机器人课又要见到你啦，巡线小车调得怎么样了？……记得把还在吃的感冒药也塞进背包"（机器人课、感冒、西安行程都来自记忆） |
| 6 | 闲聊流式 | `POST /api/chat` 一句闲聊 | SSE 逐 token 下发，回复非空 | ✅ |
| 7 | **规划链全链路** | "西客松比赛我要准备啥？" | plan → node×N 全部完成 → card | ✅ 5 个节点全部完成，卡片已生成 |
| 8 | 记忆本 | `GET /api/memory` | topics 分组可读 | ✅ topics=6 |
| 9 | 记忆沉淀落盘 | 对话后 | daily 有新沉淀 | ✅ daily=4 |
| 10 | 越权隔离 | 家长 chat/logs、孩子看收件箱、跨档访问 | 一律 403 | ✅ 4 项全部 403 |
| 11 | **悄悄话不泄露给家长** | 家长视角拉图谱/收件箱 | 不含 private 节点 | ✅ `leaked_private=0` |
| 12 | 家长只读 | 家长勾清单 / 改事务 | 403；读取 200 | ✅ |
| 13 | 接口矩阵 | 事务详情/清单/日历/建议/成长/晨报/梦想/日志 | 全 200 | ✅ |
| 14 | 接口矩阵 2 | PATCH 事务、图谱时间轴、传话筒 | 全 200 | ✅ |
| 15 | 晨报/问候流式 | `?stream=1` | token* → done | ✅ 问候 47 个 token，晨报 100 个 token |
| 16 | 注册与密保找回 | 注册 → 重复注册 → 答错 → 重置 | 200/400/400/200，旧 token 与旧密码均失效 | ✅ |
| 17 | 家长注册绑定 | 绑定已存在 / 不存在的孩子 | 200 / 400 | ✅ |
| 18 | 历史与传话筒 | 历史回放 + `POST /api/relay` | 200 | ✅ hist=16 |
| 19 | 收件箱裁决路由 | 裁决不存在的项 | 404 | ✅ |
| 20 | **双会话并发隔离** | 两个账号同时对话 | 各写各的档案，新账号为空白档 | ✅ |

### 本次端到端的真实 LLM 调用留痕

本次运行共产生 **27 次真实调用，全部成功**（[原始 jsonl](results/test_api_llm_calls.jsonl)，与线上 `GET /api/logs` 格式相同）：

| 调用方 | 次数 | 平均耗时 |
|---|---|---|
| router（意图分类） | 4 | 1.4 s |
| chat（闲聊） | 3 | 1.1 s |
| greeting / briefing | 2 / 2 | 2.2 s / 2.0 s |
| planner（DAG 拆解） | 1 | 5.1 s |
| node（DAG 节点执行） | 3 | 14.1 s |
| synth（卡片合成） | 1 | 4.7 s |
| extract_graph（记忆沉淀） | 5 | 3.1 s |
| relay（传话筒） | 4 | 3.9 s |
| dream / growth | 1 / 1 | 2.6 s / 9.8 s |

## 四、断网验真（评委必问："断网了还能运行吗？"）

用同一份服务、换成**无效 LLM Key** 实测（等价于大模型不可达）：

| 接口 | 实际行为 |
|---|---|
| `/api/chat` | 返回 `error` 事件："管家的大脑暂时连不上啦：…401…"，**不生成任何冒充的回复** |
| `/api/greeting?stream=1` | **不下发任何 token 事件**；`done` 里给出一句如实说明："小豆，管家暂时连不上大模型，问候稍后再补上～"，并带 `degraded: true` |
| `/api/briefing?stream=1` | 只用本地数据说实话（"我替你盯着 5 件事，最近要紧的是：感冒康复"），`degraded: true`；看板、截止、提醒等本地数据照常显示 |
| 前端 | 凡是 `degraded` 的内容都打上"大模型暂不可用 · 以下为本地数据兜底，非 AI 生成"标记；兜底问候不写进聊天区 |

结论：AI 生成的内容在断网后立刻停止，本地数据（记忆本、事务看板）照常可看。这既证明回复是实时生成而不是预设的，也说明产品在断网时会如实告知。

离线自检里有对应的回归断言：`greeting_degraded_flag`、`briefing_degraded_flag`、`briefing_degraded_json`、`briefing_not_degraded_when_live`。

## 五、离线套件覆盖范围

- **`test_offline.py`（74 项）**：登录 → 晨报 → plan 全链路 SSE 事件顺序与字段 → 动作执行 → 事务/清单/收件箱/提醒/图谱/daily 落盘 → 代办文书 draft 落盘与挂回事务 → 悄悄话强制 private 且不落文件层 → 历史落盘与重启恢复 → 非法 stage 400 → 家长只读 403 → 别名不能绕过密码 → 撞档隔离 → query token 收窄 → 限频 → executor 作用域 → 工具注册表、SSRF 防护、必应解析 → 成长/梦想/传话筒 → 日志分页 → 流式与**断网降级标记** → CSP 等安全头 → XFF 信任边界 → 收件箱裁决联动 → 事务去重。
- **`test_memory.py`（43 项）**：注入字符预算与活跃主题择优、检索相关度/门槛/去重、归档累计与行数上限、读缓存写后失效、主题元数据解析。
- **`test_router.py`（20 项）**：暂停后的「继续」走闲聊直答、不误建事务、跳过多余的 LLM 分类；带新内容的句子照常分类。
- **`test_web_static.py`（29 项）**：HTML id 与 JS 选择器对应、图标 symbol 存在、括号配平、暂停键/断网条/重试入口/**降级标记**等关键钩子已接上。
- **`test_security.py`（5 项）**：token 只存哈希、旧明文 token 迁移、XFF 只信本机反代、限频表硬上限、天气城市参数 URL 转义。

---

## 八、语音识别（ASR）接入后的回归复核

> 时间：2026-10-03 ｜ 环境：Windows · Python 3.12
> 改动：语音输入从「浏览器自带 Web Speech API」换成「前端录音 + 服务端小米 MiMo ASR」——
> 旧实现在国内一按就静默失败（Chrome 把音频送去 Google）、Firefox/Safari 还会把按钮整个删掉。
> 新增 `server/asr.py`、`GET|POST /api/asr`，`web/app.js` 的 `setupMic` 重写为 MediaRecorder 链路。
> 改动后逐套复跑（原始输出：[test_asr.txt](results/test_asr.txt)）：

| 套件 | 本次结果 |
|---|---|
| `test_asr.py`（新增） | **12/12 通过** |
| `test_asr_web.py`（新增，真浏览器） | **3/3 通过** |
| `test_offline.py` | **82/82 通过**（该套件自身已从文档上面的 74 项长到 82 项） |
| `test_tts_e2e.py` | **30/30 通过** |
| `test_memory.py` | **43/43 通过** |
| `test_router.py` | **20/20 通过** |
| `test_tts.py` + `test_security.py`（pytest 同跑） | **33/33 通过** |
| `test_web_static.py` | **48/48 通过**（含 8 个前端模块的 ESM 解析；受限沙箱下 `esm_parse` 会因命名管道被拒而中断整套，需要放宽进程权限） |

`test_asr.py` 覆盖：容器魔数只认 wav/mp3（文件名与 MIME 不可信）、请求体字段与官方文档一致
（`input_audio` + data URL + `asr_options.language`）、语种/网关/模型越界一律回落、
上游 401 / 空结果 / 断连一律抛 `ASRError` 而不伪造、**失败分类**（401/402/403 判为"账号用不了识别"→
503"还没开通"，400/413/5xx 判为"这次没听清"→502）、300KB 录音不被中间件 256KB 的 JSON 闸门挡下、
空录音 400、认不出的容器 415、超体积 413、家长 403、无 token 401、没配 Key 503、按账号限频、
后台「测试识别」自检（成功/上游 402 原文回显/非 admin 403）、调用留痕只记时长与字数、
**不把转写原文写进日志**。

**真链路自检（需真 Key，本次环境没有 Key，未跑）**：`tests/test_asr_live.py` 用项目自己的 TTS
念一句「明天我想去上机器人课」，再把这段音频喂给 ASR 比对转写。离线套件只能证明"按官方文档
拼了请求体"，证明不了"这把 Key + 这个网关认这套请求体"——演示/上线前请在配好 Key 的机器上跑一次
（没配 Key 时它会直接跳过并以 0 退出，不会误报失败）。

### 8.1 真浏览器实测（`test_asr_web.py`，无头 Chrome + 假麦克风）

`web/app.js` 里 MediaRecorder → 解码重采样 → 编 16k wav → multipart 上传 这一段，
HTTP 层的测试覆盖不到，所以另起一个真浏览器用例（原始输出：[test_asr_web.txt](results/test_asr_web.txt)）：

| 断言 | 结果 |
|---|---|
| 探针脚本在页面里跑起来并按 CSP（`script-src 'self'`）以外部脚本加载 | ✅ 收到回传 |
| 点语音键 → 录 1.2 秒 → 再点一下停 → 输入框被识别文本填上 | ✅ 输入框 = `我明天想去遛熊猫`（假上游返回的那句） |
| 上传的确实是 16k 单声道 wav | ✅ 容器识别为 `wav`，40364 字节 ≈ 1.26 秒 PCM（与 1.2 秒录音吻合，说明重采样与编码都对） |

做法：沙箱数据目录 + 假 LLM + 假 ASR 上游，uvicorn 在后台线程起真服务；把 `index.html` 注入探针
脚本后放进临时目录，并把 `config.WEB_DIR` 指过去（`GET /` 是请求时读它，所以页面来自临时副本，
而 `/static/app.js` 仍是仓库里那份真实前端代码——测的就是它）；Chrome 用
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` 免手动授权；结果由页面
`fetch('/__probe')` 回传，不靠抓 stdout。没有 Chrome/Edge 时该用例自动跳过。

### 8.2 真账号实测：Key 有效，但 ASR 额度为 0（2026-10-03）

用真实 MiMo Key（本地 `.env`，不入库）打真实网关，得到一条必须记下来的结论：

| 调用 | 结果 |
|---|---|
| `GET /v1/models` | ✅ 200，模型列表含 `mimo-v2.5` / `mimo-v2.5-asr` / `mimo-v2.5-pro`（Key 有效） |
| `mimo-v2.5-tts`（管家朗读） | ✅ 200，真的出音频（21552 / 23616 字节 mp3） |
| `mimo-v2.5-asr`（语音识别） | ❌ **402 Insufficient account balance** |
| `mimo-v2.5` / `mimo-v2.5-pro`（文本） | ❌ 402 同样 |

补充实测（真音频、真端点）：`POST /api/asr` 用一段 Windows SAPI 合成的中文语音
（"明天我想去上机器人课"）走真实 ASGI 栈 → 上游 402 → 接口按新分类返回
**503 `语音识别还没开通：让管理员在后台「API 配置」里确认一下`**，而不是让孩子一遍遍重说
"没听清"。上游原文留在 `llm_calls.jsonl`，后台「测试识别」也能直接看到。

**结论**：代码链路是通的（鉴权、路由、请求体都被受理，只卡在计费），**卡点是账号额度**——
TTS 有免费额度而 ASR/文本没有。充值或开通识别额度后，跑
`python tests/test_asr_live.py`（或后台点「测试识别」）即可复验是否真的能听回来。
