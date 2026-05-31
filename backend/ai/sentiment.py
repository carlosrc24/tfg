"""
ai/sentiment.py – FinBERT sentiment pipeline.

Model: ProsusAI/finbert  (HuggingFace)
Output: Sentiment Score = P(positive) - P(negative)
  •  1.0 → very bullish
  • -1.0 → very bearish
  •  0.0 → neutral

The model is downloaded once and cached in ~/.cache/huggingface.
"""
from __future__ import annotations

import logging
from functools import lru_cache

import torch
from transformers import pipeline, Pipeline

from config import FINBERT_MODEL

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _get_pipeline() -> Pipeline:
    """Load FinBERT once and cache it for the process lifetime."""
    device = 0 if torch.cuda.is_available() else -1
    logger.info(
        "Loading FinBERT model '%s' on %s …",
        FINBERT_MODEL,
        "GPU" if device == 0 else "CPU",
    )
    nlp = pipeline(
        task="text-classification",
        model=FINBERT_MODEL,
        tokenizer=FINBERT_MODEL,
        device=device,
        top_k=None,       # return all labels with probabilities
        truncation=True,
        max_length=512,
    )
    logger.info("FinBERT loaded.")
    return nlp


def score_headline(headline: str) -> float:
    """
    Run FinBERT on a single headline.
    Returns Sentiment Score = P(positive) - P(negative).
    """
    nlp = _get_pipeline()
    results: list[dict] = nlp(headline)[0]  # list of {label, score}
    probs = {r["label"]: r["score"] for r in results}
    return probs.get("positive", 0.0) - probs.get("negative", 0.0)


def aggregate_sentiment(headlines: list[str]) -> float:
    """
    Score each headline and return the mean Sentiment Score.
    Returns 0.0 if *headlines* is empty.
    """
    if not headlines:
        logger.warning("No headlines provided – returning neutral sentiment.")
        return 0.0

    scores = [score_headline(h) for h in headlines]
    mean_score = sum(scores) / len(scores)
    logger.info(
        "Sentiment aggregate over %d headlines: %.4f", len(headlines), mean_score
    )
    return mean_score
