import json
import os
import logging
import re
import sqlite3
import time
from datetime import datetime, timezone

import jieba

jieba.setLogLevel(logging.WARNING)  # silence the 'Building prefix dict' banner

from backend import user_prefs

from backend.models import (get_db, extract_display_name, remark_hidden, session_has_content_sql,
                            SYSTEM_GENERATED_PREFIXES)

logger = logging.getLogger(__name__)

# Claude Code honours CLAUDE_CONFIG_DIR for its config/transcript location
CLAUDE_PROJECTS_DIR = os.path.join(
    os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.claude'), 'projects')

# Matches ANSI escape sequences: CSI codes (\x1b[...letter), OSC codes (\x1b]...BEL/ST)
ANSI_ESCAPE_RE = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\\[^\x1b]*\x1b\\')


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from text for clean web display."""
    if not text:
        return text
    return ANSI_ESCAPE_RE.sub('', text)


def _collect_images(content_blocks: list) -> list[dict]:
    """Collect base64 image data from content blocks (including nested tool_result)."""
    images = []

    def _walk(block):
        if not isinstance(block, dict):
            return
        if block.get('type') == 'image':
            source = block.get('source', {})
            if source.get('type') == 'base64' and source.get('data'):
                images.append({
                    'media_type': source.get('media_type', 'image/png'),
                    'data': source['data'],
                })
        elif block.get('type') == 'tool_result':
            nested = block.get('content', [])
            if isinstance(nested, list):
                for sub in nested:
                    _walk(sub)

    for block in content_blocks:
        _walk(block)
    return images


def segment_text(text: str) -> str:
    """Segment text with jieba for FTS5 indexing.

    Uses cut_for_search (search mode) which produces sub-word tokens so that
    partial / ambiguous queries still match.  For example "机器学习" yields
    both the compound token "机器学习" and the sub-tokens "机器" and "学习".
    """
    if not text:
        return ''
    return ' '.join(jieba.cut_for_search(text))


_warned_missing_dir = False


def scan_jsonl_files() -> list[str]:
    """Find all .jsonl files under ~/.claude/projects/."""
    files = []
    if not os.path.isdir(CLAUDE_PROJECTS_DIR):
        # Called on every status poll: warn once, not every 30 seconds
        global _warned_missing_dir
        if not _warned_missing_dir:
            _warned_missing_dir = True
            logger.warning(f"Claude projects dir not found: {CLAUDE_PROJECTS_DIR}")
        return files
    for project_dir in os.listdir(CLAUDE_PROJECTS_DIR):
        project_path = os.path.join(CLAUDE_PROJECTS_DIR, project_dir)
        if not os.path.isdir(project_path):
            continue
        for fname in os.listdir(project_path):
            if fname.endswith('.jsonl'):
                files.append(os.path.join(project_path, fname))
    return files


def _extract_cwd(file_path: str) -> str | None:
    """Extract the working directory from the first JSONL record with a cwd.

    Newer Claude Code versions open the file with several metadata records
    (mode, permission-mode, api-request...) that carry no cwd.
    """
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            for _ in range(50):
                line = f.readline().strip()
                if not line:
                    continue
                obj = json.loads(line)
                cwd = obj.get('cwd')
                if cwd:
                    return cwd.replace('\\', '/')
    except Exception:
        pass
    return None


def _make_auto_title(content: str, max_len: int = 80) -> str:
    """Create a short title from the first user message content."""
    text = content.strip()
    # A slash command with arguments (e.g. "/anatomy 拆解一下 CPU") carries the
    # user's actual prompt in <command-args>.
    args = re.search(r'<command-args>([\s\S]*?)</command-args>', text)
    if args and args.group(1).strip():
        name = re.search(r'<command-name>([\s\S]*?)</command-name>', text)
        text = f"{name.group(1).strip().lstrip('/') if name else ''} {args.group(1).strip()}".strip()
    # Check machine-generated prefixes BEFORE stripping tags: once the tags
    # are gone, e.g. <local-command-caveat> text looks like a normal prompt.
    elif text.startswith(SYSTEM_GENERATED_PREFIXES):
        return ''
    # Strip XML-like tags (e.g. <command-name>, <system-reminder>)
    text = re.sub(r'<[^>]+>', '', text)
    # Remove code fences
    text = re.sub(r'```[\s\S]*?```', '', text)
    # Remove leading # or -
    text = re.sub(r'^#+\s+', '', text)
    text = re.sub(r'^[-*]\s+', '', text)
    # Collapse newlines for single-line title
    text = re.sub(r'\n[\s]*', ' ', text)
    text = text.strip()
    if not text:
        return ''
    # Skip known non-content patterns
    skip_patterns = [
        r'^\[Request interrupted',
        r'^This session is being continued',  # compaction summaries
        r'^\[cancelled\]',
        r'^\[error\]',
        r'^\[abort\]',
        r'^\[System Prompt:',
        r'^Caveat:',
        r'^/cancel',
        r'^/clear',
        r'^/compact',
        r'^oh-my-claudecode:',  # OMC skill invocations
        r'^/[^\s]+[\s\n]',  # slash commands like "/help", "/mcp list"
        r'^\.$',  # single character
        r'^\s*$',  # whitespace only
        r'^[A-Za-z]:[/\\]',  # Windows paths
        r'^/home/',  # Linux paths
        r'^/Users/',  # macOS paths
    ]
    for pat in skip_patterns:
        if re.match(pat, text, re.IGNORECASE):
            return ''
    if len(text) < 5:
        return ''
    # Truncate at max_len, break at word boundary
    if len(text) <= max_len:
        return text
    truncated = text[:max_len]
    for i in range(len(truncated) - 1, max(0, len(truncated) - 20), -1):
        if truncated[i] in ' \t\n' or re.match(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]', truncated[i]):
            return truncated[:i].rstrip() + '...'
    return truncated.rstrip() + '...'


def parse_message(obj: dict, session_id: str) -> list[dict]:
    """Parse a JSONL object into message rows.

    Returns a list of message dicts (one for user/system/progress,
    potentially multiple for assistant with content blocks).
    """
    msg_type = obj.get('type')
    if msg_type not in ('user', 'assistant', 'system', 'progress'):
        return []

    base_uuid = obj.get('uuid', '')
    parent_uuid = obj.get('parentUuid')
    timestamp = obj.get('timestamp', '')
    message = obj.get('message')
    if not isinstance(message, dict):
        message = {}

    if msg_type == 'user':
        raw_content = message.get('content', '')
        # Skip internal notifications (background task results, etc.)
        if isinstance(raw_content, str) and raw_content.strip().startswith('<task-notification>'):
            return []
        # isMeta rows are injected by Claude Code, not typed by the user
        # (image-size notes, skill instructions, command caveats). Indexing
        # them as user turns breaks the one-question-one-answer view.
        if obj.get('isMeta'):
            return []
        images_json = None
        if isinstance(raw_content, list):
            text_parts = [
                c.get('text', '') for c in raw_content
                if isinstance(c, dict) and c.get('type') == 'text'
            ]
            content = ' '.join(text_parts)
            images = _collect_images(raw_content)
            if images:
                images_json = json.dumps(images, ensure_ascii=False)
        else:
            content = raw_content
        content = strip_ansi(content)
        return [{
            'uuid': base_uuid,
            'session_id': session_id,
            'parent_uuid': parent_uuid,
            'type': 'user',
            'content_type': 'text',
            'content': content,
            'images': images_json,
            'content_segmented': segment_text(content),
            'model': None,
            'timestamp': timestamp,
        }]

    if msg_type == 'assistant':
        model = message.get('model', '')
        content_blocks = message.get('content', [])
        if not isinstance(content_blocks, list):
            return []

        rows = []
        for i, block in enumerate(content_blocks):
            if not isinstance(block, dict):
                continue
            block_type = block.get('type', '')
            if block_type == 'text':
                text = strip_ansi(block.get('text', ''))
                rows.append({
                    'uuid': f"{base_uuid}-{i}" if len(content_blocks) > 1 else base_uuid,
                    'session_id': session_id,
                    'parent_uuid': parent_uuid,
                    'type': 'assistant',
                    'content_type': 'text',
                    'content': text,
                    'content_segmented': segment_text(text),
                    'model': model,
                    'timestamp': timestamp,
                })
            elif block_type == 'thinking':
                text = strip_ansi(block.get('thinking', ''))
                rows.append({
                    'uuid': f"{base_uuid}-{i}" if len(content_blocks) > 1 else base_uuid,
                    'session_id': session_id,
                    'parent_uuid': parent_uuid,
                    'type': 'assistant',
                    'content_type': 'thinking',
                    'content': text,
                    'content_segmented': segment_text(text),
                    'model': model,
                    'timestamp': timestamp,
                })
            elif block_type == 'tool_use':
                tool_name = block.get('name', '')
                tool_input = json.dumps(block.get('input', {}), ensure_ascii=False)
                content_str = f"{tool_name}: {tool_input}"
                rows.append({
                    'uuid': f"{base_uuid}-{i}" if len(content_blocks) > 1 else base_uuid,
                    'session_id': session_id,
                    'parent_uuid': parent_uuid,
                    'type': 'assistant',
                    'content_type': 'tool_use',
                    'content': content_str,
                    'content_segmented': None,
                    'model': model,
                    'timestamp': timestamp,
                })
        return rows

    # system or progress
    content = ''
    if isinstance(message, dict):
        content = message.get('content', '')
    if not isinstance(content, str):
        content = str(obj.get('content', '') or obj.get('data', ''))
    content = strip_ansi(content)
    return [{
        'uuid': base_uuid,
        'session_id': session_id,
        'parent_uuid': parent_uuid,
        'type': msg_type,
        'content_type': None,
        'content': content[:500],
        'content_segmented': None,
        'model': None,
        'timestamp': timestamp,
    }]


def sync_file(conn, file_path: str):
    """Incrementally sync a single JSONL file into the database."""
    file_size = os.path.getsize(file_path)
    reindexed = False

    row = conn.execute(
        "SELECT file_size, last_offset FROM sync_state WHERE file_path = ?",
        (file_path,)
    ).fetchone()

    if row:
        if file_size == row['file_size']:
            return 0
        if file_size < row['file_size']:
            logger.warning(f"File shrunk, re-indexing: {file_path}")
            session_id = os.path.splitext(os.path.basename(file_path))[0]
            conn.execute(
                "DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)",
                (session_id,)
            )
            conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            offset = 0
            reindexed = True
        else:
            offset = row['last_offset']
    else:
        offset = 0

    parts = file_path.replace('\\', '/').split('/')
    project_dir = parts[-2]
    session_id = os.path.splitext(parts[-1])[0]

    display_name = extract_display_name(project_dir)
    conn.execute(
        "INSERT OR IGNORE INTO projects (dir_name, display_name) VALUES (?, ?)",
        (project_dir, display_name)
    )
    project_id = conn.execute(
        "SELECT id FROM projects WHERE dir_name = ?", (project_dir,)
    ).fetchone()['id']

    # Extract real path from first JSONL line's cwd field
    if offset == 0 or not conn.execute(
        "SELECT real_path FROM projects WHERE id = ?", (project_id,)
    ).fetchone()['real_path']:
        real_path = _extract_cwd(file_path)
        if real_path:
            _set_real_path(conn, project_id, project_dir, real_path)

    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, project_id) VALUES (?, ?)",
        (session_id, project_id)
    )

    count = 0
    new_offset = offset
    ai_title = None
    # errors='replace': one corrupt byte must not block the rest of the file
    with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
        f.seek(offset)
        while True:
            line_start = f.tell()
            line = f.readline()
            if not line:
                break
            if not line.endswith('\n'):
                new_offset = line_start
                break
            new_offset = f.tell()
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                logger.warning(f"Malformed JSON at offset {line_start} in {file_path}")
                continue
            if not isinstance(obj, dict):
                continue

            # Claude Code periodically writes an AI-generated session title;
            # the latest one wins.
            if obj.get('type') == 'ai-title' and obj.get('aiTitle'):
                ai_title = obj['aiTitle'].strip()
                continue

            try:
                rows = parse_message(obj, session_id)
            except Exception as e:
                # An unexpected record shape must not stall the whole file:
                # sync_state would never advance and every poll would retry
                logger.warning(f"Skipping unparsable record at offset {line_start} in {file_path}: {e}")
                continue
            for row in rows:
                try:
                    cur = conn.execute(
                        """INSERT OR IGNORE INTO messages
                           (session_id, uuid, parent_uuid, type, content_type, content, model, timestamp, images)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (row['session_id'], row['uuid'], row['parent_uuid'],
                         row['type'], row['content_type'], row['content'],
                         row['model'], row['timestamp'], row.get('images'))
                    )
                    if cur.rowcount == 0:
                        continue  # uuid already indexed
                    if row['content_segmented']:
                        conn.execute(
                            "INSERT INTO messages_fts(rowid, content) VALUES (?, ?)",
                            (cur.lastrowid, row['content_segmented'])
                        )
                    count += 1
                except Exception as e:
                    logger.warning(f"Failed to insert message {row['uuid']}: {e}")

    if reindexed:  # rows got new ids: bring back the user's message stars
        user_prefs.apply_message_stars(conn, session_id)

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT OR REPLACE INTO sync_state (file_path, file_size, last_offset, last_sync)
           VALUES (?, ?, ?, ?)""",
        (file_path, file_size, new_offset, now)
    )

    first_ts, last_ts = conn.execute(
        "SELECT MIN(timestamp), MAX(timestamp) FROM messages WHERE session_id = ?",
        (session_id,)
    ).fetchone()
    conn.execute(
        "UPDATE sessions SET start_time = ?, last_active = ? WHERE id = ?",
        (first_ts, last_ts, session_id)
    )
    if ai_title:
        conn.execute(
            "UPDATE sessions SET auto_title = ? WHERE id = ?",
            (ai_title, session_id)
        )

    # Recompute hidden flags and deduped message_count for this session
    # (skip when nothing new was parsed — flags are already up to date)
    if count > 0:
        remark_hidden(conn, session_id)

    # Generate auto_title from first substantive user message if not already
    # set. Runs after remark_hidden: only visible messages are candidates, so
    # local commands like "/effort high" never become titles.
    if not conn.execute(
        "SELECT auto_title FROM sessions WHERE id = ? AND auto_title IS NOT NULL",
        (session_id,)
    ).fetchone():
        user_msgs = conn.execute(
            """SELECT content FROM messages
               WHERE session_id = ? AND type = 'user' AND is_hidden = 0
               AND content IS NOT NULL AND content != ''
               ORDER BY timestamp ASC LIMIT 5""",
            (session_id,)
        ).fetchall()
        for msg in user_msgs:
            title = _make_auto_title(msg['content'])
            if title:
                conn.execute(
                    "UPDATE sessions SET auto_title = ? WHERE id = ?",
                    (title, session_id)
                )
                break

    return count


def _fix_missing_titles(conn) -> int:
    """Retroactively generate auto_title for sessions that don't have one."""
    sessions = conn.execute("""
        SELECT s.id FROM sessions s
        WHERE s.auto_title IS NULL
        AND (SELECT COUNT(*) FROM messages
             WHERE session_id = s.id AND type = 'user'
             AND is_hidden = 0 AND content IS NOT NULL AND content != '') > 0
    """).fetchall()

    fixed = 0
    for s in sessions:
        msgs = conn.execute("""
            SELECT content FROM messages
            WHERE session_id = ? AND type = 'user' AND is_hidden = 0
            AND content IS NOT NULL AND content != ''
            ORDER BY timestamp ASC LIMIT 5
        """, (s['id'],)).fetchall()
        for m in msgs:
            title = _make_auto_title(m['content'])
            if title:
                conn.execute(
                    'UPDATE sessions SET auto_title = ? WHERE id = ?',
                    (title, s['id'])
                )
                fixed += 1
                break
    if fixed:
        logger.info(f"Fixed auto_title for {fixed} sessions")
    return fixed


