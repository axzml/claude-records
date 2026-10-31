import html
import re
from datetime import date, timedelta
import jieba
from backend import embedding
from backend.models import get_db, format_command_message


def segment_query(query: str) -> str:
    """Segment a search query with jieba."""
    return ' '.join(jieba.cut(query))


def _get_highlight_terms(query: str) -> list[str]:
    """Extract search terms for highlighting from user query.

    Returns both original query words and jieba sub-tokens, sorted longest
    first so that regex alternation matches greedily (avoids partial
    highlights inside longer matches).
    """
    terms = set()
    for word in query.strip().split():
        if not word:
            continue
        terms.add(word)
        # Also add jieba sub-tokens for partial matches
        seg = ' '.join(jieba.cut(word))
        for token in seg.split():
            if token != word and len(token) > 1:
                terms.add(token)

    # Filter out single non-CJK chars (too common, create noise)
    filtered = [t for t in terms
                if len(t) > 1 or re.match(r'[\u4e00-\u9fff]', t)]

    # Longest first → regex alternation picks the longest match
    return sorted(filtered, key=len, reverse=True)


def make_snippet(content: str, query: str, max_len: int = 300) -> str:
    """Create a highlighted snippet from content centered on the first match.

    Uses the original search query terms (plus jieba sub-tokens) to find
    and mark matching text in the original (unsegmented) content.
    """
    if not content:
        return ''

    terms = _get_highlight_terms(query)
    if not terms:
        return html.escape(content[:max_len]) + ('...' if len(content) > max_len else '')

    pattern = re.compile('|'.join(re.escape(t) for t in terms))

    # Find the first match to position the window
    match = pattern.search(content)
    if not match:
        return html.escape(content[:max_len]) + ('...' if len(content) > max_len else '')

    # Sliding window around first match
    start = max(0, match.start() - 80)
    end = min(len(content), start + max_len)
    start = max(0, end - max_len)

    window = content[start:end]
    # Escape the text pieces individually so transcript content can never
    # inject markup; only our own <mark> tags remain as HTML
    pieces, pos = [], 0
    for m in pattern.finditer(window):
        pieces.append(html.escape(window[pos:m.start()]))
        pieces.append(f'<mark>{html.escape(m.group())}</mark>')
        pos = m.end()
    pieces.append(html.escape(window[pos:]))
    highlighted = ''.join(pieces)

    prefix = '...' if start > 0 else ''
    suffix = '...' if end < len(content) else ''

    return prefix + highlighted + suffix


def build_fts_query(query: str, mode: str = 'AND') -> str:
    """Build FTS5 query string from user input.

    Every token becomes a quoted FTS5 string. Tokens without any word
    character (quotes, '+', ':' ...) are dropped: the unicode61 tokenizer
    discards punctuation anyway, and a bare '"' would break the query syntax.
    """
    terms = query.strip().split()
    segmented_terms = []
    for term in terms:
        seg = segment_query(term)
        tokens = [t.replace('"', '""') for t in seg.split() if re.search(r'\w', t)]
        if len(tokens) > 1:
            segmented_terms.append(' '.join(f'"{t}"' for t in tokens))
        elif tokens:
            segmented_terms.append(f'"{tokens[0]}"')

    joiner = ' AND ' if mode.upper() == 'AND' else ' OR '
    return joiner.join(segmented_terms)


_ROW_SQL = """
    SELECT
        m.id, m.session_id, m.uuid, m.type, m.content_type, m.content,
        m.timestamp, m.starred, m.parent_uuid, m.model,
        s.project_id,
        p.display_name as project_name
    FROM {source}
    JOIN sessions s ON s.id = m.session_id
    JOIN projects p ON p.id = s.project_id
"""

# Hybrid search: semantic candidates taken before fusion. Keyword hits are
# all kept (up to a safety cap) so an exact-term search never loses matches.
HYBRID_POOL = 100
KEYWORD_POOL = 5000
# Cosine similarity below which a semantic-only hit is treated as noise
MIN_SEMANTIC_SCORE = 0.45  # unrelated queries peak around 0.4 with qwen3-embedding
# Reciprocal Rank Fusion constant (60 is the value from the original paper)
RRF_K = 60


