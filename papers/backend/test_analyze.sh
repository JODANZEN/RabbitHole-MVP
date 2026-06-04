#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# RabbitHole — test_analyze.sh
#
# Quick smoke test for the /analyze endpoint.
#
# Usage:
#   1. Start the backend:
#        cd papers && uvicorn backend.main:app --reload
#
#   2. Run this script:
#        bash backend/test_analyze.sh
#
#   - If OPENAI_API_KEY is set in the backend's env, you'll get real
#     LLM results.  If not, you'll get the deterministic mock.
#
#   - To force mock mode even with a key set, start the backend with:
#        OPENAI_API_KEY=mock uvicorn backend.main:app --reload
# ─────────────────────────────────────────────────────────────────

BASE_URL="http://127.0.0.1:8000"

echo "=== RabbitHole /analyze smoke test ==="
echo ""

# ── Test 1: Health check ──────────────────────────────────────────
echo "--- 1. Health check ---"
curl -s "$BASE_URL/health" | python -m json.tool
echo ""

# ── Test 2: Short realistic text ─────────────────────────────────
echo "--- 2. Short text analysis ---"
curl -s -X POST "$BASE_URL/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Attention Is All You Need",
    "text": "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles, by over 2 BLEU. On the WMT 2014 English-to-French translation task, our model establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs, a small fraction of the training costs of the best models from the literature. The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms."
  }' | python -m json.tool
echo ""

# ── Test 3: Minimal text (should still work) ─────────────────────
echo "--- 3. Minimal text (edge case) ---"
curl -s -X POST "$BASE_URL/analyze" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Short Note",
    "text": "Machine learning is a subset of artificial intelligence that focuses on building systems that learn from data. It has applications in computer vision, natural language processing, and robotics."
  }' | python -m json.tool
echo ""

echo "=== Done ==="
echo ""
echo "Tip: check the backend terminal for [RabbitHole] debug logs."
echo "     They show whether the real LLM or mock path was used."
