# x_search_twscrape.py
# Usage:
#   python x_search_twscrape.py
# Setup:
#   pip install "git+https://github.com/vladkens/twscrape.git" python-dotenv
# First run:
#   Put .env next to this file with X_COOKIES=auth_token=...;ct0=...
#   (or with X_USER, X_PASS, X_EMAIL, X_EMAIL_PASS if you prefer credentials)

import os, csv, re, asyncio, datetime
from dataclasses import dataclass
from typing import Iterable, List, Set
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv, find_dotenv
from twscrape import API
from twscrape.logger import set_log_level

# ---------- Robust .env loading ----------
_ENV_PATH = find_dotenv(filename=".env", usecwd=True)
if not _ENV_PATH:
    _ENV_PATH = str(Path(__file__).resolve().parent / ".env")
load_dotenv(dotenv_path=_ENV_PATH, override=False)

# ---------- Config ----------
QUERY = '(indihome OR "IndiHome" OR telkomsel OR tsel) lang:id -filter:retweets -filter:replies'
EXCLUDE_AUTHORS = {"telkomsel", "indihome"}  # handles to exclude
LIMIT = 1500
OUT_PREFIX = "Indihome"
OUTPUT_TZ = "Asia/Jakarta"
CSV_DELIMITER = ";"
CSV_QUOTECHAR = '"'
CSV_ENCODING = "utf-8-sig"  # Excel-friendly BOM
set_log_level("INFO")

HEADER = ["UserName", "Handle", "Timestamp", "Text", "Emojis", "Comments", "Retweets", "Likes"]

# Use a DB file **next to this script** so we always hit the same DB
DB_PATH = str((Path(__file__).resolve().parent / "accounts.db"))

# ---------- Helpers ----------
def emojis_from_text(text: str) -> str:
    return "".join(
        ch for ch in text
        if ("\U0001F300" <= ch <= "\U0001FAFF") or ("\u2700" <= ch <= "\u27BF")
    )

def clean_text(s: str) -> str:
    if not s:
        return ""
    return s.replace("\x00", "").replace("\r\n", "\n")

def now_stamp(tz: str = OUTPUT_TZ) -> str:
    return datetime.datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d_%H-%M")

@dataclass
class Row:
    name: str
    handle: str
    timestamp: str
    text: str
    emojis: str
    comments: int
    retweets: int
    likes: int

    def to_list(self) -> List:
        return [
            clean_text(self.name),
            clean_text(self.handle),
            clean_text(self.timestamp),
            clean_text(self.text),
            clean_text(self.emojis),
            int(self.comments),
            int(self.retweets),
            int(self.likes),
        ]

