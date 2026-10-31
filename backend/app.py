import os
import re
import logging
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

from flask import Flask, jsonify, request, send_from_directory, abort

from backend.models import get_db, init_db, session_has_content_sql, format_command_message
from backend.indexer import run_sync, scan_jsonl_files
from backend.search import search
from backend import user_prefs, embedding

logger = logging.getLogger(__name__)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='')

_LOCAL_HOSTNAMES = {'localhost', '127.0.0.1', '::1'}


@app.before_request
def _reject_foreign_requests():
    """Only serve the local UI; the data is the user's private transcripts.

    Binding to localhost is not enough on its own: any web page open in the
    user's browser can send requests to localhost.
    - Host check: defeats DNS rebinding, where an attacker's domain is made
      to resolve to 127.0.0.1 so the browser treats it as same-origin.
    - Origin check: browsers attach Origin to cross-site requests (fetch,
      form posts), so this blocks other sites from triggering writes such
      as starring or renaming. Same-origin GETs and curl send no Origin.
    - Sec-Fetch-Site check on the API: other sites can still make the
      browser navigate to or embed an API URL (no Origin header is sent for
      that), e.g. to probe which local image paths exist.
    No CORS headers are ever sent, so other origins cannot read responses.
    """
    if urlsplit('//' + request.host).hostname not in _LOCAL_HOSTNAMES:
        abort(403)
    origin = request.headers.get('Origin')
    if origin and urlsplit(origin).hostname not in _LOCAL_HOSTNAMES:
        abort(403)
    # 'none' = typed URL / bookmark; absent = non-browser client such as curl
    if request.path.startswith('/api/') and \
            request.headers.get('Sec-Fetch-Site', 'none') not in ('same-origin', 'none'):
        abort(403)


@app.after_request
def _security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    if request.path == '/api/file/image':
        # Local files are untrusted: never let one run script in our origin
        response.headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    return response

_last_sync_time = None
_last_sync_stats = {}
_sync_lock = threading.Lock()


def _db_write(fn, retries=5, interval=0.5):
    """Execute a DB write function with retry on database lock."""
    for attempt in range(retries):
        conn = get_db()
        try:
            result = fn(conn)
            conn.close()
            return result
        except sqlite3.OperationalError:
            conn.close()
            if attempt < retries - 1:
                time.sleep(interval)
            else:
                raise


def _check_pending_changes() -> bool:
    """Check if any JSONL files have changed since last sync."""
    conn = get_db()
    try:
        synced = dict(conn.execute("SELECT file_path, file_size FROM sync_state").fetchall())
    finally:
        conn.close()
    for file_path in scan_jsonl_files():
        try:
            if synced.get(file_path) != os.path.getsize(file_path):
                return True
        except OSError:  # file removed between scan and stat
            continue
    return False


def _start_background_sync() -> bool:
    """Run run_sync() in a worker thread unless one is already running.

    Keeps /api/sync/status fast: while a Claude Code session is active its
    JSONL grows constantly, and a blocking sync would stall every poll.
    Returns True when a sync is (now) in progress.
    """
    if not _sync_lock.acquire(blocking=False):
        return True

    def _worker():
        global _last_sync_time, _last_sync_stats
        try:
            _last_sync_stats = run_sync()
            _last_sync_time = datetime.now(timezone.utc).isoformat()
            embedding.notify()
        except Exception as e:
            logger.error(f"Background sync failed: {e}")
        finally:
            _sync_lock.release()

    threading.Thread(target=_worker, daemon=True).start()
    return True


