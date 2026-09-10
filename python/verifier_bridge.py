#!/usr/bin/env python3
"""Strict stdin/stdout JSON bridge to llm-verifier."""

import contextlib
import json
import os
import sys
from typing import Any, Dict, List

# The Node host writes the request as UTF-8 bytes; on Windows Python would
# otherwise decode stdin with the locale codepage (for example cp936) and
# corrupt every non-ASCII trajectory byte.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


CRITERIA = {
    "Specification adherence": (
        "Does the candidate satisfy the requested task and all explicit constraints? "
        "Judge the actual patch and terminal evidence, not the candidate's claims."
    ),
    "Output match": (
        "Do the implemented files and observed validation outputs match the intended result? "
        "Trust terminal output over narrative assertions."
    ),
    "Error signal detection": (
        "Did the candidate correctly notice and handle errors, failed commands, and incomplete work? "
        "Penalize any success claim contradicted by terminal evidence."
    ),
}


def require_object(value: Any, field_name: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("{} must be an object, got {!r}".format(field_name, value))
    return value


def require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("{} must be a non-empty string, got {!r}".format(field_name, value))
    return value


def require_integer(value: Any, field_name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(
            "{} must be an integer from {} to {}, got {!r}".format(
                field_name, minimum, maximum, value
            )
        )
    return value


def read_request() -> Dict[str, Any]:
    raw_request = sys.stdin.read()
    if not raw_request:
        raise ValueError("stdin must contain one JSON request")
    try:
        parsed_request = json.loads(raw_request)
    except json.JSONDecodeError as error:
        raise ValueError("stdin contains invalid JSON: {}".format(error)) from error
    return require_object(parsed_request, "request")


def normalize_request(request: Dict[str, Any]) -> Dict[str, Any]:
    task = require_string(request.get("task"), "task")
    model = require_string(request.get("model"), "model")
    if not model.startswith("deepseek-"):
        raise ValueError("model must begin with 'deepseek-', got {!r}".format(model))
    cache_path = require_string(request.get("cachePath"), "cachePath")
    if not os.path.isabs(cache_path):
        raise ValueError("cachePath must be absolute, got {!r}".format(cache_path))

    raw_candidates = request.get("candidates")
    if not isinstance(raw_candidates, list) or not 2 <= len(raw_candidates) <= 5:
        raise ValueError("candidates must contain 2-5 items, got {!r}".format(raw_candidates))
    candidate_ids: List[str] = []
    trajectories: List[str] = []
    for candidate_index, raw_candidate in enumerate(raw_candidates):
        candidate = require_object(raw_candidate, "candidates[{}]".format(candidate_index))
        candidate_ids.append(
            require_string(candidate.get("candidateId"), "candidates[{}].candidateId".format(candidate_index))
        )
        trajectories.append(
            require_string(candidate.get("trajectory"), "candidates[{}].trajectory".format(candidate_index))
        )
    if len(set(candidate_ids)) != len(candidate_ids):
        raise ValueError("candidateId values must be unique, got {!r}".format(candidate_ids))

    pivots = require_integer(request.get("pivots"), "pivots", 1, 2)
    if pivots >= len(trajectories):
        raise ValueError(
            "pivots must be smaller than candidate count {}, got {}".format(len(trajectories), pivots)
        )
    return {
        "task": task,
        "model": model,
        "cache_path": cache_path,
        "trajectories": trajectories,
        "pivots": pivots,
        "n_evaluations": require_integer(request.get("nEvaluations"), "nEvaluations", 1, 4),
        "max_workers": require_integer(request.get("maxWorkers"), "maxWorkers", 1, 16),
    }


def clear_competing_backend_environment() -> None:
    for environment_name in list(os.environ):
        if (
            environment_name == "OPENAI_BASE_URL"
            or environment_name == "GOOGLE_GENAI_USE_VERTEXAI"
            or environment_name.startswith("GOOGLE_CLOUD_")
            or environment_name.startswith("VERTEX_")
        ):
            os.environ.pop(environment_name, None)


def run_selection(request: Dict[str, Any]) -> Dict[str, Any]:
    clear_competing_backend_environment()
    import llm_verifier  # Imported after backend environment normalization.

    llm_verifier.USAGE.reset()
    with contextlib.redirect_stdout(sys.stderr):
        verifier_result = llm_verifier.select(
            problem=request["task"],
            candidates=request["trajectories"],
            criteria=CRITERIA,
            n_evaluations=request["n_evaluations"],
            pivots=request["pivots"],
            seed=0,
            max_workers=request["max_workers"],
            model=request["model"],
            cache=request["cache_path"],
            progress=False,
            on_error="raise",
        )
    scores = [float(score) for score in verifier_result.scores]
    ranking = [int(candidate_index) for candidate_index in verifier_result.ranking]
    token_usage = llm_verifier.USAGE.snapshot()
    json.dumps(token_usage)
    request_count = token_usage.get("calls")
    if isinstance(request_count, bool) or not isinstance(request_count, int) or request_count < 0:
        raise RuntimeError("USAGE.snapshot() returned invalid calls: {!r}".format(request_count))
    return {
        "winnerIndex": int(verifier_result.index),
        "scores": scores,
        "ranking": ranking,
        "requestCount": request_count,
        "tokenUsage": token_usage,
    }


def main() -> int:
    request = normalize_request(read_request())
    result = run_selection(request)
    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Boundary: report a failed bridge process, never a fake winner.
        secret = os.environ.get("DEEPSEEK_API_KEY", "")
        message = str(error)
        if secret:
            message = message.replace(secret, "[REDACTED]")
        sys.stderr.write("verifier_bridge: {}\n".format(message))
        raise SystemExit(1)