def rebuild_fts(conn, batch_size: int = 2000) -> int:
    """Re-segment and re-index every searchable message into messages_fts.

    Mirrors parse_message: user text and assistant text/thinking blocks are
    indexed; tool_use, system and progress rows are not.
    """
    cur = conn.execute(
        """SELECT id, content FROM messages
           WHERE content IS NOT NULL AND content != ''
           AND (type = 'user' OR (type = 'assistant' AND content_type IN ('text', 'thinking')))"""
    )
    total = 0
    while True:
        rows = cur.fetchmany(batch_size)
        if not rows:
            break
        conn.executemany(
            "INSERT INTO messages_fts(rowid, content) VALUES (?, ?)",
            [(r[0], segment_text(r[1])) for r in rows]
        )
        total += len(rows)
        logger.info(f"Rebuilding search index: {total} messages")
    return total


def purge_meta_messages(conn) -> int:
    """Delete already-indexed isMeta user rows (see parse_message).

    Only transcripts still on disk can be checked; archived sessions rely on
    the SYSTEM_GENERATED_PREFIXES fallback in remark_hidden.
    """
    uuids = []
    for (file_path,) in conn.execute("SELECT file_path FROM sync_state").fetchall():
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    if '"isMeta":true' not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if obj.get('type') == 'user' and obj.get('uuid'):
                        uuids.append(obj['uuid'])
        except OSError:
            continue
    for i in range(0, len(uuids), 500):
        chunk = uuids[i:i + 500]
        placeholders = ','.join('?' * len(chunk))
        conn.execute(
            f"DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE uuid IN ({placeholders}))",
            chunk
        )
        conn.execute(f"DELETE FROM messages WHERE uuid IN ({placeholders})", chunk)
    logger.info(f"Purged {len(uuids)} isMeta messages")
    return len(uuids)


