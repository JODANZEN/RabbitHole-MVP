from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
import os
from prompts import get_analysis_prompt
from llm_service import analyze_paper

app = FastAPI(title="RabbitHole Papers API")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PaperInput(BaseModel):
    title: str
    text: str


class AnalysisResponse(BaseModel):
    level: int
    level_reason: str
    summary: str
    concepts: list[str]
    prerequisite: str
    easier: str
    deeper: str


@app.post("/analyze", response_model=AnalysisResponse)
async def analyze(paper: PaperInput):
    """Analyze a scientific paper and return difficulty level and related recommendations."""
    try:
        result = await analyze_paper(paper.title, paper.text)
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="Failed to parse LLM response")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
