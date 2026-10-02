"""后台管理：API 配置 / 用户管理 / 档案内容管理 / 数据文件管理。

  GET  /api/admin/overview              总览：账号/档案/调用统计 + 各服务配置状态
  GET  /api/admin/settings              可编辑配置项（密钥只回掩码，不回明文）
  PUT  /api/admin/settings              写配置 → data/settings.json → 立即生效
  GET  /api/admin/users                 账号清单（含有效 token 数）
  POST /api/admin/users                 建号（child|parent|admin）
  PATCH  /api/admin/users/{username}    改角色/绑定/密码/密保
  DELETE /api/admin/users/{username}    删号（档案目录保留）
  POST /api/admin/users/{username}/revoke  吊销全部 token（踢下线）
  GET  /api/admin/children              孩子档案列表（节点/事务/体积统计）
  GET  /api/admin/children/{name}/files 档案目录文件清单
  GET  /api/admin/children/{name}/file?path=  读文件（.json 返回格式化文本）
  PUT  /api/admin/children/{name}/file       写文件（.json 先校验可解析）
  DELETE /api/admin/children/{name}/file?path= 删文件（index.json 除外）
  GET  /api/admin/data                  共享数据文件清单（赛事库/交通库/别名/映射）
  GET  /api/admin/data/{fname}          读数据文件原文
  PUT  /api/admin/data/{fname}          写数据文件（JSON 校验后原子落盘）

全部端点仅 admin 角色可达；挂在 main.py 末尾 include_router（与 family.py 同模式），
因此可以直接用 main 里的 _user。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import affairs, auth, config, graph, llm, sessions, store

router = APIRouter()


def _admin(request: Request) -> dict:
    """后台总闸：只认 admin 角色（不走 cap 表，避免将来给别的角色误配权限）。

    main 在文件末尾才 include 本模块，顶层 from .main import 会在反向导入时
    拿到半成品模块，所以这里延迟到请求时取 _user。
    """
    from .main import _user
    user = _user(request)
    if user.get("role") != "admin":
        raise HTTPException(403, "只有管理员账号能进后台")
    return user


# ---------------------------------------------------------------- 总览

def _collect_overview() -> dict:
    users = auth.list_users()
    children = _list_children()
    affairs_n = nodes_n = 0
    for c in children:
        affairs_n += c.get("affairs", 0)
        nodes_n += c.get("nodes", 0)
    overrides = config._read_overrides()
    return {
        "users": {
            "total": len(users),
            "admin": sum(1 for u in users if u["role"] == "admin"),
            "child": sum(1 for u in users if u["role"] == "child"),
            "parent": sum(1 for u in users if u["role"] == "parent"),
            "online": sum(1 for u in users if u.get("tokens")),
        },
        "children": {"total": len(children), "affairs": affairs_n, "graph_nodes": nodes_n},
        "llm": {
            "configured": bool(config.LLM_API_KEY),
            "backup": bool(config.LLM_API_KEY2),
            "protocol": config.LLM_PROTOCOL, "model": config.LLM_MODEL,
        },
        "search": {"configured": bool(config.SEARCH_API_KEY and config.SEARCH_BASE_URL)},
        "tts": {
            "configured": bool(config.TTS_API_KEY),
            "base_url": config.TTS_BASE_URL, "model": config.TTS_MODEL,
            "voice": config.TTS_VOICE,
        },
        "logs": llm.read_logs(1, 0).get("total", 0),
        "overrides": sorted(overrides.keys()),
    }


@router.get("/api/admin/overview")
async def api_admin_overview(request: Request):
    _admin(request)
    return await asyncio.to_thread(_collect_overview)


# ---------------------------------------------------------------- 配置管理

def _mask(value: str) -> str:
    """密钥展示掩码：只露前 4 后 4 位，短 key 全掩。"""
    v = str(value or "")
    if len(v) <= 8:
        return "•" * max(len(v), 4)
    return f"{v[:4]}…{v[-4:]}"


def _settings_payload() -> dict:
    """当前生效值 + 来源（settings 覆盖 / env / 默认 / 未配置）；密钥掩码不回明文。"""
    overrides = config._read_overrides()
    groups = []
    for gkey, title, keys in _SETTINGS_GROUPS:
        fields = []
        for key in keys:
            attr, _norm, secret = config.SETTINGS_KEYS[key]
            value = getattr(config, attr, "")
            if key in overrides:
                source = "settings"
            elif os.getenv(key):
                source = "env"
            elif value:
                source = "default"
            else:
                source = "unset"
            field = {
                "key": key, "attr": attr, "secret": secret,
                "set": bool(value), "overridden": key in overrides, "source": source,
            }
            if secret:
                field["preview"] = _mask(value) if value else ""
            else:
                field["value"] = value
            fields.append(field)
        groups.append({"key": gkey, "title": title, "fields": fields})
    return {"groups": groups}


# 后台「API 配置」页的分组（键必须在 config.SETTINGS_KEYS 里）
_SETTINGS_GROUPS = [
    ("llm", "大模型 LLM", ["LLM_PROTOCOL", "LLM_BASE_URL", "LLM_API_KEY",
                          "LLM_API_KEY2", "LLM_MODEL", "LLM_REASONING_EFFORT", "LLM_VISION"]),
    ("search", "联网搜索", ["SEARCH_API_KEY", "SEARCH_BASE_URL"]),
    ("tts", "语音合成 TTS（先配置，调用链路后续接入）",
     ["TTS_API_KEY", "TTS_BASE_URL", "TTS_MODEL", "TTS_VOICE"]),
]


@router.get("/api/admin/settings")
async def api_admin_settings_get(request: Request):
    _admin(request)
    return await asyncio.to_thread(_settings_payload)


class SettingsReq(BaseModel):
    """set 里的值按原样写覆盖（空串 = 强制清空生效值）；unset 移除覆盖回落到 env。"""

    set: dict[str, str] = Field(default_factory=dict)
    unset: list[str] = Field(default_factory=list, max_length=40)


@router.put("/api/admin/settings")
async def api_admin_settings_put(request: Request, req: SettingsReq):
    _admin(request)
    bad = [k for k in list(req.set) + list(req.unset) if k not in config.SETTINGS_KEYS]
    if bad:
        raise HTTPException(400, f"不认识的配置项：{'、'.join(bad[:5])}")
    proto = req.set.get("LLM_PROTOCOL")
    if proto is not None and proto.strip().lower() not in ("openai", "anthropic", ""):
        raise HTTPException(400, "LLM_PROTOCOL 只能是 openai 或 anthropic")

    def _apply() -> dict:
        with store.write_lock(config.SETTINGS_PATH.parent):
            overrides = config._read_overrides()
            for key, value in req.set.items():
                overrides[key] = str(value)[:500]
            for key in req.unset:
                overrides.pop(key, None)
            if overrides:
                store.atomic_write(
                    config.SETTINGS_PATH,
                    json.dumps(overrides, ensure_ascii=False, indent=2))
            elif config.SETTINGS_PATH.exists():
                config.SETTINGS_PATH.unlink()  # 覆盖全撤了就连文件一起收掉
            config.apply_settings()
        return _settings_payload()

    return await asyncio.to_thread(_apply)


# ---------------------------------------------------------------- 用户管理

@router.get("/api/admin/users")
async def api_admin_users(request: Request):
    _admin(request)
    return {"users": await asyncio.to_thread(auth.list_users)}


class AdminUserReq(BaseModel):
    username: str = Field(min_length=1, max_length=24)
    password: str = Field(min_length=4, max_length=64)
    role: str = Field(default="child", pattern="^(child|parent|admin)$")
    child: str = Field(default="", max_length=24)
    question: str = Field(default="", max_length=60)
    answer: str = Field(default="", max_length=60)


@router.post("/api/admin/users")
async def api_admin_user_create(request: Request, req: AdminUserReq):
    _admin(request)
    try:
        return {"user": await asyncio.to_thread(
            auth.admin_create_user, req.username, req.password, req.role,
            req.child, req.question, req.answer)}
    except ValueError as e:
        raise HTTPException(400, str(e))


class AdminUserPatch(BaseModel):
    role: str | None = Field(default=None, pattern="^(child|parent|admin)$")
    child: str | None = Field(default=None, max_length=24)
    password: str | None = Field(default=None, max_length=64)
    question: str | None = Field(default=None, max_length=60)
    answer: str | None = Field(default=None, max_length=60)
    drop_question: bool = False


@router.patch("/api/admin/users/{username}")
async def api_admin_user_patch(request: Request, username: str, req: AdminUserPatch):
    _admin(request)
    try:
        return {"user": await asyncio.to_thread(
            auth.admin_update_user, username[:24], role=req.role, child=req.child,
            password=req.password or None, question=req.question, answer=req.answer,
            drop_question=req.drop_question)}
    except KeyError:
        raise HTTPException(404, "账号不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/admin/users/{username}")
async def api_admin_user_delete(request: Request, username: str):
    user = _admin(request)
    try:
        await asyncio.to_thread(auth.admin_delete_user, username[:24], user["username"])
    except KeyError:
        raise HTTPException(404, "账号不存在")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.post("/api/admin/users/{username}/revoke")
async def api_admin_user_revoke(request: Request, username: str):
    _admin(request)
    n = await asyncio.to_thread(auth.revoke_user_tokens, username[:24])
    return {"ok": True, "revoked": n}


# ---------------------------------------------------------------- 档案内容管理

def _list_children() -> list[dict]:
    """扫描 data/child_* 目录：归属名（index.json）+ 事务/节点/文件统计。"""
    out = []
    root = config.DATA_DIR
    try:
        dirs = sorted(p for p in root.iterdir()
                      if p.is_dir() and p.name.startswith("child_"))
    except OSError:
        return out
    profiles = sessions._read_profiles()
    owner_by_dir = {v: k for k, v in profiles.items()}
    for d in dirs:
        idx = store.read_json(d / "index.json", {})
        name = str(idx.get("name") or owner_by_dir.get(d.name) or d.name)
        gdata = store.read_json(d / "graph.json", {})
        aff = store.read_json(d / "affairs.json", {})
        size = 0
        files = 0
        try:
            for p in d.rglob("*"):
                if p.is_file() and not p.name.startswith(".") and not p.name.endswith(".tmp"):
                    files += 1
                    size += p.stat().st_size
        except OSError:
            pass
        topics = len([p for p in (d / "topics").glob("*.md")]) if (d / "topics").is_dir() else 0
        out.append({
            "name": name, "dir": d.name,
            "nodes": len(gdata.get("nodes") or []),
            "affairs": len(aff.get("affairs") or []),
            "topics": topics, "files": files, "size": size,
        })
    out.sort(key=lambda c: c["dir"])
    return out


@router.get("/api/admin/children")
async def api_admin_children(request: Request):
    _admin(request)
    return {"children": await asyncio.to_thread(_list_children)}


def _child_dir(name: str) -> Path:
    """档案名/目录名 → 已存在的档案目录；找不到 404（后台不该顺手建空档）。"""
    name = name.strip()[:24]
    if not name:
        raise HTTPException(400, "档案名不能为空")
    profiles = sessions._read_profiles()
    if name in profiles:
        d = config.DATA_DIR / profiles[name]
        if d.is_dir():
            return d
    cand = config.DATA_DIR / sessions._safe_dirname(name)
    if cand.is_dir():
        return cand
    for c in _list_children():
        if c["name"] == name:
            d = config.DATA_DIR / c["dir"]
            if d.is_dir():
                return d
    raise HTTPException(404, f"没有找到「{name}」的档案目录")


_BAD_SEG = re.compile(r"^\.*$")


def _resolve_file(child_dir: Path, rel: str, *, must_exist: bool = True) -> Path:
    """档案内相对路径 → 绝对路径；挡掉越界/隐藏文件/符号链接/.tmp。"""
    rel = (rel or "").strip().lstrip("/")
    parts = [p for p in rel.split("/") if p]
    if not rel or len(rel) > 200 or not parts or any(_BAD_SEG.match(p) for p in parts):
        raise HTTPException(400, "路径不合法")
    if any(p.startswith(".") or p.endswith(".tmp") for p in parts):
        raise HTTPException(400, "隐藏文件和临时文件不在管理范围")
    root = child_dir.resolve()
    target = (root / "/".join(parts)).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(400, "路径越界")
    if target.is_symlink():
        raise HTTPException(400, "符号链接不在管理范围")
    if must_exist and (not target.exists() or not target.is_file()):
        raise HTTPException(404, "文件不存在")
    return target


@router.get("/api/admin/children/{name}/files")
async def api_admin_child_files(request: Request, name: str):
    _admin(request)
    child_dir = await asyncio.to_thread(_child_dir, name)

    def _files() -> list[dict]:
        out = []
        try:
            for p in sorted(child_dir.rglob("*")):
                if (not p.is_file() or p.is_symlink() or p.name.startswith(".")
                        or p.name.endswith(".tmp")):
                    continue
                st = p.stat()
                out.append({"path": p.relative_to(child_dir).as_posix(),
                            "size": st.st_size, "mtime": int(st.st_mtime)})
        except OSError:
            pass
        return out

    return {"name": name, "dir": child_dir.name, "files": await asyncio.to_thread(_files)}


@router.get("/api/admin/children/{name}/file")
async def api_admin_child_file_get(request: Request, name: str, path: str = ""):
    _admin(request)
    child_dir = await asyncio.to_thread(_child_dir, name)
    target = await asyncio.to_thread(_resolve_file, child_dir, path)
    if target.stat().st_size > 512 * 1024:
        raise HTTPException(413, "文件超过 512KB，请到服务器上改")
    text = await asyncio.to_thread(target.read_text, encoding="utf-8")
    if target.suffix == ".json":
        try:  # 编辑器里给格式化版，保存时再校验
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except ValueError:
            pass
    return {"path": path, "text": text}


class ChildFileReq(BaseModel):
    path: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=200_000)


@router.put("/api/admin/children/{name}/file")
async def api_admin_child_file_put(request: Request, name: str, req: ChildFileReq):
    _admin(request)
    child_dir = await asyncio.to_thread(_child_dir, name)
    target = await asyncio.to_thread(
        _resolve_file, child_dir, req.path, must_exist=False)
    if target.suffix == ".json":
        try:
            json.loads(req.content)
        except ValueError as e:
            raise HTTPException(400, f"JSON 不合法：{e}")
    await asyncio.to_thread(store.atomic_write, target, req.content)
    return {"ok": True, "size": target.stat().st_size}


@router.delete("/api/admin/children/{name}/file")
async def api_admin_child_file_del(request: Request, name: str, path: str = ""):
    _admin(request)
    child_dir = await asyncio.to_thread(_child_dir, name)
    target = await asyncio.to_thread(_resolve_file, child_dir, path)
    if target.name == "index.json":
        raise HTTPException(400, "index.json 是档案归属凭证，不能删")
    await asyncio.to_thread(target.unlink)
    return {"ok": True}


# ---------------------------------------------------------------- 共享数据文件

# 后台可管的共享数据文件（白名单）：用户表走用户管理接口，token/settings 不开放
_DATA_FILES = {
    "race_db.json": "本地赛事库",
    "transport_db.json": "交通参考库",
    "aliases.seed.json": "登录名别名种子",
    "profiles.seed.json": "档案映射种子",
    "profiles.json": "档案映射（运行时）",
}


@router.get("/api/admin/data")
async def api_admin_data_list(request: Request):
    _admin(request)
    out = []
    for fname, title in _DATA_FILES.items():
        p = config.DATA_DIR / fname
        rec = {"file": fname, "title": title, "exists": p.is_file()}
        if p.is_file():
            st = p.stat()
            rec.update({"size": st.st_size, "mtime": int(st.st_mtime)})
        out.append(rec)
    return {"files": out}


def _data_path(fname: str) -> Path:
    if fname not in _DATA_FILES:
        raise HTTPException(404, "这个数据文件不在管理范围")
    return config.DATA_DIR / fname


@router.get("/api/admin/data/{fname}")
async def api_admin_data_get(request: Request, fname: str):
    _admin(request)
    p = _data_path(fname)
    if not p.is_file():
        raise HTTPException(404, "文件不存在")
    if p.stat().st_size > 512 * 1024:
        raise HTTPException(413, "文件超过 512KB，请到服务器上改")
    text = await asyncio.to_thread(p.read_text, encoding="utf-8")
    try:
        text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
    except ValueError:
        pass
    return {"file": fname, "title": _DATA_FILES[fname], "text": text}


class DataFileReq(BaseModel):
    text: str = Field(min_length=1, max_length=200_000)


@router.put("/api/admin/data/{fname}")
async def api_admin_data_put(request: Request, fname: str, req: DataFileReq):
    _admin(request)
    p = _data_path(fname)
    try:
        data = json.loads(req.text)
    except ValueError as e:
        raise HTTPException(400, f"JSON 不合法：{e}")
    await asyncio.to_thread(
        store.atomic_write, p, json.dumps(data, ensure_ascii=False, indent=2))
    return {"ok": True, "size": p.stat().st_size}
