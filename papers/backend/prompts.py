def get_analysis_prompt(title: str, text: str) -> str:
    """
    Generate a prompt for analyzing scientific papers.
    Returns a prompt that instructs the LLM to output STRICT JSON.
    """
    return f"""Analyze the following scientific paper and provide a structured analysis in STRICT JSON format.

Paper Title: {title}

Paper Text:
{text}

Respond ONLY with valid JSON (no markdown, no extra text) in this exact format:
{{
    "level": <integer from 1-10 where 1 is beginner and 10 is expert>,
    "level_reason": "<brief explanation of why this level>",
    "summary": "<2 sentence summary of the paper's main contribution>",
    "concepts": ["<concept 1>", "<concept 2>", "<concept 3>"],
    "prerequisite": "<one important prerequisite knowledge needed to understand this paper>",
    "easier": "<title of a similar but easier paper or topic to learn first>",
    "deeper": "<title of a more advanced paper or topic to explore next>"
}}

Ensure the JSON is valid and parseable. Do not include any markdown formatting or additional text."""
