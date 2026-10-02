# PandaButler（熊猫管家）—— 孩子的终身陪伴成长管家

> "从小用到大，最懂你的那个人"

## 一、项目简介

教育行业 · **家校协同与学员成长服务环节**：绑定单个孩子的 AI 成长管家——记住孩子的一切、听懂孩子的意图、主动把事办了。解决三方沟通断层（学校德育处/家校沟通岗、教培机构教务与学员服务部门每天耗在"学情翻译"上的人力成本）与"孩子没人做通盘规划"的普遍痛点。

与通用 AI（豆包等）的差异：**双层记忆**（活跃关注点块每轮必注入 + 主题图谱检索）实现"持续知晓"；**事件驱动的任务拆解与执行**（LLM→DAG→并行执行→结构化卡片）；**记忆驱动的主动问候**。

本仓库全部代码为比赛期间原创。**架构设计参考了团队开源项目 [OpenPanda](https://github.com/Xustalis/OpenPanda)（MIT License，仅作设计参考，未引入其代码）**：意图分类入口、结构化 plan spec 输出约定、文件式记忆布局（MEMORY.md / topics / daily）与注入策略。

## 二、技术栈

- 前端：原生 ES Modules 单页（零构建步骤，部署最稳）——熊猫 SVG/CSS 动画、SSE 流渲染、任务树、结构化卡片、记忆本
- 后端：Python FastAPI + asyncio（SSE 用 StreamingResponse）
- AI/大模型：OpenAI 兼容协议 与 Anthropic Messages 协议双支持，`env` 一键切换；主备 Key 自动切换
- 存储：文件系统（markdown 记忆 + index.json），单写锁 + tmp→rename 原子写，无数据库依赖

## 三、快速开始

### 环境要求
- Python 3.10+

### 安装步骤
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt   # 仅运行服务可用 requirements.txt
cp .env.example .env   # 然后填入你的 LLM_API_KEY 等
```

### 运行方式
```bash
.venv/bin/python -m server.main          # 或 .venv/bin/uvicorn server.main:app --host 0.0.0.0 --port 8000
# 打开 http://localhost:8000
```

演示档案：登录名输入 **小豆**（预置了记忆数据的演示孩子）；输入任意其他名字会自动新建空白档案，评委互不影响。

### 登录与权限（用户名 + 密码）

| 账号 | 密码 | 角色 | 能用什么 |
|---|---|---|---|
| `小豆` | `panda123` | 孩子 | 聊天 / 悄悄话 / 梦想 / 星球 / 事务 / 记忆本 / 成长（自己的完整档案） |
| `豆豆妈` | `mama123` | 家长 | 收件箱确认、传话筒 + 孩子档案的只读视图（悄悄话服务端强制过滤） |
| `admin` | `admin123`（登录页不再提供一键入口，手动输入） | 评委 | 全部能力 + `/api/logs` 调用留痕 + 孩子/家长视角切换 |

输入未注册的用户名会自动创建「孩子」账号并绑定同名空白档案。登录卡还有**注册**（选孩子/家长身份，家长需填孩子登录名绑定档案）与**忘记密码**（答对注册时设的密保问题即可重置，旧 token 全部作废）两个面板；演示账号统一预置密保「熊猫最爱吃什么？/ 竹子」，开箱可演找回流程。种子账号口令可用 `PANDA_CHILD/PARENT/ADMIN_PASSWORD` 覆盖（仅首次生成 users.json 时生效，线上部署务必改掉）；`data/aliases.seed.json` 可配登录名别名（如 `xiaodou`→`小豆`），别名只解析到已存在的账号、照常校验密码，绝不会绕过密码或蹭到别人的档案。除 `/api/health`、`/api/auth/*` 与静态页外，全部接口要求 `Authorization: Bearer <token>`；非 admin 只能访问自己绑定的孩子档案，越权一律 403；家长账号是孩子档案的只读视图（收件箱确认与传话筒除外）。密码与密保答案 PBKDF2 加盐存 `data/users.json`，token 仅以 SHA-256 哈希落 `data/tokens.json`（均不入库），默认 7 天有效、重启不掉登录。

## 四、核心功能

| 功能 | 模块 |
|---|---|
| 登录选档 / 会话隔离（名字→独立档案目录） | `server/sessions.py` |
| 注册（孩子/家长绑定）· 密保找回密码 · token 吊销 | `server/auth.py` + `/api/auth/register|question|reset` |
| 记忆驱动开场问候 | `GET /api/greeting` |
| 闲聊通道（人设+活跃记忆注入+历史尾部→流式回复） | `server/main.py` `_chat_stream` |
| 意图分类（plan/chat） | `server/router.py` |
| 任务拆解：LLM 输出 JSON DAG，校验去环重试 | `server/planner.py` |
| 按依赖并行执行 + SSE 实时状态 | `server/executor.py` |
| 结构化卡片合成 | `server/synth.py` |
| 代办文书（"帮我写份自我介绍/发言稿"→LLM 真写全文→文稿卡+落盘 `drafts.json` 挂回事务） | `server/actions.py` `draft` |
| 文件式记忆读写：轮后 LLM 抽取→topics/daily/MEMORY；单写锁+原子写 | `server/memory.py` |
| 工具脚手架（声明式注册表，@tool 注册即接入 planner/executor/闲聊通道）：看时间 `now` / 本地赛事库 `race_lookup` / 交通参考 `transport_lookup` / wttr.in 天气 `weather` / 联网搜索 `web_search`（Tavily 兼容端点，未配置则必应网页解析兜底）/ 打开网页 `web_browse` | `server/tools.py` |
| 闲聊直答的工具轮：启发式命中 → 调度器挑工具 → 结果注入 system → 流式回复（`tool` SSE 事件驱动前端工具条） | `server/main.py` `_tool_round` + `server/prompts.py` `TOOL_PICK` |
| 记忆本页：主题分组+时间线+长期记忆 | `web/` + `GET /api/memory` |

**降级不降真**：DAG 规划失败 → 单 LLM 直出卡片（跳过拆解展示，绝不跳过生成）；节点失败 → 标记后继续；联网工具失败/没搜到 → 如实告诉孩子"没查到"，不编造结果。

## 五、大模型使用说明

- 模型：由 `.env` 中 `LLM_MODEL` 指定（开发用 DeepSeek `deepseek-chat` 验证；兼容任意 OpenAI 协议端点）
- 调用方式：`server/llm.py` 统一封装双协议客户端；每轮对话最多涉及 分类→生成→记忆抽取 三次调用
- **赞助商 API 使用清单**：LLM API（见 `.env`，OpenAI 兼容/Anthropic 兼容）、天气 [wttr.in](https://wttr.in)（免费无需 Key）、联网搜索（配置 `SEARCH_API_KEY`+`SEARCH_BASE_URL` 走 Tavily 兼容端点；未配置时用必应网页结果解析，无需 Key）

## 六、项目结构

```
├── server/          # FastAPI 后端（llm/router/planner/executor/synth/memory/sessions/tools）
├── web/             # 前端静态页（index.html / app.js / panda.js / style.css）
├── data/            # 记忆档案与赛事库：child_*/ 目录 + race_db.json + profiles.json
├── tests/           # 端到端测试脚本
├── docs/            # 赛道细则、讨论记录、PRD、架构图
└── README.md
```

## 七、测试说明

```bash
# 不花 Key 的离线自检（monkeypatch LLM，指向临时沙箱，不碰真实 data/）：
.venv/bin/python tests/test_offline.py

# 记忆层自检：不联网不起服务，直接打 MemoryStore 读写
.venv/bin/python tests/test_memory.py

# 前端静态一致性：id/图标/括号配平，暂停键与断网条等关键钩子是否接上
.venv/bin/python tests/test_web_static.py

# 暂停键布局实测：本机 Chrome 无头模式量桌面/窄屏下输入栏按钮的矩形
.venv/bin/python tests/test_pause_layout.py

# 续写指令路由：暂停后点「继续」发来的话必须走闲聊直答，不能误建事务
.venv/bin/python tests/test_router.py

# 服务启动后的端到端用例（真实打接口 + 真实 LLM）：
.venv/bin/python tests/test_api.py --base http://localhost:8000
```
`test_api.py` 覆盖：健康检查、登录/注册/找回、问候（含 SSE 流式）、闲聊流式、规划链全链路（plan→node→card）、
记忆本与沉淀落盘、图谱（含家长视角过滤 + 时间轴切片）、事务详情/更新（POST/PATCH）、清单、家长收件箱、
传话筒、日历导出、成长雷达、梦想、日志分页、双会话并发隔离与权限矩阵。
`test_offline.py` 覆盖：上述主链路的离线版（SSE 事件顺序、悄悄话隔离、账号越权防线、executor 作用域）+
登录 → 晨报 → plan 全链路 → 记忆/事务/清单落盘 → 图谱视角白名单 → 家长只读边界 → 别名防绕过 →
撞档隔离 → query token 收窄 → 限频 → 历史落盘与重启恢复 → 收件箱裁决联动 → 事务去重 → 安全/缓存响应头。
`test_memory.py` 覆盖：注入字符预算与活跃主题择优、检索相关度/门槛/去重、归档累计计数与行数上限、读缓存写后失效。
`test_web_static.py` / `test_pause_layout.py` 覆盖：前端 id/图标引用与括号配平、"暂停键在输入栏内且与发送键同位置"、
窄屏可见、断网条与「重试/继续」入口都接上了；`test_router.py` 覆盖续写指令的路由（不误建事务、跳过多余的 LLM 分类调用）。

## 八、团队成员

PandaButler 团队（西客松 · AI 软件赛道）

## Roadmap（路演话术）

APP/手表/电子宠物形态 · 家长端/老师端 · 企业接口直连（订票等真实操作）· 常驻主动规划 · 私有化部署（数据即文件，孩子数据不出自家服务器）
