"""
data/news_data.py – Financial news headline fetcher.

Two data sources depending on the phase:
  - Historical (backfill, 2012-2022): Kaggle HuffPost News Archive (JSON files).
  - Live (2022-present):              Alpaca News API.

Yahoo Finance RSS has been removed as it was rate-limited and unreliable.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from alpaca.data.historical.news import NewsClient
from alpaca.data.requests import NewsRequest

from config import ALPACA_API_KEY, ALPACA_SECRET_KEY

logger = logging.getLogger(__name__)

# ── Kaggle archive path ───────────────────────────────────────────────────────
# Place data_YYYY.json files here (one per year, 2012-2022)
KAGGLE_ARCHIVE_DIR = Path(__file__).parent / "kaggle_archive"

# ── Alpaca News client singleton ──────────────────────────────────────────────
_alpaca_news_client: NewsClient | None = None


def _get_alpaca_news_client() -> NewsClient:
    global _alpaca_news_client
    if _alpaca_news_client is None:
        _alpaca_news_client = NewsClient(
            api_key=ALPACA_API_KEY,
            secret_key=ALPACA_SECRET_KEY,
        )
    return _alpaca_news_client


# ── Kaggle News Loader ────────────────────────────────────────────────────────

class KaggleNewsLoader:
    """
    Loads and caches news headlines from the Kaggle HuffPost News archive.

    File naming convention: data_YYYY.json inside KAGGLE_ARCHIVE_DIR.
    Each JSON is a flat list of article dicts with at minimum:
        "headline": str
        "date":     "YYYY-MM-DD"
    """

    _cache: pd.DataFrame | None = None

    @classmethod
    def load(cls) -> pd.DataFrame:
        """
        Load all JSON files into a single DataFrame with columns [date, headline].
        Results are cached in memory after the first call.
        """
        if cls._cache is not None:
            return cls._cache

        if not KAGGLE_ARCHIVE_DIR.exists():
            logger.warning(
                "Kaggle archive directory not found: %s  "
                "→ place data_YYYY.json files there for historical backfill.",
                KAGGLE_ARCHIVE_DIR,
            )
            cls._cache = pd.DataFrame(columns=["date", "headline"])
            return cls._cache

        json_files = sorted(KAGGLE_ARCHIVE_DIR.glob("*.json"))
        if not json_files:
            logger.warning("No JSON files found in %s", KAGGLE_ARCHIVE_DIR)
            cls._cache = pd.DataFrame(columns=["date", "headline"])
            return cls._cache

        dfs: list[pd.DataFrame] = []
        for fpath in json_files:
            try:
                with open(fpath, "r", encoding="utf-8") as fp:
                    articles = json.load(fp)

                df = pd.DataFrame(articles)
                if "headline" not in df.columns or "date" not in df.columns:
                    logger.warning("Skipping %s – missing 'headline' or 'date' column", fpath.name)
                    continue

                df = df[["headline", "date"]].dropna()
                df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
                df = df.dropna(subset=["date"])
                dfs.append(df)
                logger.info("Kaggle archive: loaded %d articles from %s", len(df), fpath.name)

            except Exception as exc:
                logger.warning("Failed to load %s: %s", fpath.name, exc)

        if dfs:
            cls._cache = pd.concat(dfs, ignore_index=True)
            logger.info(
                "Kaggle archive: %d total articles across %d files",
                len(cls._cache),
                len(dfs),
            )
        else:
            cls._cache = pd.DataFrame(columns=["date", "headline"])

        return cls._cache

    @classmethod
    def get_headlines_for_date(cls, target_date: datetime | str) -> list[str]:
        """Return all headlines for a specific calendar date."""
        df = cls.load()
        if df.empty:
            return []

        if isinstance(target_date, str):
            target_date = pd.to_datetime(target_date).date()
        elif hasattr(target_date, "date"):
            target_date = target_date.date()

        mask = df["date"] == target_date
        return df.loc[mask, "headline"].tolist()

    @classmethod
    def clear_cache(cls) -> None:
        """Force reload on next call (useful in tests)."""
        cls._cache = None


# ── Alpaca News API ───────────────────────────────────────────────────────────

def fetch_headlines_alpaca(symbol: str, hours_back: int = 24) -> list[str]:
    """
    Fetch recent headlines for *symbol* from Alpaca News API.
    Returns a list of headline strings. Falls back to empty list on error.
    """
    try:
        client = _get_alpaca_news_client()
        end = datetime.now(tz=timezone.utc)
        start = end - timedelta(hours=hours_back)

        request = NewsRequest(
            symbols=symbol,
            start=start,
            end=end,
            limit=50,
        )
        news_set = client.get_news(request)
        headlines = [article.headline for article in news_set.news]
        logger.info("Alpaca News: %d headlines for %s", len(headlines), symbol)
        return headlines

    except Exception as exc:
        logger.warning(
            "Alpaca News unavailable for %s (%s). Returning empty list.", symbol, exc
        )
        return []


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_headlines(symbol: str, hours_back: int = 24) -> list[str]:
    """
    Main entry point for the live worker.
    Fetches recent headlines via Alpaca News API.
    For historical data ingestion use KaggleNewsLoader.get_headlines_for_date().
    """
    return fetch_headlines_alpaca(symbol, hours_back)
