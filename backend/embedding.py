"""Optional semantic search backed by a local Ollama embedding model.

Everything here degrades gracefully: without numpy, without a running Ollama
server, or with CLAUDE_RECORDS_EMBED_MODEL set to '', ``search_semantic``
returns None and callers fall back to keyword-only search.

Vectors live in the ``message_vectors`` table (float16 blobs, one row per
chunk) and are mirrored into an in-memory float32 matrix for brute-force
cosine search; at this archive's scale (tens of thousands of chunks) a
matrix product takes milliseconds, so no vector database is needed.
"""
import json
import logging
import os
import threading
import urllib.error
import urllib.request

from backend.models import get_db, format_command_message

try:
    import numpy as np
except ImportError:  # semantic search is an optional extra
    np = None

logger = logging.getLogger(__name__)


def _ollama_host() -> str:
    host = os.environ.get('OLLAMA_HOST', '').strip() or '127.0.0.1:11434'
    if '://' not in host:
        host = 'http://' + host
    # 'localhost' resolves to ::1 first on Windows while Ollama listens on
    # IPv4 only, costing ~2s per request; 0.0.0.0 is a bind-all address.
    for name in ('//localhost', '//0.0.0.0'):
        host = host.replace(name, '//127.0.0.1')
    return host.rstrip('/')


OLLAMA_HOST = _ollama_host()
# CLAUDE_VIEWER_EMBED_MODEL: the variable's former name, still honoured
EMBED_MODEL = os.environ.get(
    'CLAUDE_RECORDS_EMBED_MODEL', os.environ.get('CLAUDE_VIEWER_EMBED_MODEL', 'qwen3-embedding:4b')).strip()
DIMENSIONS = 1024     # Matryoshka truncation: 4x smaller than native 2560, minor quality loss
CHUNK_CHARS = 1500
CHUNK_OVERLAP = 200
MAX_CHUNKS = 20       # the tail of giant pasted logs adds cost, not recall
BATCH_SIZE = 32
RETRY_SECONDS = 60    # how often to re-check an unavailable Ollama

# Qwen3-Embedding is instruction-aware: queries carry a task prefix,
# documents are embedded as-is.
QUERY_INSTRUCTION = ('Instruct: Given a search query, retrieve relevant messages '
                     'from past conversations between a user and an AI coding assistant\nQuery: ')

# Same rows the conversation view renders: visible prompts and answer texts.
ELIGIBLE_SQL = """is_hidden = 0 AND content_type = 'text'
    AND type IN ('user', 'assistant') AND trim(content) != ''"""


def enabled() -> bool:
    return bool(EMBED_MODEL) and np is not None


def chunk_text(text: str) -> list[str]:
    """Split text into overlapping windows; chunk i starts at i * step."""
    step = CHUNK_CHARS - CHUNK_OVERLAP
    chunks = [text[i:i + CHUNK_CHARS] for i in range(0, max(len(text) - CHUNK_OVERLAP, 1), step)]
    return chunks[:MAX_CHUNKS]


def chunk_start(chunk_no: int) -> int:
    return chunk_no * (CHUNK_CHARS - CHUNK_OVERLAP)