def _dir_name_to_path(dir_name: str) -> str:
    """Convert encoded dir_name back to a readable path.

    E.g. 'C--Users-alice-projects-foo' -> 'C:/Users/alice/projects/foo'
    """
    # Claude encodes each path segment separated by '--'.
    # Within segments, '-' may represent folder separator or literal dash.
    # We try to reconstruct by testing if paths exist on disk.
    parts = dir_name.split('--')
    if not parts:
        return dir_name

    # Build root (drive letter on Windows)
    if len(parts[0]) == 1 and parts[0].isalpha():
        root = parts[0] + ':/'
        rest = parts[1:]
    else:
        root = '/'
        rest = parts

    # Each '--' segment: try replacing '-' with '/' progressively to find real path
    path = root
    for seg in rest:
        # Try the segment as-is first
        candidate = os.path.join(path, seg)
        if os.path.exists(candidate):
            path = candidate
            continue
        # Try replacing '-' with os.sep one by one from left
        sub_parts = seg.split('-')
        resolved = sub_parts[0]
        for sp in sub_parts[1:]:
            # Try as path separator
            test_path = os.path.join(path, resolved, sp)
            if os.path.exists(os.path.join(path, resolved)):
                resolved = resolved  # keep current, start new segment
                path = os.path.join(path, resolved)
                resolved = sp
            else:
                # Keep as literal dash
                resolved = resolved + '-' + sp
        path = os.path.join(path, resolved)

    return path.replace('\\', '/')


@app.route('/api/projects')
def list_projects():
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM projects ORDER BY last_active DESC"
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d['path'] = r['real_path'] or _dir_name_to_path(r['dir_name'])
        result.append(d)
    return jsonify(result)


