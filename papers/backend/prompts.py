"""
RabbitHole — LLM prompt templates.

Exports:
    get_analysis_prompt(title, text_summary)  – analyse a single chunk
    get_synthesis_prompt(title, chunk_results) – merge multiple chunk results
    get_explain_prompt(text, context)          – Dumbify: plain-language explanation
"""

import json
from typing import Any, Dict, List


def get_analysis_prompt(title: str, text_summary: str) -> str:
    """Return the prompt that instructs the LLM to analyse one text chunk
    and respond with strict JSON matching RESPONSE_SCHEMA."""
    return f"""You are RabbitHole, an expert academic-content analyst.

You MUST output ONLY valid JSON exactly matching the schema below.
Do NOT output any explanation, commentary, markdown fences, or text
outside the JSON object.

──────────────────────────────────────────────
TITLE: {title}

TEXT (pre-cleaned article content — UI/menu text has been stripped):
{text_summary}
──────────────────────────────────────────────

REQUIRED OUTPUT (strict JSON, nothing else):

{{
  "level": <integer 1-10>,
  "level_reason": "<one sentence explaining the rating>",
  "summary": "<2-4 sentence summary of the text's main points>",
  "concepts": ["<phrase 1>", "<phrase 2>", ... 5-7 phrases],
  "prerequisite": "<one sentence: what should the reader know first>",
  "easier": "<one sentence: a concrete recommendation for an easier starting point>",
  "deeper": "<one sentence: a concrete pointer for going deeper into the topic>",
  "confidence": <float 0.0-1.0>
}}

RULES — follow every one strictly:

1. **level** — base this on CONTENT INDICATORS, not word count:
   - 1-2: everyday language, no jargon, general-audience blog
   - 3-4: introductory textbook; some field-specific terms defined inline
   - 5-6: intermediate; assumes prior coursework, moderate jargon density,
     may reference methods or frameworks by name
   - 7-8: advanced; mathematical notation (equations, greek letters, integrals),
     dense terminology, proofs or derivations, formal methods
   - 9-10: frontier research; novel formalisms, heavy equations, assumes
     expert audience, cites recent unpublished or niche results
   Indicators to weigh: presence of math/formula tokens (=, ∑, ∫, ∂),
   citation density ([1], et al.), average sentence length, ratio of
   words >10 characters, domain-specific method names, use of formal
   definitions. Word count alone is NOT a valid driver of level.

2. **concepts** — extract 5-7 NOUN PHRASES (2-4 words each) that represent
   the core technical or topical ideas in the text. STRICT RULES:
   - VERBATIM PRESENCE CHECK: each concept MUST appear as a substring
     (case-insensitive) in the provided TEXT above. If a phrase does not
     appear in the text, do NOT include it. Search the text for each
     concept before adding it to your list.
   - Prefer multi-word technical phrases (e.g. "self-attention mechanism",
     "stochastic gradient descent") over single generic words.
   - NEVER include: UI labels, button text, menu items, author names,
     journal names, page-chrome strings, navigation labels, or extension
     interface text (e.g. "Enter Rabbithole", "Analyze", "Session Active").
   - NEVER include generic filler like "Core Concept", "Key Topic", or
     numbered placeholders.
   - Deduplicate: if two phrases are near-synonyms, keep only the longer one.

3. **prerequisite** — name ONE concrete knowledge area the reader needs.
   Be specific (e.g. "linear algebra and matrix decomposition"), not vague.

4. **easier** — recommend ONE specific, real search query or resource
   (e.g. "Wikipedia article on Bayesian inference"). Do NOT invent paper
   titles or DOIs.

5. **deeper** — recommend ONE direction for further exploration, referencing
   a real subfield or named topic. Do NOT invent citations.

6. **confidence** — your self-assessed confidence (0.0-1.0). Lower if the
   text is very short, ambiguous, or outside your training data.

7. **summary** — 2-4 sentences about what the text actually says, not
   what you think it should say. Do not include meta-commentary.

EXAMPLE (for a text about neural networks — your output must match YOUR text):

{{"level":6,"level_reason":"Uses technical ML terminology and references specific architectures without heavy math.","summary":"The text describes transformer architectures and their application to sequence modeling. It compares attention-based approaches with recurrent networks and presents benchmark results.","concepts":["transformer architecture","multi-head attention","sequence modeling","recurrent neural networks","benchmark results"],"prerequisite":"Familiarity with deep learning fundamentals and neural network architectures.","easier":"Search for 'Introduction to neural networks for beginners' on Khan Academy.","deeper":"Explore the field of efficient transformers and sparse attention mechanisms.","confidence":0.85}}

IMPORTANT: Use temperature=0 for this call. Output ONLY the JSON object.
No preamble, no trailing text, no markdown fences."""


