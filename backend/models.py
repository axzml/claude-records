import re
import sqlite3
import os
import sys
import time

# Where older versions kept their data: next to the code (a git checkout)
_LEGACY_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')


def _data_dir() -> str:
    """Directory for the index DB and user preferences.

    CLAUDE_RECORDS_DATA_DIR wins; an existing legacy data/ dir keeps being
    used so upgrading never strands an archive; otherwise the per-user data
    dir, which survives reinstalls and is writable without admin rights.
    """
    if os.environ.get('CLAUDE_RECORDS_DATA_DIR'):
        return os.path.abspath(os.path.expanduser(os.environ['CLAUDE_RECORDS_DATA_DIR']))
    if os.path.exists(os.path.join(_LEGACY_DATA_DIR, 'records.db')):
        return _LEGACY_DATA_DIR
    if os.name == 'nt':
        base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~/AppData/Local')
    elif sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
    return os.path.join(base, 'claude-records')


DB_DIR = _data_dir()
DB_PATH = os.path.join(DB_DIR, 'records.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dir_name      TEXT UNIQUE NOT NULL,
    display_name  TEXT NOT NULL,
    session_count INTEGER DEFAULT 0,
    last_active   TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id),
    start_time    TIMESTAMP,
    message_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    uuid          TEXT UNIQUE NOT NULL,
    parent_uuid   TEXT,
    type          TEXT NOT NULL,
    content_type  TEXT,
    content       TEXT,
    model         TEXT,
    timestamp     TIMESTAMP NOT NULL,
    starred       INTEGER DEFAULT 0,
    is_hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_state (
    file_path     TEXT PRIMARY KEY,
    file_size     INTEGER NOT NULL,
    last_offset   INTEGER NOT NULL,
    last_sync     TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_uuid);
"""

def _create_fts(conn: sqlite3.Connection):
    """Create the full-text index over jieba-segmented message text.

    The indexed text (segmented) differs from messages.content (raw), so the
    table must not use messages as an external content table: FTS5 would
    re-tokenize the raw text on DELETE and leave orphaned index entries.
    A contentless table keeps only the index; contentless_delete (SQLite
    3.43+) still allows deleting by rowid. Older SQLite falls back to a
    regular FTS table that stores its own copy of the segmented text.
    """
    try:
        conn.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, content='', contentless_delete=1, tokenize='unicode61')""")
    except sqlite3.OperationalError as e:
        if 'contentless_delete' not in str(e):
            raise
        conn.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content, tokenize='unicode61')""")


def get_db() -> sqlite3.Connection:
    """Get a database connection with WAL mode enabled."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(retries: int = 5, interval: float = 1.0):
    """Initialize database schema and run migrations (with lock retry)."""
    for attempt in range(retries):
        conn = get_db()
        try:
            conn.executescript(SCHEMA)
            _create_fts(conn)
            _migrate(conn)
            conn.commit()
            conn.close()
            return
        except sqlite3.OperationalError:
            conn.close()
            if attempt < retries - 1:
                time.sleep(interval)
            else:
                raise


FTS_VERSION = 3  # Bump when the segmentation strategy or FTS table layout changes.

DEDUP_VERSION = 5  # Bump when the retry/dedup/hide detection strategy changes.


def _needs_fts_rebuild(conn: sqlite3.Connection) -> bool:
    """Check if the FTS index needs rebuilding due to a tokenizer change."""
    try:
        ver = conn.execute(
            "SELECT value FROM pragma_user_config WHERE key = 'fts_version'"
        ).fetchone()
        return not ver or int(ver[0]) < FTS_VERSION
    except Exception:
        return True


def _needs_retry_remark(conn: sqlite3.Connection) -> bool:
    """Check if retry flags need recomputing due to a dedup strategy change."""
    try:
        ver = conn.execute(
            "SELECT value FROM pragma_user_config WHERE key = 'dedup_version'"
        ).fetchone()
        return not ver or int(ver[0]) < DEDUP_VERSION
    except Exception:
        return True