def _filter_sql(types, time_from, time_to, starred_only):
    """WHERE clauses shared by keyword and semantic search (aliases m, s).

    The project filter is applied separately so per-project facet counts
    can be computed over the unfiltered result set.
    """
    # Exclude thinking blocks: they are indexed but never rendered in the
    # message view, so hits on them can't be scroll-located after click.
    where = [
        "m.is_hidden = 0",
        "(m.content_type IS NULL OR m.content_type != 'thinking')",
    ]
    params = []
    if types:
        where.append(f"m.type IN ({','.join('?' * len(types))})")
        params.extend(types)
    if time_from:
        where.append("m.timestamp >= ?")
        params.append(time_from)
    if time_to:
        if len(time_to) == 10:  # bare date (YYYY-MM-DD): include the whole day
            where.append("m.timestamp < ?")
            params.append((date.fromisoformat(time_to) + timedelta(days=1)).isoformat())
        else:
            where.append("m.timestamp <= ?")
            params.append(time_to)
    if starred_only:
        where.append("m.starred = 1")
    return where, params


def _build_result(conn, row, snippet: str, match: str) -> dict:
    return {
        'message_id': row['id'],
        'session_id': row['session_id'],
        'project_id': row['project_id'],
        'project_name': row['project_name'],
        'type': row['type'],
        'content_type': row['content_type'],
        'content': format_command_message(row['content']),
        'snippet': snippet,
        'timestamp': row['timestamp'],
        'starred': bool(row['starred']),
        'context': resolve_context(conn, row),
        'match': match,
    }


def search(query: str, mode: str = 'AND', project_id: int = None,
           time_from: str = None, time_to: str = None,
           types: list[str] = None, starred_only: bool = False,
           page: int = 1, page_size: int = 20) -> dict:
    """Search with filters.

    ``mode`` is 'AND' / 'OR' (keyword full-text search) or 'HYBRID'
    (keyword + semantic, fused by rank; falls back to keyword AND when the
    embedding model is unavailable).
    """
    where, params = _filter_sql(types, time_from, time_to, starred_only)
    conn = get_db()
    try:
        if mode.upper() == 'HYBRID':
            return _search_hybrid(conn, query, where, params, project_id, page, page_size)
        return _search_keyword(conn, query, mode, where, params, project_id, page, page_size)
    finally:
        conn.close()


_FTS_SOURCE = 'messages_fts JOIN messages m ON m.id = messages_fts.rowid'


def _facets(counts: dict[int, int], names: dict[int, str]) -> list[dict]:
    """Per-project hit counts, largest first, for the result filter tags."""
    return [{'project_id': pid, 'project_name': names[pid], 'count': n}
            for pid, n in sorted(counts.items(), key=lambda kv: -kv[1])]


def _search_keyword(conn, query, mode, where, params, project_id, page, page_size) -> dict:
    fts_query = build_fts_query(query, mode)
    if not fts_query:
        return {'total': 0, 'results': [], 'facets': []}

    where = ["messages_fts MATCH ?"] + where
    params = [fts_query] + params
    facet_rows = conn.execute(f"""
        SELECT s.project_id, p.display_name, COUNT(*) FROM {_FTS_SOURCE}
        JOIN sessions s ON s.id = m.session_id
        JOIN projects p ON p.id = s.project_id
        WHERE {' AND '.join(where)}
        GROUP BY s.project_id""", params).fetchall()
    facets = _facets({r[0]: r[2] for r in facet_rows}, {r[0]: r[1] for r in facet_rows})

    if project_id:
        where = where + ["s.project_id = ?"]
        params = params + [project_id]
        total = next((f['count'] for f in facets if f['project_id'] == project_id), 0)
    else:
        total = sum(f['count'] for f in facets)
    where_sql = ' AND '.join(where)

    rows = conn.execute(f"""
        {_ROW_SQL.format(source=_FTS_SOURCE)}
        WHERE {where_sql}
        ORDER BY rank
        LIMIT ? OFFSET ?""", params + [page_size, (page - 1) * page_size]).fetchall()

    results = [_build_result(conn, row, make_snippet(format_command_message(row['content']), query),
                             'keyword') for row in rows]
    return {'total': total, 'results': results, 'facets': facets}


def _keyword_ids(conn, query, where, params, limit) -> list[int]:
    fts_query = build_fts_query(query, 'AND')
    if not fts_query:
        return []
    return [r[0] for r in conn.execute(f"""
        SELECT m.id FROM {_FTS_SOURCE}
        JOIN sessions s ON s.id = m.session_id
        WHERE {' AND '.join(["messages_fts MATCH ?"] + where)}
        ORDER BY rank LIMIT ?""", [fts_query] + params + [limit]).fetchall()]


