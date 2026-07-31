#!/usr/bin/env python3
"""Generate versioned diagnostics reference datasets using only Python stdlib."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REFERENCE_DIR = ROOT / "packages/diagnostics/reference"
OUTPUT_V1 = REFERENCE_DIR / "algorithm-reference-v1.json"
OUTPUT_V2 = REFERENCE_DIR / "algorithm-reference-v2.json"
EPSILON = 1e-12


def interpolate_x(x1: float, y1: float, x2: float, y2: float, target: float) -> float:
    return x1 + (target - y1) * (x2 - x1) / (y2 - y1)


def threshold(points: list[dict[str, Any]], target: float) -> dict[str, float]:
    for point in points:
        if point["lactate"] == target:
            return {
                "watts": point["watts"],
                "lactate": target,
                "heartRate": point["heartRate"],
            }
    for left, right in zip(points, points[1:]):
        if left["lactate"] < target < right["lactate"]:
            return {
                "watts": interpolate_x(left["watts"], left["lactate"], right["watts"], right["lactate"], target),
                "lactate": target,
                "heartRate": interpolate_x(
                    left["heartRate"], left["lactate"], right["heartRate"], right["lactate"], target
                ),
            }
    raise ValueError(f"target {target} is not bracketed")


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    size = len(vector)
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        pivot_value = augmented[column][column]
        if abs(pivot_value) < EPSILON:
            raise ValueError("singular matrix")
        augmented[column] = [value / pivot_value for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                value - factor * pivot_value
                for value, pivot_value in zip(augmented[row], augmented[column])
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


def dmax(points: list[dict[str, Any]], regression: dict[str, Any]) -> dict[str, Any]:
    start = points[0]
    end = points[-1]
    delta_watts = end["watts"] - start["watts"]
    delta_lactate = end["lactate"] - start["lactate"]
    scale = regression["wattScale"]
    _, a1, a2, a3 = regression["coefficients"]
    quadratic = 3.0 * a3
    linear = 2.0 * a2
    constant = a1 - delta_lactate * scale / delta_watts
    normalized_roots: list[float] = []

    if abs(quadratic) <= EPSILON:
        if abs(linear) > EPSILON:
            normalized_roots.append(-constant / linear)
    else:
        discriminant = linear * linear - 4.0 * quadratic * constant
        if discriminant >= -EPSILON:
            root = math.sqrt(max(0.0, discriminant))
            normalized_roots.extend((
                (-linear - root) / (2.0 * quadratic),
                (-linear + root) / (2.0 * quadratic),
            ))

    candidates = [start["watts"], end["watts"]]
    for normalized in normalized_roots:
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
        "watts": best[0],
        "lactate": best[1],
        "maximumDistance": best[2],
        "searchIntervalWatts": [start["watts"], end["watts"]],
    }


def write(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    threshold_points = [
        {"watts": 160.0, "lactate": 1.2, "heartRate": 130.0, "included": True},
        {"watts": 200.0, "lactate": 2.4, "heartRate": 145.0, "included": True},
        {"watts": 240.0, "lactate": 3.6, "heartRate": 160.0, "included": True},
        {"watts": 280.0, "lactate": 5.2, "heartRate": 174.0, "included": True},
    ]
    curve_points = [
        {"watts": watts, "lactate": 1.0 + ((watts - 200.0) / 100.0) ** 2, "included": True}
        for watts in (100.0, 150.0, 200.0, 250.0, 300.0)
    ]
    curve_regression = cubic_regression(curve_points)
    write(OUTPUT_V1, {
        "version": "1.0.0",
        "source": "independent-python-standard-library",
        "tolerance": 1e-9,
        "thresholdDataset": {
            "points": threshold_points,
            "fixed": {"lt1": threshold(threshold_points, 2.0), "lt2": threshold(threshold_points, 4.0)},
            "baselinePlusOne": {
                "baselineLactate": 1.2,
                "threshold": threshold(threshold_points, 2.2),
            },
        },
        "curveDataset": {
            "points": curve_points,
            "regression": curve_regression,
            "dmax": dmax(curve_points, curve_regression),
        },
    })

    realistic_points = [
        {"watts": 120.0, "lactate": 1.0, "heartRate": 118.0, "included": True},
        {"watts": 150.0, "lactate": 1.1, "heartRate": 126.0, "included": True},
        {"watts": 180.0, "lactate": 1.3, "heartRate": 136.0, "included": True},
        {"watts": 210.0, "lactate": 1.7, "heartRate": 148.0, "included": True},
        {"watts": 240.0, "lactate": 2.5, "heartRate": 160.0, "included": True},
        {"watts": 270.0, "lactate": 4.0, "heartRate": 172.0, "included": True},
        {"watts": 300.0, "lactate": 6.2, "heartRate": 181.0, "included": True},
    ]
    realistic_regression = cubic_regression(realistic_points)
    write(OUTPUT_V2, {
        "version": "2.0.0",
        "source": "independent-python-standard-library",
        "toleranceDigits": 9,
        "realisticStageDataset": {
            "points": realistic_points,
            "fixed": {"lt1": threshold(realistic_points, 2.0), "lt2": threshold(realistic_points, 4.0)},
            "baselinePlusOne": {
                "baselineLactate": 1.0,
                "threshold": threshold(realistic_points, 2.0),
            },
            "regression": realistic_regression,
            "dmax": dmax(realistic_points, realistic_regression),
        },
        "problemCases": [
            {
                "name": "multiple-lt1-crossings",
                "algorithm": "fixed",
                "points": [
                    {"watts": 180.0, "lactate": 1.0, "included": True},
                    {"watts": 200.0, "lactate": 3.0, "included": True},
                    {"watts": 220.0, "lactate": 1.5, "included": True},
                    {"watts": 240.0, "lactate": 3.0, "included": True},
                    {"watts": 260.0, "lactate": 5.0, "included": True},
                ],
                "expectedError": "Multiple intervals bracket 2 mmol/L",
            },
            {
                "name": "descending-lt2-crossing",
                "algorithm": "fixed",
                "points": [
                    {"watts": 180.0, "lactate": 2.0, "included": True},
                    {"watts": 220.0, "lactate": 5.0, "included": True},
                    {"watts": 260.0, "lactate": 3.0, "included": True},
                    {"watts": 300.0, "lactate": 2.5, "included": True},
                ],
                "expectedError": "The only interval crossing 4 mmol/L is descending",
            },
            {
                "name": "duplicate-watt-regression",
                "algorithm": "regression",
                "points": [
                    {"watts": 160.0, "lactate": 1.0, "included": True},
                    {"watts": 200.0, "lactate": 1.4, "included": True},
                    {"watts": 200.0, "lactate": 1.8, "included": True},
                    {"watts": 240.0, "lactate": 2.6, "included": True},
                    {"watts": 280.0, "lactate": 4.5, "included": True},
                ],
                "expectedError": "distinct watt values",
            },
        ],
    })


if __name__ == "__main__":
    main()
