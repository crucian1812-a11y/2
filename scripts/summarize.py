#!/usr/bin/env python3
"""Fetch transcripts and build summaries for videos in data/watch_log.json.

Provider is selected with the SUMMARY_PROVIDER env var:
  * local (default) — offline extractive summary: sumy TextRank + yake keywords.
  * openai — any OpenAI-compatible endpoint (Groq, Gemini, Ollama, ...),
    configured via LLM_BASE_URL / LLM_MODEL / LLM_API_KEY.

Both providers return the same schema:
  {one_liner, theses[], key_points[], topics[], tags[]}

Results accumulate in data/notes.json (dict keyed by video_id) and
notes/<video_id>.md. Videos without transcripts are marked
status="no_transcript" and never retried. Idempotent; at most
MAX_PER_RUN (default 25) new videos are processed per run.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WATCH_LOG = ROOT / "data" / "watch_log.json"
NOTES_JSON = ROOT / "data" / "notes.json"
NOTES_DIR = ROOT / "notes"

PROVIDER = os.environ.get("SUMMARY_PROVIDER", "local").strip().lower()
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN", "25"))
MAX_TRANSCRIPT_CHARS = 24_000  # keep prompts / TextRank input bounded
API_PAUSE_SECONDS = 2.5  # free tiers are ~30 RPM

CYRILLIC_RE = re.compile(r"[а-яА-ЯёЁ]")


# --------------------------------------------------------------------------
# Transcript fetching
# --------------------------------------------------------------------------

def fetch_transcript(video_id: str) -> list[str] | None:
    """Return transcript segments (list of text chunks) or None."""
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    try:
        try:
            fetched = api.fetch(video_id, languages=["ru", "en"])
        except Exception:
            # Fall back to whatever language is available.
            transcript_list = api.list(video_id)
            transcript = next(iter(transcript_list))
            fetched = transcript.fetch()
        return [snippet.text for snippet in fetched if snippet.text.strip()]
    except Exception as exc:
        print(f"    no transcript ({type(exc).__name__})")
        return None


def segments_to_text(segments: list[str]) -> str:
    """Join auto-caption segments into pseudo-sentences.

    Auto captions carry no punctuation, so segments are joined with ". "
    to give the sentence tokenizer something to split on.
    """
    cleaned = []
    for seg in segments:
        seg = re.sub(r"\s+", " ", seg).strip()
        seg = re.sub(r"\[[^\]]*\]", "", seg).strip()  # [Music] etc.
        if seg:
            cleaned.append(seg)
    text = ". ".join(cleaned)
    return text[:MAX_TRANSCRIPT_CHARS]


# --------------------------------------------------------------------------
# Local provider: sumy TextRank + yake
# --------------------------------------------------------------------------

def ensure_nltk() -> None:
    import nltk

    for resource in ("punkt", "punkt_tab"):
        try:
            nltk.data.find(f"tokenizers/{resource}")
        except LookupError:
            try:
                nltk.download(resource, quiet=True)
            except Exception as exc:
                print(f"    ! nltk download {resource} failed: {exc}",
                      file=sys.stderr)


def summarize_local(text: str, title: str) -> dict:
    from sumy.nlp.tokenizers import Tokenizer
    from sumy.parsers.plaintext import PlaintextParser
    from sumy.summarizers.text_rank import TextRankSummarizer

    import yake

    ensure_nltk()

    lang = "russian" if CYRILLIC_RE.search(text) else "english"
    yake_lang = "ru" if lang == "russian" else "en"

    parser = PlaintextParser.from_string(text, Tokenizer(lang))
    summarizer = TextRankSummarizer()

    sentence_count = 7 if len(text) > 4000 else 5
    try:
        summary_sentences = [
            str(s) for s in summarizer(parser.document, sentence_count)
        ]
    except Exception as exc:
        print(f"    ! textrank failed: {exc}", file=sys.stderr)
        summary_sentences = []

    if not summary_sentences:
        # Degenerate transcript — fall back to leading text.
        summary_sentences = [text[:300]] if text else []

    one_liner = summary_sentences[0] if summary_sentences else title

    key_points = [s for s in summary_sentences if re.search(r"\d", s)][:5]

    topics: list[str] = []
    tags: list[str] = []
    try:
        extractor = yake.KeywordExtractor(lan=yake_lang, n=2, top=20)
        keywords = [kw for kw, _score in extractor.extract_keywords(text)]
        topics = keywords[:5]
        tags = [kw.lower() for kw in keywords[:10]]
    except Exception as exc:
        print(f"    ! yake failed: {exc}", file=sys.stderr)

    return {
        "one_liner": one_liner,
        "theses": summary_sentences,
        "key_points": key_points,
        "topics": topics,
        "tags": tags,
    }


# --------------------------------------------------------------------------
# OpenAI-compatible provider
# --------------------------------------------------------------------------

PROMPT_TEMPLATE = """\
Ты делаешь конспект видео по его субтитрам. Название видео: {title}

