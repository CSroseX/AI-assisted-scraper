from fastapi import FastAPI, HTTPException
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import chromadb
import uuid
import time
import traceback

app = FastAPI()

# ChromaDB setup
client = chromadb.Client()
# Always clear and recreate the collection on startup
def clear_and_recreate_collection():
    try:
        client.delete_collection("chapter_versions")
    except Exception as e:
        print("Collection may not exist yet, skipping delete.")
    global collection
    collection = client.get_or_create_collection("chapter_versions")

clear_and_recreate_collection()

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
        # Print the collection state after adding
        print("After add, collection.get():", collection.get())
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
def list_versions():
    try:
        results = collection.get()
        print("ChromaDB collection.get() results (raw):", results)
        return results
    except Exception as e:
        print("Error in /version/history GET:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/version/{version_id}", response_model=VersionOut)
def get_version(version_id: str):
    try:
        print(f"Requested version_id: {version_id}")
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
    except Exception as e:
        print("Error in /version/restore/{version_id} POST:", e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/version/clear")
def clear_versions():
    client.delete_collection("chapter_versions")
    global collection
    collection = client.get_or_create_collection("chapter_versions")
    return {"status": "cleared"} 