def _semantic_hits(conn, query, where, params, limit):
    """Semantic candidates passing the filters, best first.

    Returns {message_id: best_chunk_no} (dicts keep insertion order), or
    None when semantic search is unavailable.
    """
    ranked = embedding.search_semantic(conn, query, limit=1000)
    if ranked is None:
        return None
    ranked = [(mid, chunk) for mid, score, chunk in ranked if score >= MIN_SEMANTIC_SCORE]
    if not ranked:
        return {}
    ids = [mid for mid, _ in ranked]
    allowed = {r[0] for r in conn.execute(f"""
        SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.id IN ({','.join('?' * len(ids))}) AND {' AND '.join(where)}""",
        ids + params).fetchall()}
    hits = {}
    for mid, chunk in ranked:
        if mid in allowed:
            hits[mid] = chunk
            if len(hits) >= limit:
                break
    return hits


def rrf_fuse(rankings: list[list[int]], k: int = RRF_K) -> list[int]:
    """Reciprocal Rank Fusion: score(d) = sum over rankers of 1 / (k + rank).

    Only ranks matter, so BM25 scores and cosine similarities need no
    calibration against each other; documents found by both rankers
    naturally rise to the top.
    """
    scores = {}
    for ranking in rankings:
        for rank, doc in enumerate(ranking, start=1):
            scores[doc] = scores.get(doc, 0.0) + 1.0 / (k + rank)
    return sorted(scores, key=scores.get, reverse=True)


def _semantic_snippet(content: str, chunk_no: int, max_len: int = 300) -> str:
    """Snippet taken from the chunk that matched the query best."""
    start = embedding.chunk_start(chunk_no)
    window = content[start:start + max_len]
    return ('...' if start > 0 else '') + window + ('...' if start + max_len < len(content) else '')


def _search_hybrid(conn, query, where, params, project_id, page, page_size) -> dict:
    keyword = _keyword_ids(conn, query, where, params, KEYWORD_POOL)
    semantic = _semantic_hits(conn, query, where, params, HYBRID_POOL)
    if semantic is None:  # no embedding model: plain keyword search
        result = _search_keyword(conn, query, 'AND', where, params, project_id, page, page_size)
        result['semantic'] = False
        return result

    fused = rrf_fuse([keyword, list(semantic)])
    # Fuse across all projects first, then filter: the tag counts then match
    # exactly what each tag shows
    owner, names, counts = {}, {}, {}
    for i in range(0, len(fused), 900):  # stay under SQLite's variable limit
        batch = fused[i:i + 900]
        for mid, pid, name in conn.execute(f"""
                SELECT m.id, s.project_id, p.display_name FROM messages m
                JOIN sessions s ON s.id = m.session_id
                JOIN projects p ON p.id = s.project_id
                WHERE m.id IN ({','.join('?' * len(batch))})""", batch).fetchall():
            owner[mid] = pid
            names[pid] = name
            counts[pid] = counts.get(pid, 0) + 1
    facets = _facets(counts, names)
    if project_id:
        fused = [mid for mid in fused if owner.get(mid) == project_id]
    page_ids = fused[(page - 1) * page_size:page * page_size]
    rows = {}
    if page_ids:
        rows = {r['id']: r for r in conn.execute(
            f"{_ROW_SQL.format(source='messages m')} WHERE m.id IN ({','.join('?' * len(page_ids))})",
            page_ids).fetchall()}

    keyword_set = set(keyword)
    results = []
    for mid in page_ids:
        row = rows.get(mid)
        if not row:
            continue
        content = format_command_message(row['content'])
        if mid in keyword_set:
            snippet = make_snippet(content, query)
            match = 'both' if mid in semantic else 'keyword'
        else:
            snippet = html.escape(_semantic_snippet(content, semantic[mid]))
            match = 'semantic'
        results.append(_build_result(conn, row, snippet, match))
    return {'total': len(fused), 'results': results, 'facets': facets, 'semantic': True}


def resolve_context(conn, row) -> dict | None:
    """Resolve Q&A context for a search result."""
    if row['type'] == 'assistant':
        parent = row['parent_uuid']
        for _ in range(5):
            if not parent:
                break
            parent_row = conn.execute(
                "SELECT uuid, parent_uuid, type, content, content_type FROM messages WHERE uuid = ?",
                (parent,)
            ).fetchone()
            if not parent_row:
                break
            if parent_row['type'] == 'user':
                return {
                    'question': parent_row['content'][:200] if parent_row['content'] else None,
                    'answer_preview': None,
                }
            parent = parent_row['parent_uuid']

    elif row['type'] == 'user':
        child = conn.execute(
            """SELECT content FROM messages
               WHERE parent_uuid = ? AND type = 'assistant' AND content_type = 'text'
               ORDER BY timestamp ASC LIMIT 1""",
            (row['uuid'],)
        ).fetchone()
        if child:
            return {
                'question': None,
                'answer_preview': child['content'][:200] if child['content'] else None,
            }

    return None
