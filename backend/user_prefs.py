"""Persist user preferences (renames, stars) independently of the DB.

The prefs file survives DB rebuilds and transcript re-indexing (which gives
messages new row ids), so custom names and stars aren't lost. Messages are
keyed by their transcript uuid, which is stable.
"""
import json
import os
import logging
import threading

from backend.models import DB_DIR

logger = logging.getLogger(__name__)

PREFS_PATH = os.path.join(DB_DIR, 'user_prefs.json')

# Flask serves requests on several threads; every save is load-modify-write
_lock = threading.Lock()


def _empty() -> dict:
    return {'project_renames': {}, 'session_renames': {}, 'session_stars': [], 'message_stars': []}


def _load() -> dict:
    if not os.path.exists(PREFS_PATH):
        return _empty()
    try:
        with open(PREFS_PATH, 'r', encoding='utf-8') as f:
            return {**_empty(), **json.load(f)}
    except Exception as e:
        # Keep the unreadable file instead of overwriting it on the next save
        backup = PREFS_PATH + '.bak'
        logger.warning(f"Failed to load user_prefs.json ({e}); moved it to {backup}")
        os.replace(PREFS_PATH, backup)
        return _empty()


def _save(prefs: dict):
    # Write a temp file and swap it in: a crash mid-write can't corrupt prefs
    os.makedirs(os.path.dirname(PREFS_PATH), exist_ok=True)
    tmp = PREFS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(prefs, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PREFS_PATH)


def _update(fn):
    with _lock:
        prefs = _load()
        fn(prefs)
        _save(prefs)


def _toggle_in_list(key: str, item: str, present: bool):
    def fn(prefs):
        items = set(prefs.get(key, []))
        if present:
            items.add(item)
        else:
            items.discard(item)
        prefs[key] = sorted(items)
    _update(fn)


def save_project_rename(dir_name: str, display_name: str):
    """Save a project rename keyed by dir_name (stable across DB rebuilds)."""
    def fn(prefs):
        prefs['project_renames'][dir_name] = display_name
    _update(fn)


def get_project_rename(dir_name: str) -> str | None:
    with _lock:
        return _load()['project_renames'].get(dir_name)


def save_session_rename(session_id: str, custom_name: str | None):
    def fn(prefs):
        if custom_name:
            prefs['session_renames'][session_id] = custom_name
        else:
            prefs['session_renames'].pop(session_id, None)
    _update(fn)


def save_session_star(session_id: str, starred: bool):
    _toggle_in_list('session_stars', session_id, starred)


def save_message_star(uuid: str, starred: bool):
    _toggle_in_list('message_stars', uuid, starred)


def apply_message_stars(conn, session_id: str):
    """Re-apply message stars after a session was re-indexed from scratch."""
    with _lock:
        uuids = _load()['message_stars']
    for i in range(0, len(uuids), 500):  # stay under SQLite's variable limit
        batch = uuids[i:i + 500]
        conn.execute(
            f"UPDATE messages SET starred = 1 WHERE session_id = ? AND uuid IN ({','.join('?' * len(batch))})",
            [session_id] + batch
        )


def apply_prefs_to_db(conn):
    """Apply saved preferences to a freshly built DB."""
    # Message stars used to live only in the DB: adopt any not yet in prefs
    db_stars = {r[0] for r in conn.execute(
        "SELECT uuid FROM messages WHERE starred = 1 AND uuid IS NOT NULL")}

    def adopt(prefs):
        prefs['message_stars'] = sorted(set(prefs['message_stars']) | db_stars)
    _update(adopt)

    with _lock:
        prefs = _load()

    for dir_name, name in prefs['project_renames'].items():
        conn.execute(
            "UPDATE projects SET display_name = ? WHERE dir_name = ?",
            (name, dir_name)
        )

    for session_id, name in prefs['session_renames'].items():
        conn.execute(
            "UPDATE sessions SET custom_name = ? WHERE id = ?",
            (name, session_id)
        )

    for session_id in prefs['session_stars']:
        conn.execute(
            "UPDATE sessions SET starred = 1 WHERE id = ?",
            (session_id,)
        )

    for uuid in prefs['message_stars']:
        conn.execute("UPDATE messages SET starred = 1 WHERE uuid = ?", (uuid,))

    conn.commit()
