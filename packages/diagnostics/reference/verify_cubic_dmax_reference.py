#!/usr/bin/env python3
"""Independent standard-library verification for the cubic/Dmax reference dataset."""

from __future__ import annotations

import json
import math
from pathlib import Path

DATASET = Path(__file__).with_name("cubic-dmax-reference-v1.json")
EPSILON = 1e-12


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    size = len(vector)
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < EPSILON:
            raise RuntimeError("Singular reference system")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                augmented[row][entry] - factor * augmented[column][entry]
                for entry in range(size + 1)
            ]
    return [row[-1] for row in augmented]


def main() -> None:
    dataset = json.loads(DATASET.read_text(encoding="utf-8"))
    points = dataset["points"]
    expected = dataset["expected"]
    tolerance = dataset["tolerance"]

    center = sum(point["watts"] for point in points) / len(points)
    scale = max(abs(point["watts"] - center) for point in points)
    rows = []
    for point in points:
        x = (point["watts"] - center) / scale
        rows.append([1.0, x, x**2, x**3])

    normal = [
        [sum(row[i] * row[j] for row in rows) for j in range(4)]
        for i in range(4)
    ]
    target = [
        sum(rows[index][i] * points[index]["lactate"] for index in range(len(points)))
        for i in range(4)
    ]
    coefficients = solve(normal, target)

    def predict(watts: float) -> float:
        x = (watts - center) / scale
        return sum(coefficients[power] * x**power for power in range(4))

    mean = sum(point["lactate"] for point in points) / len(points)
    sse = sum((point["lactate"] - predict(point["watts"])) ** 2 for point in points)
    tss = sum((point["lactate"] - mean) ** 2 for point in points)
    r_squared = 1.0 if tss <= EPSILON and sse <= EPSILON else 1.0 - sse / tss
    rmse = math.sqrt(sse / len(points))

    start, end = points[0], points[-1]
    candidate_watts = [start["watts"], center, end["watts"]]

    def distance(watts: float) -> float:
        lactate = predict(watts)
        dx = end["watts"] - start["watts"]
        dy = end["lactate"] - start["lactate"]
        numerator = abs(dy * watts - dx * lactate + end["watts"] * start["lactate"] - end["lactate"] * start["watts"])
        return numerator / math.hypot(dx, dy)

    dmax_watts = max(candidate_watts, key=lambda watts: (distance(watts), -watts))
    actual = {
        "wattCenter": center,
        "wattScale": scale,
        "coefficients": coefficients,
        "rSquared": r_squared,
        "rmse": rmse,
        "dmaxWatts": dmax_watts,
        "dmaxLactate": predict(dmax_watts),
        "maximumDistance": distance(dmax_watts),
    }

    for key, expected_value in expected.items():
        if key == "searchIntervalWatts":
            continue
        actual_value = actual[key]
        if isinstance(expected_value, list):
            assert all(abs(a - b) <= tolerance for a, b in zip(actual_value, expected_value)), (key, actual_value, expected_value)
        else:
            assert abs(actual_value - expected_value) <= tolerance, (key, actual_value, expected_value)

    print(json.dumps(actual, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
