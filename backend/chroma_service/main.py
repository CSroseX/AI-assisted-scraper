from fastapi import FastAPI, HTTPException
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import chromadb
import os
import uuid
import time
import traceback
from hmac import compare_digest

app = FastAPI()

# ChromaDB setup
CHROMA_PERSIST_PATH = os.getenv("CHROMA_PERSIST_PATH", "/data/chroma")
client = chromadb.PersistentClient(path=CHROMA_PERSIST_PATH)
collection = client.get_or_create_collection("chapter_versions")

class VersionIn(BaseModel):
    content: str
    parent_version: Optional[str] = None
    editor: str = "user"

class VersionOut(BaseModel):
    id: str
    parent_version: Optional[str]
    content: str
    timestamp: float
    editor: str

@app.post("/version", response_model=VersionOut)
def add_version(version: VersionIn):
    try:
        version_id = str(uuid.uuid4())
        timestamp = time.time()
        metadata = {
            "timestamp": timestamp,
            "editor": version.editor,
            "parent_version": version.parent_version if version.parent_version is not None else ""
        }
        collection.add(
            documents=[version.content],
            metadatas=[metadata],
            ids=[version_id]
        )
        return VersionOut(
            id=version_id,
            parent_version=metadata["parent_version"],
            content=version.content,
            timestamp=timestamp,
            editor=version.editor
        )
    except Exception as e:
        print("Error in /version POST:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/version/history")
def list_versions(limit: int = 50, offset: int = 0):
    try:
        safe_limit = max(1, min(limit, 200))
        safe_offset = max(0, offset)
        results = collection.get(limit=safe_limit, offset=safe_offset, include=["metadatas", "documents"])
        return results
    except Exception as e:
        print("Error in /version/history GET:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/version/{version_id}", response_model=VersionOut)
def get_version(version_id: str):
    try:
        result = collection.get(ids=[version_id])
        if not result["ids"]:
            raise HTTPException(status_code=404, detail="Version not found")
        return VersionOut(
            id=result["ids"][0],
            parent_version=result["metadatas"][0].get("parent_version"),
            content=result["documents"][0],
            timestamp=result["metadatas"][0]["timestamp"],
            editor=result["metadatas"][0]["editor"]
        )
    except HTTPException:
        raise
    except Exception as e:
        print("Error in /version/{version_id} GET:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/version/restore/{version_id}", response_model=VersionOut)
def restore_version(version_id: str):
    try:
        result = collection.get(ids=[version_id])
        if not result["ids"]:
            raise HTTPException(status_code=404, detail="Version not found")
        parent_version = result["ids"][0]
        content = result["documents"][0]
        editor = "user"
        return add_version(VersionIn(content=content, parent_version=parent_version, editor=editor))
    except HTTPException:
        raise
    except Exception as e:
        print("Error in /version/restore/{version_id} POST:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/version/clear")
def clear_versions(request: Request):
    clear_token = os.getenv("CLEAR_API_TOKEN", "")
    provided_token = request.headers.get("x-clear-token", "")
    if not clear_token or not compare_digest(provided_token, clear_token):
        raise HTTPException(status_code=403, detail="Forbidden")

    client.delete_collection("chapter_versions")
    global collection
    collection = client.get_or_create_collection("chapter_versions")
    return {"status": "cleared"} 
