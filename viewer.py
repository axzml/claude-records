#!/usr/bin/env python3
"""Claude Records — One-command launcher."""

import warnings
warnings.filterwarnings('ignore', message='.*pkg_resources is deprecated.*')

import argparse
import logging
import os
import socket
import sys
import webbrowser

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def find_free_port(start: int = 9966) -> int:
    """Find a free port starting from the given port."""
    for port in range(start, start + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('localhost', port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start}-{start+99}")


def main():
    parser = argparse.ArgumentParser(description='Claude Records')
    parser.add_argument('--port', type=int, default=9966, help='Server port (default: 9966)')
    parser.add_argument('--no-browser', action='store_true', help='Do not open browser automatically')
    args = parser.parse_args()

    static_dir = os.path.join(os.path.dirname(__file__), 'backend', 'static')
    index_html = os.path.join(static_dir, 'index.html')
    if not os.path.exists(index_html):
        print("Frontend not built yet. Run:")
        print("  cd frontend && npm install && npm run build")
        sys.exit(1)

    logger.info("Initializing database...")
    from backend.models import init_db
    init_db()

    logger.info("Syncing Claude Code conversations...")
    from backend.indexer import run_sync
    stats = run_sync()
    logger.info(
        f"Sync complete: {stats['files_scanned']} files scanned, "
        f"{stats['files_updated']} updated, {stats['messages_added']} new messages"
    )

    logger.info("Applying user preferences...")
    from backend.models import get_db
    from backend.user_prefs import apply_prefs_to_db
    conn = get_db()
    apply_prefs_to_db(conn)
    conn.close()

    port = find_free_port(args.port)
    url = f"http://localhost:{port}"
    logger.info(f"Starting server at {url}")

    if not args.no_browser:
        webbrowser.open(url)

    # Semantic search index is built in the background (needs Ollama + numpy)
    from backend import embedding
    if embedding.enabled():
        logger.info(f"Semantic search: model {embedding.EMBED_MODEL} via {embedding.OLLAMA_HOST}")
        embedding.start_background()
    else:
        logger.info("Semantic search disabled (install numpy and Ollama to enable)")

    from backend.app import app
    app.run(host='localhost', port=port, debug=False)


if __name__ == '__main__':
    main()
