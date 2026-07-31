#!/usr/bin/env python3
"""Generate the versioned diagnostics reference dataset using only Python stdlib."""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages/diagnostics/reference/algorithm-reference-v1.json"


def interpolate_x(x1: float, y1: float, x2: float, y2: float, target: float) -> float:
    return x1 + (target - y1) * (x2 - x1) / (y2 - y1)


def threshold(points: list[dict[str, float]], target: float) -> dict[str, float]:
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
        if abs(pivot_value) < 1e-12:
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


def cubic_regression(points: list[dict[str, float]]) -> dict[str, object]:
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
    payload = {
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
            "regression": cubic_regression(curve_points),
            "dmax": {
                "watts": 200.0,
                "lactate": 1.0,
                "maximumDistance": 1.0,
                "searchIntervalWatts": [100.0, 300.0],
            },
        },
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