TITLE_VERSION = 3  # Bump when the auto_title strategy changes.


def _read_last_ai_title(file_path: str) -> str | None:
    """Return the most recent ``ai-title`` record in a JSONL file, if any."""
    title = None
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                # Cheap substring filter: avoid json-parsing every line
                if '"ai-title"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get('type') == 'ai-title' and obj.get('aiTitle'):
                    title = obj['aiTitle'].strip()
    except OSError:
        pass
    return title


def _backfill_titles(conn) -> None:
    """Recompute every auto_title once after a title-strategy change.

    Incremental sync only sees new lines, so ai-title records in already
    indexed files and titles produced by the old heuristic need a one-time
    pass. Sessions without an ai-title are reset to NULL and picked up by
    _fix_missing_titles.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS pragma_user_config(key TEXT PRIMARY KEY, value)")
    ver = conn.execute(
        "SELECT value FROM pragma_user_config WHERE key = 'title_version'"
    ).fetchone()
    if ver and int(ver[0]) >= TITLE_VERSION:
        return
    conn.execute("UPDATE sessions SET auto_title = NULL")
    for row in conn.execute("SELECT file_path FROM sync_state").fetchall():
        title = _read_last_ai_title(row['file_path'])
        if title:
            session_id = os.path.splitext(os.path.basename(row['file_path']))[0]
            conn.execute("UPDATE sessions SET auto_title = ? WHERE id = ?", (title, session_id))
    conn.execute(
        "INSERT OR REPLACE INTO pragma_user_config(key, value) VALUES ('title_version', ?)",
        (TITLE_VERSION,)
    )
    logger.info("Backfilled session titles")


def _set_real_path(conn, project_id: int, dir_name: str, real_path: str) -> None:
    """Record a project's real directory and name it after it, unless the
    user renamed the project."""
    name = user_prefs.get_project_rename(dir_name) or os.path.basename(real_path)
    conn.execute(
        "UPDATE projects SET real_path = ?, display_name = ? WHERE id = ?",
        (real_path, name, project_id)
    )


def _backfill_real_paths(conn) -> None:
    """Fill projects.real_path for projects whose files were indexed before
    the cwd lookup could find it (incremental sync never re-reads old lines)."""
    missing = {r['dir_name']: r['id'] for r in conn.execute(
        "SELECT id, dir_name FROM projects WHERE real_path IS NULL").fetchall()}
    if not missing:
        return
    for row in conn.execute("SELECT file_path FROM sync_state").fetchall():
        project_id = missing.get(os.path.basename(os.path.dirname(row['file_path'])))
        if project_id is None:
            continue
        real_path = _extract_cwd(row['file_path'])
        if real_path:
            _set_real_path(conn, project_id, os.path.basename(os.path.dirname(row['file_path'])), real_path)
            missing = {k: v for k, v in missing.items() if v != project_id}


def _retry_sync_file(file_path: str, max_retries: int = 3) -> int:
    """Sync a single file with retry on database lock."""
    for attempt in range(max_retries):
        conn = get_db()
        try:
            count = sync_file(conn, file_path)
            conn.commit()
            return count
        except sqlite3.OperationalError:
            conn.rollback()
            if attempt < max_retries - 1:
                time.sleep(1 * (attempt + 1))
            else:
                logger.error(f"Failed to sync {file_path} after {max_retries} retries")
        except Exception as e:
            conn.rollback()
            logger.error(f"Error syncing {file_path}: {e}")
            break
        finally:
            conn.close()
    return 0


def run_sync() -> dict:
    """Run incremental sync for all JSONL files. Returns stats."""
    files = scan_jsonl_files()
    total_new = 0
    files_updated = 0

    for file_path in files:
        count = _retry_sync_file(file_path)
        if count > 0:
            files_updated += 1
            total_new += count

    # Retry aggregation UPDATE on database lock
    for attempt in range(5):
        conn = get_db()
        try:
            conn.execute(f"""
                UPDATE projects SET
                    session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = projects.id
                                     AND {session_has_content_sql('sessions.id')}),
                    last_active = (SELECT MAX(last_active) FROM sessions WHERE project_id = projects.id)
            """)
            _backfill_titles(conn)
            _backfill_real_paths(conn)
            _fix_missing_titles(conn)
            conn.commit()
            conn.close()
            break
        except sqlite3.OperationalError:
            conn.close()
            if attempt < 4:
                time.sleep(2)
            else:
                raise

    return {
        'files_scanned': len(files),
        'files_updated': files_updated,
        'messages_added': total_new,
    }
