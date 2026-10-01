import os
import sys
import tempfile

# main.py opens a persistent Chroma client at import time, so point it at a
# throwaway directory before anything imports it.
os.environ.setdefault("CHROMA_PERSIST_PATH", tempfile.mkdtemp(prefix="chroma-test-"))
os.environ["CLEAR_API_TOKEN"] = "test-clear-token"
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