def _migrate(conn: sqlite3.Connection):
    """Add columns that don't exist yet (safe to re-run)."""
    proj_cols = {row[1] for row in conn.execute("PRAGMA table_info(projects)").fetchall()}
    if 'real_path' not in proj_cols:
        conn.execute("ALTER TABLE projects ADD COLUMN real_path TEXT")

    sess_cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if 'starred' not in sess_cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN starred INTEGER DEFAULT 0")
    if 'custom_name' not in sess_cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN custom_name TEXT")
    if 'auto_title' not in sess_cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN auto_title TEXT")
    # Timestamp of the newest message: long-lived sessions (resumed across
    # days) must sort by activity, not by when they were first opened.
    if 'last_active' not in sess_cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN last_active TIMESTAMP")
        conn.execute("""UPDATE sessions SET last_active =
                        (SELECT MAX(timestamp) FROM messages WHERE session_id = sessions.id)""")

    msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
    if 'images' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN images TEXT")
    # is_retry was generalized to is_hidden (retries + system-generated content)
    if 'is_retry' in msg_cols and 'is_hidden' not in msg_cols:
        conn.execute("ALTER TABLE messages RENAME COLUMN is_retry TO is_hidden")
        msg_cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)").fetchall()}
    if 'is_hidden' not in msg_cols:
        conn.execute("ALTER TABLE messages ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")

    # Rebuild FTS index when segmentation strategy or table layout changes.
    # Rebuilt from the messages table rather than by re-parsing JSONL files:
    # Claude Code deletes old transcripts, but their messages stay archived here.
    if _needs_fts_rebuild(conn):
        from backend.indexer import rebuild_fts  # lazy: indexer imports this module
        conn.execute("CREATE TABLE IF NOT EXISTS pragma_user_config(key TEXT PRIMARY KEY, value)")
        conn.execute("DROP TABLE IF EXISTS messages_fts")
        _create_fts(conn)
        rebuild_fts(conn)
        conn.execute("INSERT OR REPLACE INTO pragma_user_config(key, value) VALUES ('fts_version', ?)", (FTS_VERSION,))

    # Recompute hidden flags once when the dedup strategy changes
    if _needs_retry_remark(conn):
        from backend.indexer import purge_meta_messages  # lazy: indexer imports this module
        conn.execute("CREATE TABLE IF NOT EXISTS pragma_user_config(key TEXT PRIMARY KEY, value)")
        purge_meta_messages(conn)
        remark_all_hidden(conn)
        conn.execute("INSERT OR REPLACE INTO pragma_user_config(key, value) VALUES ('dedup_version', ?)", (DEDUP_VERSION,))


# User messages that were generated by Claude Code itself, not typed by the
# user. Context-compaction continuations inject an AI-written summary as a
# "user" turn; Claude Code marks them with isCompactSummary in the JSONL, but
# older versions only emit the fixed English prefix below. The other entries
# cover slash-command invocations, `!` shell command input/output (tag names
# differ across Claude Code versions), and agent-team notifications.
SYSTEM_GENERATED_PREFIXES = (
    'This session is being continued from a previous conversation',
    '<command-name>',
    '<command-message>',
    '<local-command-caveat>',
    '<local-command-stdout>',
    '<bash-input>',
    '<bash-stdout>',
    '<teammate-message',  # no closing '>': the tag carries attributes
    # Skill-content injection: the Skill tool's expanded instructions land as
    # a "user" message. Hiding them also keeps the frontend turn-splitting
    # logic (last assistant text per turn) from treating them as new turns,
    # which would otherwise surface intermediate assistant texts.
    'Base directory for this skill:',
    # isMeta companions (image-size notes, model nudges). New syncs drop
    # isMeta rows entirely; these cover archived sessions whose JSONL is gone.
    '[Image: original ',
    '[Image: source: ',
    '[Your previous response had ',
    # The typed '/compact' line: it triggers compaction, it is not a question
    '/compact',
)

_COMMAND_ARGS_RE = re.compile(r'<command-args>\s*[^<\s]')
_COMMAND_TAG_RE = re.compile(r'<command-(name|args)>([\s\S]*?)</command-\1>')


def _is_prompt_command(rows, i: int) -> bool:
    """Is rows[i] a slash command whose arguments are the user's question?

    Skill invocations like ``/anatomy 做一个科普视频`` carry the real prompt in
    <command-args> and are followed by the expanded skill instructions; local
    commands (``/effort max``, ``/plugin ...``) answer with
    <local-command-stdout> right after and are not part of the dialogue.
    """
    content = (rows[i]['content'] or '').lstrip()
    if not content.startswith(('<command-message>', '<command-name>')):
        return False
    nxt = ((rows[i + 1]['content'] if i + 1 < len(rows) else None) or '').lstrip()
    if nxt.startswith('<local-command-stdout>'):
        return False
    return bool(_COMMAND_ARGS_RE.search(content)) or nxt.startswith('Base directory for this skill:')


def format_command_message(content: str) -> str:
    """Render a slash-command message as typed: ``/anatomy 做一个科普视频``."""
    if not content or not content.lstrip().startswith(('<command-message>', '<command-name>')):
        return content
    parts = {m.group(1): m.group(2).strip() for m in _COMMAND_TAG_RE.finditer(content)}
    if 'name' not in parts:
        return content
    return f"{parts['name']} {parts.get('args', '')}".strip()


