#!/usr/bin/env python3
"""Independent standard-library verification for modified-dmax-v1 fixtures."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

EPSILON = 1e-12
RISE_THRESHOLD = 0.4


def solve_linear_system(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]

    for column in range(size):
        pivot_row = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot_row][column]) < EPSILON:
            raise ValueError("singular cubic regression design matrix")
        augmented[column], augmented[pivot_row] = augmented[pivot_row], augmented[column]
        pivot = augmented[column][column]
        augmented[column] = [value / pivot for value in augmented[column]]

        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            for entry in range(column, size + 1):
                augmented[row][entry] -= factor * augmented[column][entry]

    return [row[size] for row in augmented]


def fit_cubic(points: list[dict[str, float]]) -> tuple[list[float], float, float]:
    watts = [float(point["watts"]) for point in points]
    center = sum(watts) / len(watts)
    scale = max(abs(value - center) for value in watts)
    matrix = [[0.0] * 4 for _ in range(4)]
    vector = [0.0] * 4

    for point in points:
        x = (float(point["watts"]) - center) / scale
        powers = [1.0, x, x * x, x * x * x]
        lactate = float(point["lactate"])
        for row in range(4):
            vector[row] += powers[row] * lactate
            for column in range(4):
                matrix[row][column] += powers[row] * powers[column]

    return solve_linear_system(matrix, vector), center, scale


def predict(coefficients: list[float], center: float, scale: float, watts: float) -> float:
    x = (watts - center) / scale
    a0, a1, a2, a3 = coefficients
    return a0 + a1 * x + a2 * x * x + a3 * x * x * x


def verify(path: Path) -> None:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    points = [
        point
        for point in fixture["points"]
        if point.get("included", False) and point.get("lactateQualifier", "EXACT") == "EXACT"
    ]
    points.sort(key=lambda point: float(point["watts"]))

    start = None
    for previous, current in zip(points, points[1:]):
        if float(current["lactate"]) - float(previous["lactate"]) > RISE_THRESHOLD + EPSILON:
            start = previous
            break
    if start is None:
        raise ValueError("no qualifying lactate rise")

    end = points[-1]
    coefficients, center, scale = fit_cubic(points)
    delta_watts = float(end["watts"]) - float(start["watts"])
    delta_lactate = float(end["lactate"]) - float(start["lactate"])
    a1, a2, a3 = coefficients[1:]
    quadratic = 3.0 * a3
    linear = 2.0 * a2
    constant = a1 - (delta_lactate * scale) / delta_watts
    discriminant = linear * linear - 4.0 * quadratic * constant
    roots = [
        (-linear - math.sqrt(max(0.0, discriminant))) / (2.0 * quadratic),
        (-linear + math.sqrt(max(0.0, discriminant))) / (2.0 * quadratic),
    ]
    candidates = [float(start["watts"]), float(end["watts"])]
    candidates.extend(
        center + root * scale
        for root in roots
        if float(start["watts"]) < center + root * scale < float(end["watts"])
    )

    denominator = math.hypot(delta_watts, delta_lactate)
    evaluated = []
    for watts in candidates:
        lactate = predict(coefficients, center, scale, watts)
        distance = abs(
            delta_lactate * watts
            - delta_watts * lactate
            + float(end["watts"]) * float(start["lactate"])
            - float(end["lactate"]) * float(start["watts"])
        ) / denominator
        evaluated.append((distance, -watts, watts, lactate))
    _, _, threshold_watts, threshold_lactate = max(evaluated)
    maximum_distance = max(evaluated)[0]

    expected = fixture["expected"]
    tolerance = float(expected["absoluteTolerance"])
    actual = {
        "thresholdWatts": threshold_watts,
        "thresholdLactate": threshold_lactate,
        "maximumDistance": maximum_distance,
    }
    for key, value in actual.items():
        if not math.isclose(value, float(expected[key]), rel_tol=0.0, abs_tol=tolerance):
            raise AssertionError(f"{key}: expected {expected[key]!r}, got {value!r}")

    print(json.dumps(actual, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    fixture_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("clinical-plausible.json")
    verify(fixture_path)
