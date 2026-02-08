import os
import json
from typing import Dict, Any
from prompts import get_analysis_prompt


async def analyze_paper(title: str, text: str) -> Dict[str, Any]:
    """
    Analyze a paper using OpenAI API or mock if key is not set.
    Returns a structured analysis as a dictionary.
    """
    openai_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not openai_key or openai_key.lower() == "mock":
        return get_mock_analysis(title, text)

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=openai_key)
        prompt = get_analysis_prompt(title, text)

        response = await client.chat.completions.create(
            model="gpt-4-turbo-preview",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )

        response_text = response.choices[0].message.content.strip()
        result = json.loads(response_text)

        return result
    except ImportError:
        print("OpenAI library not installed, using mock response")
        return get_mock_analysis(title, text)
    except json.JSONDecodeError as e:
        print(f"Failed to parse LLM response: {e}")
        raise


def get_mock_analysis(title: str, text: str) -> Dict[str, Any]:
    """
    Return a mock analysis response for testing/development.
    """
    # Simple heuristic: count words to estimate difficulty
    word_count = len(text.split())
    level = min(10, max(1, word_count // 300 + 1))

    return {
        "level": level,
        "level_reason": f"Estimated based on text length ({word_count} words) and complexity indicators",
        "summary": f"This paper explores {title.lower()}. The research presents novel findings in this domain.",
        "concepts": ["Core Concept 1", "Core Concept 2", "Core Concept 3"],
        "prerequisite": "Understanding of fundamental concepts in the field",
        "easier": "Introduction to Basic Theory",
        "deeper": "Advanced Topics and Future Directions",
    }
