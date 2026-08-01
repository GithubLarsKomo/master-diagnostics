#!/usr/bin/env python3
"""Generate the modified Dmax reference dataset using only Python stdlib."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages/diagnostics/reference/modified-dmax-reference-v1.json"
EPSILON = 1e-12
RISE_THRESHOLD = 0.4


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    size = len(vector)
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        pivot_value = augmented[column][column]
        if abs(pivot_value) <= EPSILON:
            raise ValueError("singular matrix")
        augmented[column] = [value / pivot_value for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                value - factor * pivot_component
                for value, pivot_component in zip(augmented[row], augmented[column])
            ]
    return [row[-1] for row in augmented]


def cubic_regression(points: list[dict[str, Any]]) -> dict[str, Any]:
    center = sum(point["watts"] for point in points) / len(points)
    scale = max(abs(point["watts"] - center) for point in points)
    rows = []
    for point in points:
        x = (point["watts"] - center) / scale
        rows.append([1.0, x, x * x, x * x * x])
    matrix = [[sum(row[i] * row[j] for row in rows) for j in range(4)] for i in range(4)]
    vector = [sum(row[i] * point["lactate"] for row, point in zip(rows, points)) for i in range(4)]
    coefficients = solve(matrix, vector)

    def predict(watts: float) -> float:
        x = (watts - center) / scale
        return sum(coefficient * x**power for power, coefficient in enumerate(coefficients))

    residual_sum = sum((point["lactate"] - predict(point["watts"])) ** 2 for point in points)
    mean = sum(point["lactate"] for point in points) / len(points)
    total_sum = sum((point["lactate"] - mean) ** 2 for point in points)
    return {
        "coefficients": coefficients,
        "wattCenter": center,
        "wattScale": scale,
        "rSquared": 1.0 - residual_sum / total_sum,
        "rmse": math.sqrt(residual_sum / len(points)),
    }


def predict(regression: dict[str, Any], watts: float) -> float:
    x = (watts - regression["wattCenter"]) / regression["wattScale"]
    return sum(
        coefficient * x**power
        for power, coefficient in enumerate(regression["coefficients"])
    )


def modified_dmax(points: list[dict[str, Any]], regression: dict[str, Any]) -> dict[str, Any]:
    start = None
    for left, right in zip(points, points[1:]):
        if right["lactate"] - left["lactate"] > RISE_THRESHOLD + EPSILON:
            start = left
            break
    if start is None:
        raise ValueError("no consecutive lactate rise greater than 0.4 mmol/l")
    end = points[-1]
    delta_watts = end["watts"] - start["watts"]
    delta_lactate = end["lactate"] - start["lactate"]
    scale = regression["wattScale"]
    _, a1, a2, a3 = regression["coefficients"]
    quadratic = 3.0 * a3
    linear = 2.0 * a2
    constant = a1 - delta_lactate * scale / delta_watts
    roots: list[float] = []
    if abs(quadratic) <= EPSILON:
        if abs(linear) > EPSILON:
            roots.append(-constant / linear)
    else:
        discriminant = linear * linear - 4.0 * quadratic * constant
        if discriminant >= -EPSILON:
            root = math.sqrt(max(0.0, discriminant))
            roots.extend((
                (-linear - root) / (2.0 * quadratic),
                (-linear + root) / (2.0 * quadratic),
            ))

    candidates = [start["watts"], end["watts"]]
    for normalized in roots:
        watts = regression["wattCenter"] + normalized * scale
        if start["watts"] < watts < end["watts"]:
            candidates.append(watts)

    denominator = math.hypot(delta_watts, delta_lactate)

    def evaluate(watts: float) -> tuple[float, float, float]:
        lactate = predict(regression, watts)
        numerator = abs(
            delta_lactate * watts
            - delta_watts * lactate
            + end["watts"] * start["lactate"]
            - end["lactate"] * start["watts"]
        )
        return watts, lactate, numerator / denominator

    best = sorted((evaluate(watts) for watts in candidates), key=lambda value: (-value[2], value[0]))[0]
    return {
        "startPoint": start,
        "watts": best[0],
        "lactate": best[1],
        "maximumDistance": best[2],
        "searchIntervalWatts": [start["watts"], end["watts"]],
    }


def main() -> None:
    points = [
        {"watts": 120.0, "lactate": 1.0, "included": True},
        {"watts": 150.0, "lactate": 1.1, "included": True},
        {"watts": 180.0, "lactate": 1.3, "included": True},
        {"watts": 210.0, "lactate": 1.7, "included": True},
        {"watts": 240.0, "lactate": 2.5, "included": True},
        {"watts": 270.0, "lactate": 4.0, "included": True},
        {"watts": 300.0, "lactate": 6.2, "included": True},
    ]
    regression = cubic_regression(points)
    payload = {
        "name": "modified-dmax-realistic-stage-curve",
        "version": "1.0.0",
        "source": "independent-python-standard-library",
        "tolerance": 1e-9,
        "points": points,
        "expected": {
            **regression,
            **modified_dmax(points, regression),
        },
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
