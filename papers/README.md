# RabbitHole Papers - Scientific Paper Analysis MVP

A minimal MVP for analyzing scientific papers and providing difficulty levels, summaries, and personalized learning paths.

## Features

- **Paper Analysis**: Submit paper title and text for structured analysis
- **Difficulty Assessment**: Get a 1-10 difficulty level with reasoning
- **Smart Summaries**: AI-generated 2-sentence summaries
- **Key Concepts**: Automatic extraction of 3 core concepts
- **Learning Path Recommendations**: 
  - Prerequisites to understand the paper
  - Easier related papers to learn first
  - Deeper topics to explore next
- **Mock Mode**: Works without OpenAI API key for testing/development

## Project Structure

```
papers/
??? backend/
?   ??? main.py           # FastAPI application
?   ??? llm_service.py    # LLM integration (OpenAI + mock)
?   ??? prompts.py        # LLM prompt templates
??? index.html            # Minimal static frontend
??? requirements.txt      # Python dependencies
??? .env.example          # Example environment variables
??? README.md            # This file
```

## Quick Start

### 1. Install Dependencies

```bash
cd papers
pip install -r requirements.txt
```

### 2. Setup Environment (Optional)

```bash
# Copy the example environment file
cp .env.example .env

# Add your OpenAI API key to .env (optional, not required for testing)
# OPENAI_API_KEY=sk-...
```

If you don't set `OPENAI_API_KEY`, the system will automatically use mock responses for testing.

### 3. Run the Backend

```bash
python backend/main.py
```

The API will start on `http://localhost:8000`

### 4. Open the Frontend

Open `index.html` in your browser:
- Simply double-click the file, or
- Use a local server: `python -m http.server 8000` (then visit `http://localhost:8000`)

## API Documentation

### POST /analyze

Analyze a scientific paper.

**Request:**
```json
{
  "title": "string",
  "text": "string"
}
```

**Response:**
```json
{
  "level": 1-10,
  "level_reason": "string",
  "summary": "string (2 sentences)",
  "concepts": ["string", "string", "string"],
  "prerequisite": "string",
  "easier": "string",
  "deeper": "string"
}
```

**Example cURL:**
```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Attention Is All You Need",
    "text": "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks..."
  }'
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

## Development

### Testing with Mock Data

The system automatically uses mock responses when:
1. `OPENAI_API_KEY` is not set
2. `OPENAI_API_KEY` is set to `"mock"`
3. OpenAI library is not installed

This is useful for frontend development without API costs.

### Using Real OpenAI API

1. Get an API key from [OpenAI](https://platform.openai.com/api-keys)
2. Set it in `.env`:
   ```
   OPENAI_API_KEY=sk-...
   ```
3. The system will use GPT-4 Turbo for analysis

## Notes

- The prompt is strictly configured to return valid JSON only
- Frontend is minimal and self-contained (no build process)
- CORS is enabled for frontend-backend communication
- This MVP does NOT touch the existing YouTube/extension code

## Troubleshooting

**CORS Error?**
- Make sure the backend is running on `http://localhost:8000`
- Check that CORS middleware is enabled in `main.py`

**JSON Parse Error?**
- Check the backend logs for the actual LLM response
- Try using mock mode first to debug the frontend

**Port Already in Use?**
- Edit `main.py` to use a different port (e.g., 8001)
- Update `API_URL` in `index.html` accordingly

## Future Enhancements

- Database for saving analyses
- User authentication
- PDF upload support
- Integration with arXiv API
- Full-text PDF analysis
- Comparison between papers
- Learning recommendations from academic databases