Верни СТРОГО валидный JSON без пояснений и без markdown-ограждений, схема:
{{
  "one_liner": "суть видео одним предложением",
  "theses": ["5-7 главных тезисов"],
  "key_points": ["конкретные факты, цифры, названия (до 5)"],
  "topics": ["2-4 широкие темы"],
  "tags": ["5-10 коротких тегов в нижнем регистре"]
}}

Отвечай на языке субтитров. Субтитры:
{transcript}
"""


def strip_json_fences(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    # As a last resort, take the outermost {...} block.
    if not raw.startswith("{"):
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            raw = m.group(0)
    return raw


def summarize_openai(text: str, title: str) -> dict:
    from openai import OpenAI

    client = OpenAI(
        base_url=os.environ.get("LLM_BASE_URL") or None,
        api_key=os.environ.get("LLM_API_KEY", "not-needed"),
    )
    model = os.environ.get("LLM_MODEL", "llama-3.1-8b-instant")

    response = client.chat.completions.create(
        model=model,
        messages=[{
            "role": "user",
            "content": PROMPT_TEMPLATE.format(title=title, transcript=text),
        }],
        temperature=0.3,
    )
    raw = response.choices[0].message.content or ""
    data = json.loads(strip_json_fences(raw))

    def as_list(value) -> list[str]:
        if isinstance(value, list):
            return [str(v) for v in value]
        return [str(value)] if value else []

    return {
        "one_liner": str(data.get("one_liner", "")),
        "theses": as_list(data.get("theses")),
        "key_points": as_list(data.get("key_points")),
        "topics": as_list(data.get("topics")),
        "tags": [t.lower() for t in as_list(data.get("tags"))],
    }


# --------------------------------------------------------------------------
# Markdown note
# --------------------------------------------------------------------------

def write_note(record: dict, summary: dict) -> None:
    lines = [
        f"# {record['title']}",
        "",
        f"- **Канал:** {record.get('channel') or '—'}",
        f"- **Ссылка:** {record['url']}",
        f"- **Просмотрено:** {record.get('watched_at', '')}",
        "",
        f"> {summary['one_liner']}",
        "",
        "## Тезисы",
        "",
    ]
    lines += [f"- {t}" for t in summary["theses"]]
    if summary["key_points"]:
        lines += ["", "## Ключевые факты", ""]
        lines += [f"- {k}" for k in summary["key_points"]]
    if summary["topics"]:
        lines += ["", f"**Темы:** {', '.join(summary['topics'])}"]
    if summary["tags"]:
        lines += ["", f"**Теги:** {', '.join(summary['tags'])}"]
    lines.append("")

    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    (NOTES_DIR / f"{record['video_id']}.md").write_text(
        "\n".join(lines), encoding="utf-8"
    )


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

def main() -> None:
    if not WATCH_LOG.exists():
        print("watch_log.json not found — run parse_history.py first")
        return

    watch_log = json.loads(WATCH_LOG.read_text(encoding="utf-8"))
    notes: dict = {}
    if NOTES_JSON.exists():
        try:
            notes = json.loads(NOTES_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("  ! notes.json is corrupt, starting fresh", file=sys.stderr)

    # Newest first; one attempt per video_id.
    pending = []
    seen_ids = set()
    for record in watch_log:
        vid = record["video_id"]
        if vid in notes or vid in seen_ids:
            continue
        seen_ids.add(vid)
        pending.append(record)

    print(f"provider={PROVIDER}, pending={len(pending)}, "
          f"limit={MAX_PER_RUN}")

    processed = 0
    for record in pending:
        if processed >= MAX_PER_RUN:
            break
        vid = record["video_id"]
        print(f"  [{processed + 1}/{MAX_PER_RUN}] {vid} — "
              f"{record['title'][:60]}")

        segments = fetch_transcript(vid)
        if not segments:
            notes[vid] = {**record, "status": "no_transcript"}
            processed += 1
            save_notes(notes)
            continue

        text = segments_to_text(segments)
        try:
            if PROVIDER == "openai":
                summary = summarize_openai(text, record["title"])
                time.sleep(API_PAUSE_SECONDS)
            else:
                summary = summarize_local(text, record["title"])
        except Exception as exc:
            print(f"    ! summarize failed: {exc}", file=sys.stderr)
            continue  # transient — retry on the next run

        notes[vid] = {**record, **summary, "status": "ok"}
        write_note(record, summary)
        processed += 1
        save_notes(notes)

    ok = sum(1 for n in notes.values() if n.get("status") == "ok")
    missing = sum(1 for n in notes.values()
                  if n.get("status") == "no_transcript")
    print(f"done: {processed} processed this run; "
          f"{ok} notes, {missing} without transcript")


def save_notes(notes: dict) -> None:
    NOTES_JSON.parent.mkdir(parents=True, exist_ok=True)
    NOTES_JSON.write_text(
        json.dumps(notes, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