def get_synthesis_prompt(title: str, chunk_results: List[Dict[str, Any]]) -> str:
    """Return a prompt that merges multiple per-chunk analyses into one
    final JSON matching RESPONSE_SCHEMA."""
    chunks_json = json.dumps(chunk_results, indent=2)

    return f"""You are RabbitHole, an expert research-paper analyst.

You previously analysed a long document titled "{title}" in separate chunks.
Below are the per-chunk analysis results as a JSON array.

──────────────────────────────────────────────
CHUNK RESULTS:
{chunks_json}
──────────────────────────────────────────────

Your task: merge these chunk results into ONE final JSON object.

Return this exact JSON schema (no markdown fences, no extra text):

{{
  "level": <integer 1-10>,
  "level_reason": "<one sentence>",
  "summary": "<2-4 sentence overall summary covering the full document>",
  "concepts": ["<phrase>", ...],
  "prerequisite": "<one sentence>",
  "easier": "<one sentence>",
  "deeper": "<one sentence>",
  "confidence": <float 0.0-1.0>
}}

MERGE RULES:
- **level**: use the MEDIAN of the chunk levels (round to nearest int).
- **level_reason**: write a new sentence that justifies the overall level.
- **summary**: write a NEW 2-4 sentence summary that covers the entire
  document, not just one chunk. Synthesise, do not concatenate.
- **concepts**: collect all concepts from all chunks, deduplicate, keep
  the 5 most important. Prefer phrases that appear in multiple chunks.
- **prerequisite**: pick the single most foundational prerequisite across
  all chunks.
- **easier**: pick the most useful easier recommendation.
- **deeper**: pick the most useful deeper recommendation.
- **confidence**: average the chunk confidences, then subtract 0.05 for
  synthesis uncertainty. Clamp to [0.0, 1.0].

Output ONLY the JSON object."""


def get_explain_prompt(text: str, context: str = "") -> str:
    """Prompt for the Dumbify feature — plain-language explanation of selected text."""
    context_section = (
        f"\nSURROUNDING CONTEXT (the article or paper the text is from):\n{context[:1000]}\n"
        if context
        else ""
    )
    return f"""You are RabbitHole's Dumbify engine — you make complex academic and scientific text understandable to anyone curious but non-expert.

A reader selected this text from an article or paper:

SELECTED TEXT:
{text[:2000]}
{context_section}
──────────────────────────────────────────────

Output ONLY valid JSON matching this exact schema (no markdown, no extra text):

{{
  "explanation": "<2-3 sentences that explain what this means in plain everyday language a curious teenager could understand>",
  "analogy": "<one vivid, concrete real-world analogy that makes this intuitive — use cooking, sports, everyday objects, etc.>",
  "terms": [{{"term": "<technical term from the selection>", "means": "<one-sentence simple definition>"}}, ...],
  "why_matters": "<one sentence on why this concept or result is significant or interesting>"
}}

RULES:
1. explanation — No jargon. If you must use a technical word, define it inline. Keep sentences short.
2. analogy — Be creative and specific. "Think of it like..." framing works well.
3. terms — Extract 2-4 key technical terms or symbols that appear in the selected text. If the text has no technical terms, return an empty list [].
4. why_matters — Be motivating and concrete. What would change if we didn't know this?

Output ONLY the JSON object. No preamble, no trailing text."""