def _embed(texts: list[str], timeout: float = 300):
    """Call Ollama's /api/embed; returns an L2-normalised float32 matrix."""
    body = json.dumps({'model': EMBED_MODEL, 'input': texts,
                       'dimensions': DIMENSIONS, 'truncate': True}).encode()
    req = urllib.request.Request(f'{OLLAMA_HOST}/api/embed', body,
                                 {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        vecs = np.asarray(json.load(resp)['embeddings'], dtype=np.float32)
    # Older Ollama versions ignore 'dimensions': truncate client-side (MRL)
    vecs = vecs[:, :DIMENSIONS]
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    return vecs / np.maximum(norms, 1e-12)


def probe() -> bool:
    """Is Ollama up with the model pulled? Uses /api/tags, which does not
    load the model into VRAM (a test embedding would keep it resident)."""
    try:
        with urllib.request.urlopen(f'{OLLAMA_HOST}/api/tags', timeout=5) as resp:
            names = {m['name'] for m in json.load(resp).get('models', [])}
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        available = False
    else:
        available = EMBED_MODEL in names or f'{EMBED_MODEL}:latest' in names
    _status['available'] = available
    return available


# ---------------------------------------------------------------- storage

_schema_ready = False


def ensure_schema(conn):
    global _schema_ready
    if _schema_ready:
        return
    conn.execute("""CREATE TABLE IF NOT EXISTS message_vectors (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        chunk_no   INTEGER NOT NULL,
        vec        BLOB NOT NULL)""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_vectors_message ON message_vectors(message_id)")
    conn.execute("CREATE TABLE IF NOT EXISTS pragma_user_config(key TEXT PRIMARY KEY, value)")
    # Vectors from different models (or dimensions) are not comparable
    signature = f'{EMBED_MODEL}@{DIMENSIONS}'
    row = conn.execute("SELECT value FROM pragma_user_config WHERE key = 'embed_model'").fetchone()
    if not row or row[0] != signature:
        conn.execute("DELETE FROM message_vectors")
        conn.execute("INSERT OR REPLACE INTO pragma_user_config(key, value) VALUES ('embed_model', ?)",
                     (signature,))
        _cache.invalidate()
    conn.commit()
    _schema_ready = True


def _cleanup_orphans(conn) -> int:
    """Drop vectors of messages that were deleted or became hidden."""
    cur = conn.execute(f"""DELETE FROM message_vectors WHERE message_id NOT IN
        (SELECT id FROM messages WHERE {ELIGIBLE_SQL})""")
    if cur.rowcount:
        _cache.invalidate()
    return cur.rowcount


# Messages Ollama refused to embed (this process only): without skipping
# them, the newest-first queue would retry the same batch forever
_skipped: set[int] = set()


def _pending(conn, limit: int):
    skip_sql = f"AND id NOT IN ({','.join('?' * len(_skipped))})" if _skipped else ''
    return conn.execute(f"""SELECT id, content FROM messages
        WHERE {ELIGIBLE_SQL}
          AND NOT EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id = messages.id)
          {skip_sql}
        ORDER BY timestamp DESC LIMIT ?""", [*_skipped, limit]).fetchall()


def _embed_rows(rows) -> list[tuple[int, int, object]]:
    """Embed messages as (message_id, chunk_no, vector).

    If a batch fails while Ollama is still up, retry message by message and
    skip the ones that keep failing. Raises when Ollama itself is down.
    """
    items = [(r['id'], i, c) for r in rows
             for i, c in enumerate(chunk_text(format_command_message(r['content'])))]
    try:
        vecs = _embed([c for _, _, c in items])
        return [(mid, no, v) for (mid, no, _), v in zip(items, vecs)]
    except (urllib.error.URLError, OSError) as e:
        if not probe():
            raise
        if len(rows) == 1:
            logger.warning(f"Skipping message {rows[0]['id']} for semantic search: {e}")
            _skipped.add(rows[0]['id'])
            return []
    return [item for r in rows for item in _embed_rows([r])]


def index_pending(max_batches: int | None = None) -> int:
    """Embed eligible messages that have no vectors yet, newest first.

    Ollama is called outside of any open transaction so the sync thread is
    never blocked by a slow embedding batch. Raises URLError when Ollama is
    unreachable.
    """
    conn = get_db()
    try:
        ensure_schema(conn)
        _cleanup_orphans(conn)
        conn.commit()
        done = 0
        while max_batches is None or max_batches > 0:
            rows = _pending(conn, BATCH_SIZE)
            conn.commit()  # end the read transaction before the slow HTTP call
            if not rows:
                break
            embedded = _embed_rows(rows)
            conn.executemany(
                "INSERT INTO message_vectors(message_id, chunk_no, vec) VALUES (?, ?, ?)",
                [(mid, no, v.astype(np.float16).tobytes()) for mid, no, v in embedded])
            conn.commit()
            done += len(rows)
            _status['indexed'] += len(rows)
            if max_batches is not None:
                max_batches -= 1
        return done
    finally:
        conn.close()


# ---------------------------------------------------------- vector cache

class _VectorCache:
    """In-memory mirror of message_vectors, appended to incrementally."""

    def __init__(self):
        # Reentrant: search_semantic holds it while ensure_schema may invalidate
        self.lock = threading.RLock()
        self.invalidate()

    def invalidate(self):
        with self.lock:
            self.max_id = 0
            self.message_ids = np.zeros(0, dtype=np.int64) if np else None
            self.chunk_nos = np.zeros(0, dtype=np.int32) if np else None
            self.matrix = np.zeros((0, DIMENSIONS), dtype=np.float32) if np else None

    def refresh(self, conn):
        rows = conn.execute(
            "SELECT id, message_id, chunk_no, vec FROM message_vectors WHERE id > ? ORDER BY id",
            (self.max_id,)).fetchall()
        if not rows:
            return
        vecs = np.frombuffer(b''.join(r['vec'] for r in rows), dtype=np.float16)
        self.matrix = np.vstack([self.matrix, vecs.reshape(len(rows), DIMENSIONS).astype(np.float32)])
        self.message_ids = np.concatenate([self.message_ids, [r['message_id'] for r in rows]])
        self.chunk_nos = np.concatenate([self.chunk_nos, [r['chunk_no'] for r in rows]])
        self.max_id = rows[-1]['id']


_cache = _VectorCache()


def search_semantic(conn, query: str, limit: int = 200):
    """Rank messages by cosine similarity to the query.

    Returns ``[(message_id, score, best_chunk_no), ...]`` best first, or
    None when semantic search is unavailable (caller falls back).
    """
    if not enabled():
        return None
    try:
        qvec = _embed([QUERY_INSTRUCTION + query], timeout=30)[0]
    except (urllib.error.URLError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Semantic search unavailable: {e}")
        _status['available'] = False
        return None
    _status['available'] = True
    with _cache.lock:
        try:
            ensure_schema(conn)
            _cache.refresh(conn)
        except Exception as e:  # e.g. table locked mid-migration
            logger.warning(f"Vector cache refresh failed: {e}")
        if not len(_cache.message_ids):
            return None
        scores = _cache.matrix @ qvec
        # Over-fetch chunks, then keep each message's best chunk
        k = min(len(scores), limit * 4)
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        results, seen = [], set()
        for i in top:
            mid = int(_cache.message_ids[i])
            if mid in seen:
                continue
            seen.add(mid)
            results.append((mid, float(scores[i]), int(_cache.chunk_nos[i])))
            if len(results) >= limit:
                break
    return results


# ------------------------------------------------------ background worker

_status = {'available': False, 'indexed': 0, 'total': 0}
_wake = threading.Event()
_started = False


def notify():
    """Ask the background indexer to look for new messages."""
    _wake.set()


def _worker():
    warned = False
    while True:
        try:
            if probe():
                warned = False
                index_pending()
            elif not warned:
                warned = True
                logger.warning(f"Semantic indexing paused: {EMBED_MODEL} not available at {OLLAMA_HOST}")
        except (urllib.error.URLError, OSError) as e:
            logger.warning(f"Embedding request failed: {e}")
            _status['available'] = False
        except Exception as e:
            logger.error(f"Embedding indexer failed: {e}")
        _wake.wait(RETRY_SECONDS)
        _wake.clear()


def start_background():
    """Start the indexer thread (no-op when semantic search is disabled)."""
    global _started
    if _started or not enabled():
        return
    _started = True
    threading.Thread(target=_worker, daemon=True, name='embedding-indexer').start()


def status() -> dict:
    """Semantic search state for the status bar."""
    if not enabled():
        return {'enabled': False, 'available': False, 'model': EMBED_MODEL or None,
                'indexed': 0, 'total': 0}
    conn = get_db()
    try:
        ensure_schema(conn)
        total, indexed = conn.execute(f"""SELECT COUNT(*),
                SUM(EXISTS (SELECT 1 FROM message_vectors v WHERE v.message_id = messages.id))
            FROM messages WHERE {ELIGIBLE_SQL}""").fetchone()
    finally:
        conn.close()
    _status.update(total=total, indexed=indexed or 0)
    return {'enabled': True, 'available': _status['available'], 'model': EMBED_MODEL,
            'indexed': _status['indexed'], 'total': total}