@app.route('/api/project/<int:project_id>')
def get_project(project_id: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not found', 'code': 'NOT_FOUND'}), 404
    d = dict(row)
    d['path'] = row['real_path'] or _dir_name_to_path(row['dir_name'])
    conn.close()
    return jsonify(d)


@app.route('/api/sessions/<int:project_id>')
def list_sessions(project_id: int):
    conn = get_db()
    rows = conn.execute(
        f"""SELECT * FROM sessions
            WHERE project_id = ? AND {session_has_content_sql()}
            ORDER BY last_active DESC""",
        (project_id,)
    ).fetchall()
    # Attach model list for each session
    result = []
    for r in rows:
        d = dict(r)
        models = conn.execute(
            "SELECT DISTINCT model FROM messages WHERE session_id = ? AND model IS NOT NULL AND model != '' AND model != '<synthetic>'",
            (d['id'],)
        ).fetchall()
        d['models'] = [m['model'] for m in models]
        result.append(d)
    conn.close()
    return jsonify(result)


def _fix_content_for_markdown(content: str) -> str:
    """Rewrite local file paths in markdown image destinations.

    CommonMark rejects destinations that contain a colon without a
    recognised scheme (http, https, …), so ``![alt](C:/foo.png)`` yields an
    empty ``src``.  We replace such paths with our file-proxy URL so that
    ReactMarkdown can render them.
    """
    if not content:
        return content

    def _replace(m):
        raw_path = m.group(2)
        # Only rewrite absolute local paths (Windows drive letter or Unix root)
        if not raw_path:
            return m.group(0)
        is_local = raw_path[0] == '/' or (
            len(raw_path) >= 2 and raw_path[0].isalpha() and raw_path[1] == ':'
        )
        if is_local:
            clean = quote(raw_path.replace('\\', '/'), safe='/:')
            return f'![{m.group(1)}](/api/file/image?path={clean})'
        return m.group(0)

    # Match ![alt](destination) where destination contains a drive letter
    # Pattern explanation:
    #   ![        → literal
    #   [^\]]*    → alt text (no closing bracket)
    #   ]          → closing bracket
    #   (          → opening paren
    #   [A-Za-z]:[^\s\)]+  → drive-letter path (no spaces/parens)
    #   )          → closing paren
    return re.sub(r'!\[([^\]]*)\]\(([A-Za-z]:[^\s\)]+)\)', _replace, content)


@app.route('/api/messages/<session_id>')
def list_messages(session_id: str):
    conn = get_db()
    types = request.args.getlist('type')

    if types:
        placeholders = ','.join('?' * len(types))
        rows = conn.execute(
            f"""SELECT * FROM messages
                WHERE session_id = ? AND type IN ({placeholders}) AND is_hidden = 0
                ORDER BY timestamp ASC, id ASC""",
            [session_id] + types
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM messages WHERE session_id = ? AND is_hidden = 0 ORDER BY timestamp ASC, id ASC",
            (session_id,)
        ).fetchall()

    conn.close()
    results = [dict(r) for r in rows]
    for r in results:
        if r.get('content'):
            r['content'] = _fix_content_for_markdown(format_command_message(r['content']))
    return jsonify(results)


@app.route('/api/search', methods=['POST'])
def search_messages():
    data = request.get_json()
    if not data or not data.get('query'):
        return jsonify({'error': 'query is required', 'code': 'MISSING_QUERY'}), 400

    try:
        results = search(
            query=data['query'],
            mode=data.get('mode', 'AND'),
            project_id=data.get('project_id'),
            time_from=data.get('time_from'),
            time_to=data.get('time_to'),
            types=data.get('types'),
            starred_only=data.get('starred_only', False),
            page=max(1, int(data.get('page', 1))),
            page_size=max(1, min(int(data.get('page_size', 20)), 100)),
        )
        return jsonify(results)
    except Exception:
        logger.exception("Search error")
        return jsonify({'error': 'Search failed', 'code': 'SEARCH_ERROR'}), 500


@app.route('/api/star/<int:message_id>', methods=['POST'])
def toggle_star(message_id: int):
    def _do(conn):
        row = conn.execute("SELECT starred, uuid FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Message not found', 'code': 'NOT_FOUND'}), 404
        new_val = 0 if row['starred'] else 1
        conn.execute("UPDATE messages SET starred = ? WHERE id = ?", (new_val, message_id))
        conn.commit()
        if row['uuid']:
            user_prefs.save_message_star(row['uuid'], bool(new_val))
        return jsonify({'starred': bool(new_val)})
    return _db_write(_do)


@app.route('/api/starred')
def list_starred():
    conn = get_db()
    rows = conn.execute("""
        SELECT m.*, s.project_id, p.display_name as project_name
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        JOIN projects p ON p.id = s.project_id
        WHERE m.starred = 1
        ORDER BY m.timestamp DESC
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/project/rename/<int:project_id>', methods=['PUT'])
def rename_project(project_id: int):
    data = request.get_json()
    name = data.get('display_name', '').strip() if data else ''
    if not name:
        return jsonify({'error': 'display_name is required', 'code': 'MISSING_NAME'}), 400
    def _do(conn):
        row = conn.execute("SELECT id, dir_name FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Project not found', 'code': 'NOT_FOUND'}), 404
        conn.execute("UPDATE projects SET display_name = ? WHERE id = ?", (name, project_id))
        conn.commit()
        user_prefs.save_project_rename(row['dir_name'], name)
        return jsonify({'id': project_id, 'display_name': name})
    return _db_write(_do)


@app.route('/api/session/star/<session_id>', methods=['POST'])
def toggle_session_star(session_id: str):
    def _do(conn):
        row = conn.execute("SELECT starred FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Session not found', 'code': 'NOT_FOUND'}), 404
        new_val = 0 if row['starred'] else 1
        conn.execute("UPDATE sessions SET starred = ? WHERE id = ?", (new_val, session_id))
        conn.commit()
        user_prefs.save_session_star(session_id, bool(new_val))
        return jsonify({'starred': bool(new_val)})
    return _db_write(_do)


@app.route('/api/session/rename/<session_id>', methods=['PUT'])
def rename_session(session_id: str):
    data = request.get_json()
    name = data.get('custom_name', '').strip() if data else ''
    def _do(conn):
        row = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Session not found', 'code': 'NOT_FOUND'}), 404
        conn.execute("UPDATE sessions SET custom_name = ? WHERE id = ?", (name or None, session_id))
        conn.commit()
        user_prefs.save_session_rename(session_id, name or None)
        return jsonify({'id': session_id, 'custom_name': name or None})
    return _db_write(_do)


@app.route('/api/sessions/starred')
def list_starred_sessions():
    conn = get_db()
    rows = conn.execute("""
        SELECT s.*, p.display_name as project_name
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE s.starred = 1
        ORDER BY s.last_active DESC
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/sessions/recent')
def list_recent_sessions():
    conn = get_db()
    rows = conn.execute(f"""
        SELECT s.*, p.display_name as project_name
        FROM sessions s
        JOIN projects p ON p.id = s.project_id
        WHERE {session_has_content_sql('s.id')}
        ORDER BY s.last_active DESC
        LIMIT 50
    """).fetchall()
    # Attach model list for each session
    result = []
    for r in rows:
        d = dict(r)
        models = conn.execute(
            "SELECT DISTINCT model FROM messages WHERE session_id = ? AND model IS NOT NULL AND model != '' AND model != '<synthetic>'",
            (d['id'],)
        ).fetchall()
        d['models'] = [m['model'] for m in models]
        result.append(d)
    conn.close()
    return jsonify(result)


@app.route('/api/sync/status')
def sync_status():
    # Sync runs in the background; the new counts show up on the next poll.
    pending = _sync_lock.locked() or (_check_pending_changes() and _start_background_sync())

    conn = get_db()
    stats = conn.execute("""
        SELECT
            (SELECT COUNT(*) FROM projects) as project_count,
            (SELECT COUNT(*) FROM sessions) as session_count,
            (SELECT COUNT(*) FROM messages WHERE is_hidden = 0) as message_count
    """).fetchone()
    conn.close()

    return jsonify({
        'last_sync': _last_sync_time,
        'pending_changes': pending,
        'stats': dict(stats),
        'semantic': embedding.status(),
    })


@app.route('/api/sync/trigger', methods=['POST'])
def trigger_sync():
    global _last_sync_time, _last_sync_stats
    with _sync_lock:
        _last_sync_stats = run_sync()
    _last_sync_time = datetime.now(timezone.utc).isoformat()
    embedding.notify()
    return jsonify(_last_sync_stats)


@app.route('/')
def serve_index():
    return send_from_directory(STATIC_DIR, 'index.html')


# Allowed image extensions for the file proxy. No SVG: it can carry script.
_ALLOWED_IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'}

# Pattern to detect absolute Windows / Unix paths that are NOT URLs
_LOCAL_PATH_RE = re.compile(r'^(/[a-zA-Z])|[a-zA-Z]:[/\\]')


def _canonical(path: str) -> str:
    """Symlink-free, case-normalised absolute path for containment checks."""
    return os.path.normcase(os.path.realpath(path))


def _is_too_broad(root: str) -> bool:
    """A session started in the home dir or a drive root must not expose
    every image underneath it."""
    if os.path.dirname(root) == root:  # drive or filesystem root
        return True
    try:  # the home dir itself or one of its ancestors (e.g. C:\Users)
        return os.path.commonpath([root, _canonical(os.path.expanduser('~'))]) == root
    except ValueError:  # different drive
        return False


@app.route('/api/file/image')
def serve_local_image():
    """Proxy to serve local image files referenced in conversation content.

    Accepts a `path` query parameter (an absolute local file path).
    Only serves image files (after resolving symlinks) under a known Claude
    project directory.
    """
    raw_path = request.args.get('path', '')
    if not raw_path or _LOCAL_PATH_RE.match(raw_path) is None:
        abort(400, description='Invalid path')

    # Resolve symlinks first: a link named 'logo.png' could point anywhere
    abs_path = _canonical(raw_path)
    if Path(abs_path).suffix.lower() not in _ALLOWED_IMAGE_EXTS:
        abort(400, description='Not an image file')

    # Security: ensure the resolved path is under a known project root.
    # Prefer real_path (the session's cwd): decoding dir_name is lossy since
    # Claude Code maps every non-alphanumeric char ('_', '.', ...) to '-'.
    conn = get_db()
    try:
        projects = conn.execute("SELECT dir_name, real_path FROM projects").fetchall()
    finally:
        conn.close()

    allowed = False
    for p in projects:
        project_root = _canonical(p['real_path'] or _dir_name_to_path(p['dir_name']))
        # commonpath raises ValueError on cross-drive paths on Windows
        try:
            if (os.path.commonpath([abs_path, project_root]) == project_root
                    and not _is_too_broad(project_root)):
                allowed = True
                break
        except ValueError:
            continue

    if not allowed:
        abort(403, description='Path not under any known project')

    if not os.path.isfile(abs_path):
        abort(404, description='File not found')

    return send_from_directory(os.path.dirname(abs_path), os.path.basename(abs_path))


@app.route('/<path:path>')
def serve_static(path: str):
    if os.path.exists(os.path.join(STATIC_DIR, path)):
        return send_from_directory(STATIC_DIR, path)
    return send_from_directory(STATIC_DIR, 'index.html')


@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Not found', 'code': 'NOT_FOUND'}), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({'error': 'Internal server error', 'code': 'SERVER_ERROR'}), 500