def write_csv(rows: Iterable[Row], out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = out_dir / f"{OUT_PREFIX}_{now_stamp()}.csv"
    with open(fname, "w", newline="", encoding=CSV_ENCODING) as f:
        writer = csv.writer(
            f, delimiter=CSV_DELIMITER, quotechar=CSV_QUOTECHAR,
            quoting=csv.QUOTE_MINIMAL, lineterminator="\n"
        )
        writer.writerow(HEADER)
        for r in rows:
            writer.writerow(r.to_list())
    return fname

def validate_csv(path: Path) -> None:
    with open(path, "r", encoding=CSV_ENCODING, newline="") as f:
        rows = list(csv.reader(f, delimiter=CSV_DELIMITER, quotechar=CSV_QUOTECHAR))
    if not rows:
        raise RuntimeError("CSV validation failed: file is empty.")
    if rows[0] != HEADER:
        raise RuntimeError(f"CSV validation failed: header mismatch.\nExpected: {HEADER}\nFound:   {rows[0]}")
    for i, r in enumerate(rows[1:], start=2):
        if len(r) != len(HEADER):
            raise RuntimeError(f"CSV validation failed: wrong column count at row {i} (got {len(r)})")

def _mask(v: str) -> str:
    if not v:
        return "(missing)"
    return v[:2] + "*" * max(0, len(v) - 4) + v[-2:]

def _normalize_cookies(s: str | None) -> str | None:
    if not s:
        return None
    # Remove spaces around parts; drop empty segments; ensure no trailing semicolon.
    parts = [p.strip() for p in s.split(";") if p.strip()]
    # Prefer auth_token first (some libs are picky)
    parts_sorted = sorted(parts, key=lambda p: 0 if p.startswith("auth_token=") else 1)
    return ";".join(parts_sorted)

# ---------- Login / Accounts ----------
async def ensure_login(api: API) -> None:
    async def _verify() -> bool:
        try:
            await api.user_by_login("twitter")  # harmless call that needs auth
            return True
        except Exception:
            return False

    # Try logging in accounts already in this DB
    try:
        await api.pool.login_all()
        if await _verify():
            return
    except Exception:
        pass

    # Try from .env
    user = os.getenv("X_USER") or ""
    pwd = os.getenv("X_PASS") or ""
    email = os.getenv("X_EMAIL") or ""
    email_pass = os.getenv("X_EMAIL_PASS") or ""
    cookies_raw = os.getenv("X_COOKIES") or ""
    cookies = _normalize_cookies(cookies_raw)

    print(f"[env] from: {_ENV_PATH}")
    print(f"[env] X_USER={_mask(user)}  X_PASS={_mask(pwd)}  X_EMAIL={_mask(email)}  X_EMAIL_PASS={_mask(email_pass)}")
    print(f"[env] X_COOKIES={'present' if cookies else 'missing'}")

    # Prefer cookies path (more reliable than login challenges)
    if cookies:
        # Important: pass the username that owns these cookies if you know it
        await api.pool.add_account(user or "cookie_user", "", "", "", cookies=cookies)
    elif all([user, pwd, email, email_pass]):
        await api.pool.add_account(user, pwd, email, email_pass)
    else:
        raise SystemExit(
            "No active accounts and .env missing required values.\n"
            f"Tried to load: {_ENV_PATH}\n"
            "Fix: set X_COOKIES (auth_token & ct0) or provide X_USER/X_PASS/X_EMAIL/X_EMAIL_PASS."
        )

    await api.pool.login_all()
    if not await _verify():
        raise SystemExit(
            "Login verification failed (still no active accounts).\n"
            "Double-check that X_COOKIES is 'auth_token=...;ct0=...' (no spaces/trailing ;) "
            "and that the cookies are still valid."
        )

# ---------- Core ----------
async def collect_tweets(query: str, limit: int) -> List[Row]:
    api = API(DB_PATH)  # use the local DB path
    await ensure_login(api)

    seen_ids: Set[int] = set()
    rows: List[Row] = []
    kw = re.compile(r"\b(indihome|tsel|telkomsel)\b", flags=re.I)

    async for tw in api.search(query, limit=limit):
        try:
            tid = getattr(tw, "id", None)
            if tid is None or tid in seen_ids:
                continue
            seen_ids.add(tid)

            user = getattr(tw, "user", None)
            handle = (getattr(user, "username", "") or "").strip()
            name = (getattr(user, "displayname", "") or "").strip()
            if handle.lower() in EXCLUDE_AUTHORS:
                continue

            text = (getattr(tw, "rawContent", None) or getattr(tw, "content", "") or "").strip()
            if not text or not kw.search(text):
                continue

            reply_count = int(getattr(tw, "replyCount", 0) or 0)
            retweet_count = int(getattr(tw, "retweetCount", 0) or 0)
            like_count = int(getattr(tw, "likeCount", 0) or 0)

            dt = getattr(tw, "date", None)
            if not dt:
                continue
            ts = dt.astimezone(ZoneInfo(OUTPUT_TZ)).isoformat(timespec="seconds")
            emojis = emojis_from_text(text)

            rows.append(Row(
                name=name,
                handle=f"@{handle}" if handle else "",
                timestamp=ts,
                text=text,
                emojis=emojis,
                comments=reply_count,
                retweets=retweet_count,
                likes=like_count
            ))
        except Exception:
            continue

    rows.sort(key=lambda r: r.timestamp, reverse=True)
    return rows

async def main():
    data = await collect_tweets(QUERY, LIMIT)
    if not data:
        raise SystemExit("No tweets collected. Most likely no active accounts or the query returned nothing.")
    out_dir = Path(".")
    csv_path = write_csv(data, out_dir)
    validate_csv(csv_path)
    print(f"✅ CSV OK — {len(data)} rows written to: {csv_path.resolve()}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except RuntimeError as e:
        if "asyncio.run() cannot be called from a running event loop" in str(e):
            try:
                import nest_asyncio
                nest_asyncio.apply()
                loop = asyncio.get_event_loop()
                loop.run_until_complete(main())
            except ImportError:
                raise SystemExit(
                    "Active event loop detected (Jupyter/VSCode). "
                    "Install nest_asyncio or just: await main()"
                )
        else:
            raise