def remark_hidden(conn: sqlite3.Connection, session_id: str) -> int:
    """Recompute ``is_hidden`` flags and ``message_count`` for a session.

    A message is hidden when it is an interrupt marker (content starting with
    ``[Request interrupted``), a user message whose content is identical to the
    immediately preceding user message (a Ctrl+C + resend), or a
    system-generated user message (context-compaction summary).
    ``message_count`` is set to the number of non-hidden messages.

    Only the first 500 chars of each message are fetched: every detection
    rule is prefix-based, so this avoids hauling megabytes of content for
    large sessions on every incremental sync.
    """
    rows = conn.execute(
        "SELECT id, type, substr(content, 1, 500) AS content FROM messages "
        "WHERE session_id = ? ORDER BY timestamp ASC, id ASC",
        (session_id,),
    ).fetchall()

    last_user_content = None
    kept = 0
    hidden_ids = []
    for i, r in enumerate(rows):
        is_hidden = False
        if r['type'] == 'user':
            content = (r['content'] or '').strip()
            if content.startswith(SYSTEM_GENERATED_PREFIXES) and not _is_prompt_command(rows, i):
                is_hidden = True
            elif content.startswith('[Request interrupted'):
                is_hidden = True
            elif content and content == last_user_content:
                is_hidden = True
            else:
                last_user_content = content
        else:
            last_user_content = None
        if is_hidden:
            hidden_ids.append(r['id'])
        else:
            kept += 1

    # Only touch rows that actually carry a stale flag (avoids write
    # amplification on large sessions).
    conn.execute(
        "UPDATE messages SET is_hidden = 0 WHERE session_id = ? AND is_hidden = 1",
        (session_id,),
    )
    if hidden_ids:
        placeholders = ','.join('?' * len(hidden_ids))
        conn.execute(
            f"UPDATE messages SET is_hidden = 1 WHERE id IN ({placeholders})",
            hidden_ids,
        )
    conn.execute(
        "UPDATE sessions SET message_count = ? WHERE id = ?",
        (kept, session_id),
    )
    return kept


def remark_all_hidden(conn: sqlite3.Connection):
    """Recompute hidden flags for every session (used on migration)."""
    sessions = conn.execute("SELECT id FROM sessions").fetchall()
    for s in sessions:
        remark_hidden(conn, s['id'])


def session_has_content_sql(ref: str = 'sessions.id') -> str:
    """SQL predicate: the session has at least one visible conversation turn.

    Sessions where Claude Code was opened and closed without any input keep
    only empty system rows; listing endpoints and project session_count use
    this predicate to skip them. ``ref`` is the sessions.id expression of the
    calling query (table name or alias).
    """
    return f"""EXISTS (SELECT 1 FROM messages m
        WHERE m.session_id = {ref} AND m.is_hidden = 0
        AND m.type IN ('user', 'assistant')
        AND ((m.content IS NOT NULL AND m.content != '') OR m.images IS NOT NULL))"""


# Generic parent folders that never name a project (case-insensitive)
_GENERIC_PATH_SEGMENTS = {'users', 'home', 'documents', 'desktop', 'programs',
                          'projects', 'github', 'repos', 'workspace', 'code', 'src'}


def _home_segments() -> set[str]:
    """Segments of the user's home directory, e.g. {'c', 'users', 'alice'}."""
    home = os.path.expanduser('~')
    return {seg.lower() for seg in re.split(r'[\\/:_.\s-]+', home) if seg}


def extract_display_name(dir_name: str) -> str:
    """Extract human-readable project name from encoded directory name.

    Only a fallback: once a session's cwd is known, the project is named after
    the real directory instead.

    E.g. 'C--Users-alice-projects-my-app' -> 'my-app'
    """
    # Path segments to strip (case-insensitive): drive letters, the home
    # directory and generic parent folders
    skip = _GENERIC_PATH_SEGMENTS | _home_segments() | {'c', 'd', 'e'}

    # Split by '--' (which represents path separator in Claude's encoding)
    parts = dir_name.split('--')

    # Take the last part — it's the deepest directory
    last_part = parts[-1] if parts else dir_name

    # The last part may still contain skip-worthy prefixes joined by '-'
    # Try to strip known prefixes from the left
    segments = last_part.split('-')
    while segments and (not segments[0] or segments[0].lower() in skip):
        segments.pop(0)

    if segments:
        return '-'.join(segments)
    # Fallback: use last '--' segment as-is
    return last_part or dir_name
